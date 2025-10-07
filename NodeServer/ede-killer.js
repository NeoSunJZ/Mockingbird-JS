const playwright = require("playwright");
const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const parser = require("@babel/parser");
const injectedFunction = require("./tools/injected");
const { executeCommands } = require("./tools/command");
const {
  saveToFile,
  getExpression,
  splitVariableDeclarations,
  wrapExpressionsAtPositions,
  parseStack,
} = require("./tools/tools");

const BROWSER = (process.env.BROWSER || "chromium").toLowerCase();
if (!["chromium", "firefox", "webkit"].includes(BROWSER)) {
  console.warn(`Unsupported BROWSER="${BROWSER}", fallback to "chromium".`);
}

let astCache = new Map(); // used to cache the parsed AST, avoid duplicate parsing
let scriptCache = new Map(); // used to cache the processed script content
let wrapLists = {};
let targetAPI = null;
let targetRes = null;
let baseSavePath;
let commands;
let index;
let rawLogBuffer = []; // store the original logs: stack, target, prop, from
let analysisLogBuffer = []; // store the analyzed logs: expression, statement
let logSequence = 0; // global log sequence, ensure order

// auxiliary function: used to clear Service Worker cache
async function clearServiceWorkerCaches(page) {
  console.log("Clearing ServiceWorker and cache...");

  await page.evaluate(async () => {
    // 1. clear cache
    if ("caches" in window) {
      const keys = await window.caches.keys();
      await Promise.all(keys.map((key) => window.caches.delete(key)));
      console.log(`Cleared ${keys.length} cache entries`);
    }

    // 2. unregister all ServiceWorker
    if (navigator.serviceWorker) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      if (registrations.length > 0) {
        await Promise.all(registrations.map((r) => r.unregister()));
        console.log(`Unregistered ${registrations.length} ServiceWorker`);
      } else {
        console.log("No active ServiceWorker found");
      }
    }

    console.log("ServiceWorker and cache cleared");

    return true; // return value to confirm execution completed
  });
}

function waitForNonEmpty(timeout = 10000, interval = 200) {
  const start = Date.now();
  return new Promise((resolve) => {
    (function check() {
      if (Object.keys(wrapLists).length > 0) return resolve(true);
      if (Date.now() - start >= timeout) return resolve(false);
      setTimeout(check, interval);
    })();
  });
}

// according to the data in wrapLists, modify the local script
async function changeLocalScript(index) {
  for (const [encodedUrl, entries] of Object.entries(wrapLists)) {
    const url = decodeURIComponent(encodedUrl);
    const fileName = path.basename(new URL(url).pathname);
    const localDir = path.join(baseSavePath, "src/");
    const localFilePath = path.join(localDir, fileName);
    let scriptSource;
    try {
      scriptSource = await fsp.readFile(localFilePath, "utf8");
    } catch (err) {
      console.error(`Failed to read local script: ${localFilePath}`, err);
      continue; // skip this file
    }
    const modifiedBody = wrapExpressionsAtPositions(
      scriptSource,
      entries,
      index
    );
    await saveToFile(modifiedBody, fileName, "new", localDir);
  }
  wrapLists = {};
}

// batch save cycle logs
async function saveCycleLogs(cycleIndex) {
  if (rawLogBuffer.length === 0 && analysisLogBuffer.length === 0) {
    return; // no logs to save
  }

  // merge all logs and sort by sequence
  const allLogs = [...rawLogBuffer, ...analysisLogBuffer].sort(
    (a, b) => a.sequence - b.sequence
  );

  let logContent = `\n=== Cycle ${cycleIndex} Start ===\n`;

  // process each log by sequence
  for (const logEntry of allLogs) {
    const { sequence, type, data } = logEntry;

    if (type === "raw") {
      logContent += `\n[${sequence}] RAW: prop=${
        data.prop
      }, from=${JSON.stringify(data.from)}\n`;
    } else if (type === "expression") {
      logContent += `[${sequence}] ${data.type} EXPRESSION: ${data.code}\n`;
    } else if (type === "statement") {
      logContent += `[${sequence}] ${data.type} STATEMENT: ${data.code}\n`;
    }
  }

  logContent += `\n=== Cycle ${cycleIndex} End ===\n\n`;

  // save to file
  const Dir = path.join(baseSavePath, "console/");
  await saveToFile(logContent, "usevar.log", "add", Dir);

  // clear cache, prepare for next round
  rawLogBuffer = [];
  analysisLogBuffer = [];

  console.log(`📝 Cycle ${cycleIndex}: Saved ${allLogs.length} logs to file`);
}

// intercept js scripts
function interceptScripts(client) {
  client.on("Fetch.requestPaused", async (event) => {
    const {
      requestId,
      request,
      responseStatusCode,
      responseHeaders,
      responseErrorReason,
    } = event;
    // console.log("interceptScripts: " + request.url);
    const url = request.url;
    const fileName = path.basename(new URL(url).pathname);

    // if the request fails or is not a js file, do nothing
    if (responseErrorReason || !fileName.endsWith(".js")) {
      await client.send("Fetch.continueRequest", { requestId });
      return;
    }

    // local save path
    let text;
    const localDir = path.join(baseSavePath, "src");
    const localPath = path.join(localDir, fileName);
    const fileExists = await fsp
      .access(localPath)
      .then(() => true)
      .catch(() => false);

    if (!fileExists) {
      // local does not exist: pull the original response body
      try {
        // for HTTP status codes without response headers or response bodies, continue the request directly
        if (
          !responseHeaders ||
          responseStatusCode === 204 ||
          (responseStatusCode >= 300 && responseStatusCode <= 399)
        ) {
          await client.send("Fetch.continueRequest", { requestId });
          return;
        }

        const { body, base64Encoded } = await client.send(
          "Fetch.getResponseBody",
          { requestId }
        );
        // decode to string
        text = base64Encoded
          ? Buffer.from(body, "base64").toString("utf8")
          : body;
        // use tool function to process
        text = splitVariableDeclarations(text);
        await saveToFile(text, fileName, "new", localDir);
      } catch (err) {
        console.error("Failed to get/process script:", err);
        try {
          await client.send("Fetch.continueRequest", { requestId });
        } catch (continueErr) {
          console.error("Failed to continue request:", continueErr);
        }
        return;
      }
    } else {
      // local exists: read from disk
      try {
        text = await fsp.readFile(localPath, "utf8");
      } catch (err) {
        console.error("Failed to read local script:", err);
        // when error, continue the original request
        try {
          await client.send("Fetch.continueRequest", { requestId });
        } catch (continueErr) {
          console.error("Failed to continue request:", continueErr);
        }
        return;
      }
    }

    try {
      // find the original Content-Type header
      const originalContentTypeHeader = (responseHeaders ?? []).find(
        (h) => h.name.toLowerCase() === "content-type"
      );

      // remove content-length, and keep the original Content-Type
      let headers = (responseHeaders ?? []).filter(
        (h) => h.name.toLowerCase() !== "content-length"
      );

      // if the original response does not have Content-Type, add a default one
      if (!originalContentTypeHeader) {
        headers.push({
          name: "Content-Type",
          value: "application/javascript",
        });
      }

      // Fulfill intercept, return with Base64 body
      const base64Body = Buffer.from(text, "utf8").toString("base64");
      await client.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: responseStatusCode || 200, // ensure there is a status code
        responseHeaders: headers,
        body: base64Body,
      });
    } catch (err) {
      console.error("Failed to respond request:", err);
      // if fulfillRequest fails, try to continue the original request
      try {
        await client.send("Fetch.continueRequest", { requestId });
      } catch (continueErr) {
        console.error("Failed to continue original request:", continueErr);
      }
    }
  });
}

const connectToBrowser = async () => {
  const browser = await playwright[BROWSER].launch({
    // only Chromium has executable path requirement; Firefox/WebKit default
    ...(BROWSER === "chromium" && {
      executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      args: [
        "--remote-debugging-port=9222",
        "--remote-debugging-address=0.0.0.0",
      ],
      devtools: true,
    }),
    headless: false,
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  let client = null;
  let Dir = path.join(baseSavePath, "console/");

  client = await context.newCDPSession(page);
  await client.send("Debugger.enable");
  await client.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*", resourceType: "Script", requestStage: "Response" },
      { urlPattern: "*", resourceType: "Document", requestStage: "Response" },
    ],
  });

  // record response
  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes(targetAPI) && !targetRes) {
      const jsonData = await response.json();
      targetRes = jsonData;
      // console.log("targetRes", targetRes);
    }
  });

  // execute injection before new page loads
  await page.addInitScript(injectedFunction, targetAPI);

  // map function to browser context
  await page.exposeFunction("reportLog", (log) => {
    let { stack, target, prop, from, logIndex } = log;
    console.log(from);
    let errorStack = parseStack(stack);
    let currentSeq = ++logSequence;
    if (from) {
      rawLogBuffer.push({
        sequence: currentSeq,
        timestamp: Date.now(),
        cycleIndex: index,
        type: "raw",
        data: {
          prop: prop,
          from: from,
          target: target,
        },
      });
    }

    if (errorStack && from) {
      // find the expression corresponding to the first call stack and analyze it
      let stackIndex = 1;
      let stack = errorStack[stackIndex];
      while (!stack.fileURL.includes("http") || !stack.fileURL.includes(".js"))
        stack = errorStack[++stackIndex];
      if (stack) {
        let { fileURL, line, column } = stack;
        const fileName = path.basename(new URL(fileURL).pathname);
        const localDir = path.join(baseSavePath, "src");
        const localFilePath = path.join(localDir, fileName);
        let scriptSource = scriptCache.get(localFilePath);
        let ast = astCache.get(localFilePath);
        if (!scriptSource) {
          scriptSource = fs.readFileSync(localFilePath, "utf8");
          scriptCache.set(localFilePath, scriptSource);
          ast = parser.parse(scriptSource, {
            sourceType: "unambiguous",
            plugins: ["jsx"],
            errorRecovery: true,
          });
          astCache.set(localFilePath, ast);
        }
        const { expression, statement, update } = getExpression(
          ast,
          scriptSource,
          {
            lineNumber: line - 1,
            columnNumber: column,
          }
        );
        if (expression?.code) {
          analysisLogBuffer.push({
            sequence: currentSeq,
            timestamp: Date.now(),
            cycleIndex: index,
            type: "expression",
            data: {
              code: expression.code,
              type: expression.type,
              fileURL: fileURL,
              line: line,
              column: column,
            },
          });
        }

        if (statement?.code) {
          analysisLogBuffer.push({
            sequence: currentSeq,
            timestamp: Date.now(),
            cycleIndex: index,
            type: "statement",
            data: {
              code: statement.code,
              type: statement.type,
              fileURL: fileURL,
              line: line,
              column: column,
            },
          });
        }

        if (logIndex === index) {
          if (expression?.left) {
            const encodedURL = encodeURIComponent(fileURL);
            const entry = {
              start: expression.position.start,
              end: expression.position.end,
              code: expression.code,
            };
            (wrapLists[encodedURL] ??= new Set()).add(entry);
          }

          if (statement?.type === "ReturnStatement") {
            const encodedURL = encodeURIComponent(fileURL);
            const entry = {
              start: statement.position.start,
              end: statement.position.end,
              code: statement.code,
            };
            (wrapLists[encodedURL] ??= new Set()).add(entry);
          }
        }
      }
    }
  });

  index = 0;
  let hasNewWraps = false;
  interceptScripts(client);
  do {
    logSequence = 0;
    astCache.clear();
    scriptCache.clear();
    await client.send("Network.clearBrowserCache");
    await client.send("Network.clearBrowserCookies");
    await client.send("Network.setCacheDisabled", { cacheDisabled: true });
    // if there is a webpage using service_worker, it needs to be cleared, otherwise the source file cannot be replaced
    await clearServiceWorkerCaches(page);

    await page.addInitScript({
      content: `window.index = ${index};`,
    });
    for (let cmd of commands) {
      if (cmd.startsWith("LOAD")) {
        await changeLocalScript(index);
      }
      await executeCommands(page, [cmd]);
    }
    hasNewWraps = await waitForNonEmpty(10000, 200);

    // save all logs of the current cycle
    await saveCycleLogs(index);

    index++;
  } while (hasNewWraps);

  if (rawLogBuffer.length > 0 || analysisLogBuffer.length > 0) {
    await saveCycleLogs(index);
  }

  browser.on("disconnected", () => {
    console.log("The browser has disconnected");
    server.close();
  });
};

/**
 * the program start
 */
const [, , config] = process.argv;
if (!config) {
  console.error("Usage: node edekiller.js <config>");
  process.exit(1);
} else {
  let configPath = path.join(__dirname, "configs/" + config + ".config");
  if (!fs.existsSync(configPath)) {
    console.error("Config file not found:", configPath);
    process.exit(1);
  }
  commands = fs.readFileSync(configPath, "utf8");
  commands = commands
    .split("\r\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      if (line.startsWith("#")) return false;
      if (line.startsWith("TARGET")) {
        targetAPI = line.split(" ")[1];
        return false;
      }
      return true;
    });

  baseSavePath = path.join(
    __dirname,
    "logs/" + encodeURIComponent(config) + "/"
  );
}

const hostname = "0.0.0.0";
const port = 7521;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Server is running\n");
});

server
  .listen(port, hostname, async () => {
    console.log(`Server running at http://${hostname}:${port}/`);
    await connectToBrowser();
  })
  .on("error", (err) => {
    console.error(err);
  });
