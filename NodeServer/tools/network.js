// No envelopes, body pre-reading or replacement Response/XHR constructors.
function installNetworkHooks(host, runtime, options = {}) {
  const restores = [];
  const responseInfo = new WeakMap();
  const xhrInfo = new WeakMap();
  const target = typeof options === 'string' ? options : options.targetAPI;
  let sequence = 0;
  const matches = url => typeof target === 'string' && target.length > 0 && typeof url === 'string' && url.includes(target);
  const info = url => ({ id: `${options.realmId || 'network'}/response#${++sequence}`, url });
  function patch(object, key, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return;
    Object.defineProperty(object, key, { ...descriptor, ...replacement });
    restores.push(() => Object.defineProperty(object, key, descriptor));
  }
  const originalParse = host.JSON.parse;
  patch(host.JSON, 'parse', { value: function (text, reviver) {
    const data = runtime.meta(text);
    const result = Reflect.apply(originalParse, this, [runtime.raw(text), reviver]);
    if (!data) return result;
    if (reviver) {
      runtime.gap('json-reviver-summary', { from: data.sources });
      return runtime.varProxy(result, options.round, text);
    }
    return data.sourceRoot ? runtime.source(result, { id: data.sourceRoot, transport: 'JSON.parse' })
      : runtime.varProxy(result, options.round, text);
  } });

  if (host.fetch && host.Response) {
    const originalFetch = host.fetch;
    patch(host, 'fetch', { value: async function (...args) {
      const response = await Reflect.apply(originalFetch, this, args);
      // Native Response.url avoids evaluating custom Request/URL coercions twice.
      const url = response.url;
      if (matches(url) || typeof args[0] === 'string' && matches(args[0])) responseInfo.set(response, info(url));
      return response;
    } });
    const prototype = host.Response.prototype;
    for (const method of ['json', 'text']) {
      const original = prototype[method];
      patch(prototype, method, { value: async function (...args) {
        const result = await Reflect.apply(original, this, args);
        const source = responseInfo.get(this);
        return source ? runtime.source(result, { ...source, transport: `fetch.${method}` }) : result;
      } });
    }
    const clone = prototype.clone;
    patch(prototype, 'clone', { value: function (...args) {
      const result = Reflect.apply(clone, this, args);
      if (responseInfo.has(this)) responseInfo.set(result, responseInfo.get(this));
      return result;
    } });
    for (const method of ['arrayBuffer', 'blob', 'formData', 'bytes']) {
      if (!prototype[method]) continue;
      const original = prototype[method];
      patch(prototype, method, { value: function (...args) {
        if (responseInfo.has(this)) runtime.gap('binary-body', { method, ...responseInfo.get(this) });
        return Reflect.apply(original, this, args);
      } });
    }
  }

  if (host.XMLHttpRequest) {
    const prototype = host.XMLHttpRequest.prototype;
    const open = prototype.open;
    patch(prototype, 'open', { value: function (...args) {
      // Coerce once, then hand the same string to native open. Do not read
      // responseText for responseType=json: the native getter must still throw.
      const method = String(runtime.raw(args[0]));
      const url = String(runtime.raw(args[1]));
      const result = Reflect.apply(open, this, [method, url, ...args.slice(2)]);
      xhrInfo.set(this, { source: matches(url) ? info(url) : null, cache: new Map() });
      return result;
    } });
    for (const property of ['response', 'responseText']) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      patch(prototype, property, { get: function () {
        const value = Reflect.apply(descriptor.get, this, []);
        const data = xhrInfo.get(this);
        if (!data?.source || this.readyState < 3 || value === null || value === '') return value;
        const type = this.responseType;
        if (property === 'response' && !['', 'text', 'json'].includes(type)) {
          runtime.gap('binary-xhr', { responseType: type, ...data.source });
          return value;
        }
        const cached = data.cache.get(property);
        if (cached && Object.is(cached.value, value)) return cached.box;
        const box = runtime.source(value, { ...data.source, transport: `xhr.${property}` });
        data.cache.set(property, { value, box });
        return box;
      } });
    }
  }
  return () => { for (const restore of restores.reverse()) restore(); };
}
module.exports = installNetworkHooks;
