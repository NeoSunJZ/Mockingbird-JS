// const { chromium, firefox, webkit } = require("playwright");
// not tested
async function executeCommands(page, commands, options = {}) {
  const context = page.context();
  for (let commandIndex = 0; commandIndex < commands.length; commandIndex++) {
    const raw = commands[commandIndex];
    const parts = (raw.trim().match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g) || []).map(token => {
      if (token.startsWith('"') && token.endsWith('"')) return token.slice(1,-1).replace(/\\(["\\])/g, '$1');
      if (token.startsWith("'") && token.endsWith("'")) return token.slice(1,-1);
      return token;
    });
    const rest = raw.trim().replace(/^\S+\s*/, "");
    const cmd = parts[0].toUpperCase();
    let followingWait;
    const next = commands[commandIndex + 1]?.trim();
    if (["CLICK", "DOUBLE_CLICK", "PRESS", "EVALUATE", "LOAD", "INPUT"].includes(cmd) && next) {
      const wait = /^(WAIT_FOR_RESPONSE|WAIT_FOR_EVENT|WAIT_FOR_DOWNLOAD|WAIT_NAVIGATION)(?:\s+(.*))?$/i.exec(next);
      if (wait) {
        if (wait[1].toUpperCase() === "WAIT_FOR_RESPONSE") followingWait = page.waitForResponse(r => r.url().includes(wait[2]));
        else if (wait[1].toUpperCase() === "WAIT_NAVIGATION") followingWait = page.waitForNavigation({ waitUntil: "load" });
        else followingWait = page.waitForEvent(wait[1].toUpperCase() === "WAIT_FOR_DOWNLOAD" ? "download" : wait[2]);
        followingWait.catch(() => {});
      }
    }
    try {
      switch (cmd) {
        case "LOAD": {
          const url = parts[1];
          //   console.log(`> LOAD ${url}`);
          // await page.waitForSelector('#app .ready-indicator');
          await page.goto(url, { waitUntil: "load" });
          break;
        }
        case "BACK": {
          //   console.log("> BACK");
          await page.goBack({ waitUntil: "load" });
          break;
        }
        case "FORWARD": {
          //   console.log("> FORWARD");
          await page.goForward({ waitUntil: "load" });
          break;
        }
        case "RELOAD": {
          //   console.log("> RELOAD");
          await page.reload({ waitUntil: "load" });
          break;
        }
        case "WAIT_NAVIGATION": {
          //   console.log("> WAIT_NAVIGATION");
          await page.waitForNavigation({ waitUntil: "load" });
          break;
        }

        case "WAIT_LOCATE": {
          const xpath = parts.length === 2 ? parts[1] : rest;
          //   console.log(`> WAIT_LOCATE ${xpath}`);
          await page.waitForSelector(`xpath=${xpath}`);
          break;
        }
        case "WAIT_FOR_FUNCTION": {
          const fn = rest;
          //   console.log(`> WAIT_FOR_FUNCTION ${fn}`);
          await page.waitForFunction(fn);
          break;
        }
        case "WAIT_FOR_RESPONSE": {
          const pattern = parts[1];
          //   console.log(`> WAIT_FOR_RESPONSE ${pattern}`);
          await page.waitForResponse((resp) => resp.url().includes(pattern));
          break;
        }
        case "WAIT_FOR_EVENT": {
          const event = parts[1];
          //   console.log(`> WAIT_FOR_EVENT ${event}`);
          await page.waitForEvent(event);
          break;
        }
        case "INPUT": {
          const xpath = parts[1];
          const value = parts.slice(2).join(" ");
          //   console.log(`> INPUT ${xpath} → ${value}`);
          await page.fill(`xpath=${xpath}`, value);
          break;
        }
        case "CLICK": {
          const xpath = parts.length === 2 ? parts[1] : rest;
          //   console.log(`> CLICK ${xpath}`);
          await page.click(`xpath=${xpath}`);
          break;
        }
        case "DOUBLE_CLICK": {
          const xpath = parts.length === 2 ? parts[1] : rest;
          //   console.log(`> DOUBLE_CLICK ${xpath}`);
          await page.dblclick(`xpath=${xpath}`);
          break;
        }
        case "RIGHT_CLICK": {
          const xpath = parts.length === 2 ? parts[1] : rest;
          //   console.log(`> RIGHT_CLICK ${xpath}`);
          await page.click(`xpath=${xpath}`, { button: "right" });
          break;
        }
        case "HOVER": {
          const xpath = parts.length === 2 ? parts[1] : rest;
          //   console.log(`> HOVER ${xpath}`);
          await page.hover(`xpath=${xpath}`);
          break;
        }
        case "SELECT": {
          const xpath = parts[1];
          const value = parts.slice(2).join(" ");
          //   console.log(`> SELECT ${xpath} → ${value}`);
          await page.selectOption(`xpath=${xpath}`, value);
          break;
        }
        case "CHECK": {
          const xpath = parts[1];
          //   console.log(`> CHECK ${xpath}`);
          await page.check(`xpath=${xpath}`);
          break;
        }
        case "UNCHECK": {
          const xpath = parts[1];
          //   console.log(`> UNCHECK ${xpath}`);
          await page.uncheck(`xpath=${xpath}`);
          break;
        }
        case "DRAG_AND_DROP": {
          const src = parts[1],
            dest = parts[2];
          //   console.log(`> DRAG_AND_DROP ${src} → ${dest}`);
          await page.dragAndDrop(`xpath=${src}`, `xpath=${dest}`);
          break;
        }
        case "FOCUS": {
          const xpath = parts[1];
          //   console.log(`> FOCUS ${xpath}`);
          await page.focus(`xpath=${xpath}`);
          break;
        }
        case "TYPE": {
          const text = parts.slice(1).join(" ");
          //   console.log(`> TYPE "${text}"`);
          await page.keyboard.type(text);
          break;
        }
        case "PRESS": {
          const key = parts[1];
          //   console.log(`> PRESS ${key}`);
          await page.keyboard.press(key);
          break;
        }
        case "MOUSE_MOVE": {
          const x = Number(parts[1]),
            y = Number(parts[2]);
          //   console.log(`> MOUSE_MOVE ${x},${y}`);
          await page.mouse.move(x, y);
          break;
        }
        case "MOUSE_DOWN": {
          //   console.log("> MOUSE_DOWN");
          await page.mouse.down();
          break;
        }
        case "MOUSE_UP": {
          //   console.log("> MOUSE_UP");
          await page.mouse.up();
          break;
        }

        case "SCROLL": {
          const where = parts[1].toUpperCase();
          if (where === "END") {
            // console.log("> SCROLL END");
            await page.keyboard.press("End");
          } else if (where === "PAGE") {
            // console.log("> SCROLL PAGE");
            await page.keyboard.press("PageDown");
          } else throw new Error("SCROLL requires END or PAGE");
          break;
        }
        case "SLEEP": {
          const secs = Number(parts[1]);
          if (!Number.isFinite(secs) || secs < 0) throw new Error("SLEEP requires nonnegative seconds");
          //   console.log(`> SLEEP ${secs}s`);
          await page.waitForTimeout(secs * 1000);
          break;
        }

        case "EVALUATE": {
          const js = rest;
          //   console.log(`> EVALUATE ${js}`);
          await page.evaluate(js);
          break;
        }
        case "ADD_SCRIPT": {
          const src = parts[1];
          //   console.log(`> ADD_SCRIPT ${src}`);
          await page.addScriptTag({ path: src, url: undefined });
          break;
        }
        case "ADD_STYLE": {
          const css = rest;
          //   console.log(`> ADD_STYLE ${css}`);
          // 如果是文件： { path: css }；如果是代码： { content: css }
          await page.addStyleTag({ content: css });
          break;
        }

        case "COOKIE": {
          const equals = rest.indexOf("=");
          if (equals < 1) throw new Error("COOKIE requires name=value");
          const nextLoad = commands.slice(commandIndex + 1).find(line => /^LOAD\s+/i.test(line));
          const url = /^https?:/.test(page.url()) ? page.url() : nextLoad?.replace(/^LOAD\s+/i, "");
          if (!url) throw new Error("COOKIE needs an HTTP page or a following LOAD");
          await context.addCookies([{name: rest.slice(0, equals), value: rest.slice(equals + 1).replace(/^"|"$/g, ""), url}]);
          break;
        }
        case "CLEAR_COOKIES": {
          //   console.log("> CLEAR_COOKIES");
          await context.clearCookies();
          break;
        }
        case "GET_COOKIES": {
          //   console.log("> GET_COOKIES");
          options.onResult?.({command:cmd,value:await context.cookies()});
          break;
        }
        case "CLEAR_LOCALSTORAGE": {
          //   console.log("> CLEAR_LOCALSTORAGE");
          await page.evaluate(() => localStorage.clear());
          break;
        }
        case "GET_LOCALSTORAGE": {
          options.onResult?.({command:cmd,value:await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))});
          break;
        }
        case "CLEAR_SESSIONSTORAGE": {
          //   console.log("> CLEAR_SESSIONSTORAGE");
          await page.evaluate(() => sessionStorage.clear());
          break;
        }
        case "GET_SESSIONSTORAGE": {
          options.onResult?.({command:cmd,value:await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)))});
          //   console.log(
          //     await page.evaluate(() => JSON.stringify(sessionStorage))
          //   );
          break;
        }

        case "SET_VIEWPORT": {
          const width = Number(parts[1]),
            height = Number(parts[2]);
          //   console.log(`> SET_VIEWPORT ${width}x${height}`);
          await page.setViewportSize({ width, height });
          break;
        }
        case "SET_USER_AGENT": {
          const ua = parts.slice(1).join(" ");
          //   console.log(`> SET_USER_AGENT ${ua}`);
          const session = await context.newCDPSession(page);
          await session.send("Emulation.setUserAgentOverride", { userAgent: ua });
          break;
        }
        case "EMULATE_NETWORK": {
          const mode = parts[1].toLowerCase();
          //   console.log(`> EMULATE_NETWORK ${mode}`);
          await context.setOffline(mode === "offline");
          break;
        }
        case "EMULATE_GEOLOCATION": {
          const lat = parseFloat(parts[1]),
            lon = parseFloat(parts[2]);
          //   console.log(`> EMULATE_GEOLOCATION ${lat},${lon}`);
          await context.grantPermissions(["geolocation"]);
          await context.setGeolocation({ latitude: lat, longitude: lon });
          break;
        }
        case "GRANT_PERMISSION": {
          const perm = parts[1];
          //   console.log(`> GRANT_PERMISSION ${perm}`);
          await context.grantPermissions([perm]);
          break;
        }
        case "SET_EXTRA_HTTP_HEADERS": {
          const hdrs = JSON.parse(rest);
          //   console.log(`> SET_EXTRA_HTTP_HEADERS ${JSON.stringify(hdrs)}`);
          await context.setExtraHTTPHeaders(hdrs);
          break;
        }

        case "ROUTE": {
          const pattern = parts[1],
            action = parts.slice(2).join(" ");
          //   console.log(`> ROUTE ${pattern}`);
          await page.route(pattern, (route) => {
            if (action.toLowerCase() === "continue") return route.continue();
            else if (action.toLowerCase() === "abort") return route.abort();
            else return route.fulfill(JSON.parse(action));
          });
          break;
        }
        case "HAR_START": {
          throw new Error("HAR_START requires context creation options and is not supported by this command runner");
        }
        case "HAR_STOP": {
          throw new Error("HAR_STOP requires context creation options and is not supported by this command runner");
        }
        case "VIDEO_START": {
          throw new Error("VIDEO_START requires context creation options and is not supported by this command runner");
        }
        case "VIDEO_STOP": {
          throw new Error("VIDEO_STOP requires context creation options and is not supported by this command runner");
        }
        case "TRACING_START": {
          //   console.log("> TRACING_START");
          await context.tracing.start({ screenshots: true, snapshots: true });
          break;
        }
        case "TRACING_STOP": {
          const tpath = parts[1];
          //   console.log(`> TRACING_STOP ${tpath}`);
          await context.tracing.stop({ path: tpath });
          break;
        }

        case "SCREENSHOT_PAGE": {
          const ppath = parts[1];
          //   console.log(`> SCREENSHOT_PAGE ${ppath}`);
          await page.screenshot({ path: ppath, fullPage: true });
          break;
        }
        case "SCREENSHOT_ELEMENT": {
          const xpath = parts[1],
            elpath = parts[2];
          //   console.log(`> SCREENSHOT_ELEMENT ${xpath} → ${elpath}`);
          await page.locator(`xpath=${xpath}`).screenshot({ path: elpath });
          break;
        }
        case "PDF": {
          const pdfpath = parts[1];
          //   console.log(`> PDF ${pdfpath}`);
          await page.pdf({ path: pdfpath, format: "A4" });
          break;
        }

        case "NEW_PAGE": {
          //   console.log("> NEW_PAGE");
          page = await context.newPage();
          await options.onPage?.(page);
          break;
        }
        case "CLOSE_PAGE": {
          const idx = parts[1] === undefined ? context.pages().indexOf(page) : Number(parts[1]);
          //   console.log(`> CLOSE_PAGE ${idx}`);
          const pages = context.pages();
          if (!pages[idx]) throw new Error(`No page at index ${idx}`);
          await pages[idx].close();
          if (page.isClosed()) page = context.pages().at(-1);
          break;
        }
        case "NEW_CONTEXT": {
          throw new Error("NEW_CONTEXT requires context creation options and is not supported by this command runner");
        }
        case "SWITCH_CONTEXT": {
          throw new Error("SWITCH_CONTEXT requires context creation options and is not supported by this command runner");
        }

        case "SET_INPUT_FILES": {
          const xpath = parts[1];
          const files = parts.slice(2);
          //   console.log(`> SET_INPUT_FILES ${xpath} → ${files}`);
          await page.setInputFiles(`xpath=${xpath}`, files);
          break;
        }
        case "WAIT_FOR_DOWNLOAD": {
          //   console.log("> WAIT_FOR_DOWNLOAD");
          const [download] = await Promise.all([page.waitForEvent("download")]);
          //   console.log("Downloaded:", await download.path());
          break;
        }

        default:
          throw new Error(`Unknown command: ${cmd}`);
      }
      if (followingWait) { await followingWait; commandIndex++; }
    } catch (e) {
      throw new Error(`Command ${commandIndex + 1} (${raw}) failed: ${e.message}`, { cause: e });
    }
  }
  return page;
}

module.exports = { executeCommands };
