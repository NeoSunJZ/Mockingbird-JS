const createRuntime = require('./runtime');
const installNetworkHooks = require('./network');

// Playwright serializes this function; put its dependencies in the function body
// so initialization is atomic and does not depend on addInitScript ordering.
const injectedFunction = new Function('options', `
  options = typeof options === 'string' ? { targetAPI: options } : (options || {});
  if (globalThis.__mockingbird) return;
  options.realmId = options.realmId || Math.random().toString(36).slice(2);
  const runtime = (${createRuntime.toString()})(globalThis, options);
  Object.defineProperty(globalThis, '__mockingbird', { value: runtime, configurable: true });
  globalThis.index = options.round ?? 0;
  globalThis.varProxy = runtime.varProxy;
  const restoreNetwork = (${installNetworkHooks.toString()})(globalThis, runtime, options);
  globalThis.unFalconProxy = () => {
    restoreNetwork();
    runtime.stop();
    delete globalThis.__mockingbird;
    delete globalThis.varProxy;
  };
`);
module.exports = injectedFunction;
