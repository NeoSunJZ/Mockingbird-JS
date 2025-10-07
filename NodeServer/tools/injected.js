function injectedFunction(targetAPI = null) {
  // save original methods
  const OriginalJSONParse = JSON.parse;
  const OriginalXHR = window.XMLHttpRequest;
  const originalFetch = window.fetch;
  const originalResponseJson = Response.prototype.json;

  window.unFalconProxy = () => {
    JSON.parse = OriginalJSONParse;
    window.XMLHttpRequest = OriginalXHR;
    window.fetch = originalFetch;
    window.varProxy = null;
    window.index = null;
    window._f_API = null;
    Response.prototype.json = originalResponseJson;
    console.log("falcon unproxy");
  };

  window.falconProxy = () => {
    // rewrite JSON.parse
    JSON.parse = function (text, reviver) {
      try {
        let data = OriginalJSONParse(text, reviver);
        if (data.ismocking != undefined) {
          return window.varProxy(data.src, 0, "_f_init");
        }
        if (typeof data === "object" && data !== null) {
          return data;
        }
        return data;
      } catch (e) {
        try {
          return OriginalJSONParse(text, reviver);
        } catch (e2) {
          return text;
        }
      }
    };

    /**
     * variable proxy function
     * @param {*} expression expression to be proxied
     * @param {*} index proxy index
     * @param  {...any} args variables in the expression
     * @returns proxied expression
     */
    window.varProxy = (expression, index = null, ...args) => {
      if (
        window.index == undefined ||
        typeof expression === "function" ||
        expression === null ||
        expression === undefined ||
        expression === Window ||
        expression.hasOwnProperty("_f_src")
      )
        return expression;
      // console.log(expression, typeof expression);
      // if all variables in the expression have not been proxied, return directly
      let flag = false;
      let fromList = [];
      for (let arg of args) {
        if (typeof arg !== "object" || arg === null || arg === undefined)
          continue;
        if (arg["_f_from"] != undefined) {
          //arg.hasOwnProperty("_f_src") ||
          flag = true;
          try {
            if (arg["_f_from"] != undefined)
              for (let item of arg["_f_from"]) {
                fromList.push(item);
              }
          } catch (e) {
            console.error(e, arg);
          }
        }
      }
      // manually defined proxy, usually used for the initialization of the response
      if (args.length === 1 && args[0] == "_f_init") flag = true;
      if (!flag) return expression;

      if (typeof expression === "string") expression = JSON.parse(expression);
      let type = typeof expression;

      let deepClone = null;
      try {
        deepClone = structuredClone(expression);
      } catch (e) {
        console.warn("deepClone failed : ", e, " : ", expression);
        return expression;
      }

      let handler = {
        get(target, prop, receiver) {
          if (prop == "_f_src" || prop == "_f_from") return target[prop];

          let value = Reflect.get(target, prop, receiver);
          if (typeof value === "function") {
            if (
              prop !== "toString" ||
              prop !== "valueOf" ||
              typeof prop !== "symbol"
            ) {
              if (
                Array.isArray(target) &&
                [
                  "map",
                  "filter",
                  "forEach",
                  "reduce",
                  "find",
                  "some",
                  "every",
                ].includes(prop)
              ) {
                return value.bind(target);
              }
              // use original data for methods
              return value.bind(target["_f_src"]);
            }
          }
          if (value === undefined && typeof prop !== "symbol") return undefined;
          // debugger;
          let stack = new Error().stack;
          let log = {
            logIndex: index,
            stack: null,
            target: JSON.stringify(target["_f_src"]),
            prop: prop,
            from:
              typeof value === "function" || typeof prop === "symbol"
                ? target["_f_from"]
                : value["_f_from"],
          };
          // if (Object.prototype.toString.call(target).slice(8, -1) === "Array") {}
          // if (window.index === index || window.index === -1)
          log.stack = stack;
          if (typeof prop === "symbol") log.prop = "[symbol]";
          // debugger;
          window.reportLog(log);
          if (typeof value === "function") return value.bind(target["_f_src"]);

          return value;
        },
        // maintain _f_src consistency
        set(target, prop, value, receiver) {
          if (typeof value === "object" && value.hasOwnProperty("_f_src"))
            target["_f_src"][prop] = value["_f_src"];
          else target["_f_src"][prop] = value;
          return Reflect.set(target, prop, value, receiver);
        },
        has(target, prop) {
          // ensure _f_src and _f_from properties can be correctly detected
          if (prop === "_f_src" || prop === "_f_from") {
            return true;
          }
          return Reflect.has(target, prop);
        },
        ownKeys(target) {
          const keys = Reflect.ownKeys(target);
          // ensure _f_src and _f_from are not accidentally exposed
          return keys.filter((key) => key !== "_f_src" && key !== "_f_from");
        },
      };

      // object instantiation
      if (type === "string" || type === "bigint") {
        expression = new expression.constructor(expression);
      } else if (type === "number") {
        expression = new Number(expression);
      } else if (type === "boolean") {
        expression = new Boolean(expression);
      } else if (type === "object") {
        Object.defineProperty(expression, "_f_src", {
          value: deepClone,
          enumerable: false,
          writable: true,
          configurable: true,
        });

        if (fromList.length > 0) {
          Object.defineProperty(expression, "_f_from", {
            value: fromList,
            enumerable: false,
            writable: true,
            configurable: true,
          });
        } else if (!expression.hasOwnProperty("_f_from")) {
          Object.defineProperty(expression, "_f_from", {
            value: ["root"],
            enumerable: false,
            writable: true,
            configurable: true,
          });
        }

        // if (Object.prototype.toString.call(expression).slice(8, -1) === "Array")
        for (let item in expression) {
          if (
            expression.hasOwnProperty(item) &&
            item !== "_f_src" &&
            item !== "_f_from" &&
            expression[item] !== undefined &&
            expression[item] !== null
          ) {
            if (typeof expression[item] != "object") {
              // basic type
              let _src = expression[item];
              expression[item] = new expression[item].constructor(
                expression[item]
              );
              expression[item] = new Proxy(expression[item], handler);
              Object.defineProperty(expression[item], "_f_src", {
                value: _src,
                enumerable: false,
                writable: true,
                configurable: true,
              });
              Object.defineProperty(expression[item], "_f_from", {
                value: [expression["_f_from"][0] + "[" + item + "]"],
                enumerable: false,
                writable: true,
                configurable: true,
              });
            } else {
              try {
                const parentFrom = expression["_f_from"] || [];
                const newFrom = parentFrom.map((path) => `${path}[${item}]`);
                Object.defineProperty(expression[item], "_f_from", {
                  value: newFrom,
                  // [expression["_f_from"][0] + "[" + item + "]"],
                  enumerable: false,
                  writable: false,
                  configurable: true,
                });
              } catch (e) {
                console.error(expression, item, expression[item], e);
              }
              expression[item] = varProxy(expression[item], index, "_f_init");
            }
          }
        }
        return new Proxy(expression, handler);
      } else {
        console.error("try to proxy : ", expression);
        return expression;
      }
      let literalProxy = new Proxy(expression, handler);
      Object.defineProperty(literalProxy, "_f_src", {
        value: deepClone,
        enumerable: false,
        writable: true,
        configurable: true,
      });
      if (fromList.length > 0) {
        Object.defineProperty(literalProxy, "_f_from", {
          value: fromList,
          enumerable: false,
          writable: true,
          configurable: true,
        });
      } else if (!literalProxy.hasOwnProperty("_f_from")) {
        Object.defineProperty(literalProxy, "_f_from", {
          value: ["root"],
          enumerable: false,
          writable: true,
          configurable: true,
        });
      }
      return literalProxy;
    };

    window._f_API = targetAPI;

    function ProxyXHR() {
      const xhr = new OriginalXHR();

      const origOpen = xhr.open;
      xhr.open = function (method, url, ...rest) {
        xhr._f_url = url;
        return origOpen.apply(xhr, [method, url, ...rest]);
      };

      xhr.addEventListener("load", function () {
        // only proxy the specified url
        if (xhr._f_url.includes(window._f_API)) {
          try {
            Object.defineProperty(xhr, "response", {
              value: window.varProxy(xhr.response, 0, "_f_init"),
              writable: false,
              configurable: true,
            });

            let proxiedText = JSON.stringify({
              ismocking: true,
              src: xhr.responseText,
            });
            Object.defineProperty(xhr, "responseText", {
              // value: window.varProxy(proxiedText, 0, "_f_init"),
              value: proxiedText,
              writable: false,
              configurable: true,
            });
          } catch (e) {
            console.warn("XHR proxy failed:", e);
          }
        }
      });
      return xhr;
    }
    window.XMLHttpRequest = ProxyXHR;

    Response.prototype.json = async function () {
      try {
        // call original method
        const originalResult = await originalResponseJson.call(this);

        // check if proxy is needed
        if (originalResult.ismocking) {
          return window.varProxy(originalResult.src, 0, "_f_init");
        }

        return originalResult;
      } catch (e) {
        console.warn("Response.json proxy error:", e);
        return originalResponseJson.call(this);
      }
    };

    const _origFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const url = input instanceof Request ? input.url : String(input);
      const res = await _origFetch(input, init);

      try {
        const text = await res.clone().text();
        let proxiedText = JSON.stringify({
          ismocking: true,
          src: text,
        });
        // const proxiedText = varProxy(text, index, "_f_init");

        // construct new init
        const responseInit = {
          headers: res.headers,
        };

        // only assign value when status is in the valid range
        if (res.status >= 200 && res.status <= 599) {
          responseInit.status = res.status;
          responseInit.statusText = res.statusText;
        }
        if (url.includes(window._f_API)) {
          return new Response(proxiedText, responseInit);
        } else {
          return res;
        }
      } catch (e) {
        console.warn("fetch proxy failed:", e);
        return res;
      }
    };

    console.log("falcon proxy");
  };
  unFalconProxy();
  falconProxy();
}

module.exports = injectedFunction;
