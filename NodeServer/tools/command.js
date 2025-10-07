// const { chromium, firefox, webkit } = require("playwright");
// not tested
async function executeCommands(page, commands) {
  const context = page.context();
  for (const raw of commands) {
    const parts = raw.trim().split(" ");
    const cmd = parts[0].toUpperCase();
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
          const xpath = parts.slice(1).join(" ");
          //   console.log(`> WAIT_LOCATE ${xpath}`);
          await page.waitForSelector(`xpath=${xpath}`);
          break;
        }
        case "WAIT_FOR_FUNCTION": {
          const fn = parts.slice(1).join(" ");
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
          const xpath = parts.slice(1).join(" ");
          //   console.log(`> CLICK ${xpath}`);
          await page.click(`xpath=${xpath}`);
          break;
        }
        case "DOUBLE_CLICK": {
          const xpath = parts.slice(1).join(" ");
          //   console.log(`> DOUBLE_CLICK ${xpath}`);
          await page.dblclick(`xpath=${xpath}`);
          break;
        }
        case "RIGHT_CLICK": {
          const xpath = parts.slice(1).join(" ");
          //   console.log(`> RIGHT_CLICK ${xpath}`);
          await page.click(`xpath=${xpath}`, { button: "right" });
          break;
        }
        case "HOVER": {
          const xpath = parts.slice(1).join(" ");
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
          }
          break;
        }
        case "SLEEP": {
          const secs = Number(parts[1]) || 0;
          //   console.log(`> SLEEP ${secs}s`);
          await page.waitForTimeout(secs * 1000);
          break;
        }

        case "EVALUATE": {
          const js = parts.slice(1).join(" ");
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
          const css = parts.slice(1).join(" ");
          //   console.log(`> ADD_STYLE ${css}`);
          // 如果是文件： { path: css }；如果是代码： { content: css }
          await page.addStyleTag({ content: css });
          break;
        }

        case "COOKIE": {
          const cookieStr = parts.slice(1).join(" ");

          const [name, value] = cookieStr.split("=");
          const cookieValue = value.replace(/^"|"$/g, "");
          const cookie = {
            name: name,
            value: cookieValue,
            domain: ".ruoyi.vip",
            path: "/",
          };

          await context.addCookies([cookie]);
          break;
        }
        case "CLEAR_COOKIES": {
          //   console.log("> CLEAR_COOKIES");
          await context.clearCookies();
          break;
        }
        case "GET_COOKIES": {
          //   console.log("> GET_COOKIES");
          //   console.log(await context.cookies());
          break;
        }
        case "CLEAR_LOCALSTORAGE": {
          //   console.log("> CLEAR_LOCALSTORAGE");
          await page.evaluate(() => localStorage.clear());
          break;
        }
        case "GET_LOCALSTORAGE": {
          break;
        }
        case "CLEAR_SESSIONSTORAGE": {
          //   console.log("> CLEAR_SESSIONSTORAGE");
          await page.evaluate(() => sessionStorage.clear());
          break;
        }
        case "GET_SESSIONSTORAGE": {
          //   console.log("> GET_SESSIONSTORAGE");
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
          await context.setExtraHTTPHeaders({ "user-agent": ua });
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
          const hdrs = JSON.parse(parts.slice(1).join(" "));
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
          //   console.log("> HAR_START");
          await context.tracing.start({ screenshots: true, snapshots: true });
          break;
        }
        case "HAR_STOP": {
          const path = parts[1];
          //   console.log(`> HAR_STOP ${path}`);
          await context.tracing.stop({ path });
          break;
        }
        case "VIDEO_START": {
          //   console.log("> VIDEO_START");
          // 需在 context 创建时指定 recordVideo 选项，运行时无法打开
          break;
        }
        case "VIDEO_STOP": {
          //   console.log("> VIDEO_STOP");
          // 可通过 page.video().path() 获取
          break;
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
          break;
        }
        case "CLOSE_PAGE": {
          const idx = Number(parts[1]) || -1;
          //   console.log(`> CLOSE_PAGE ${idx}`);
          const pages = context.pages();
          (idx >= 0 && pages[idx])?.close();
          break;
        }
        case "NEW_CONTEXT": {
          //   console.log("> NEW_CONTEXT");
          // 需在外部持有 browser 对象
          break;
        }
        case "SWITCH_CONTEXT": {
          break;
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
          console.warn(`> Unknown command: ${cmd}`);
      }
    } catch (e) {
      console.error(`Error executing ${cmd}:`, e);
    }
  }
}

module.exports = { executeCommands };
