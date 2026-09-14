// Self-contained: this function is serialized into each browser realm.
function createTraceRuntime(host, options = {}) {
  const metadata = new WeakMap();
  const objectProxies = new WeakMap();
  const functionProxies = new WeakMap();
  const contexts = [];
  const pending = new Set();
  const events = [];
  const failures = [];
  const eventLimit = options.eventLimit ?? 100000;
  let sequence = 0;
  let responseSequence = 0;
  let active = true;
  const realm = options.realmId || Math.random().toString(36).slice(2);
  const round = options.round ?? 0;
  const isObject = value => value !== null && (typeof value === 'object' || typeof value === 'function');
  const meta = value => isObject(value) ? metadata.get(value) : undefined;
  const labels = value => meta(value)?.sources || [];
  const union = (...lists) => [...new Set(lists.flat())];

  function emit(kind, detail = {}) {
    if (!active) return;
    const event = { kind, sequence: ++sequence, round, realm, ...detail };
    if (events.length < eventLimit) events.push(event);
    else if (!failures.includes('event-buffer-overflow')) failures.push('event-buffer-overflow');
    if (typeof host.reportLog === 'function') {
      let promise;
      try {
        promise = Promise.resolve(host.reportLog(event)).catch(error => {
          failures.push(`reportLog: ${error.message}`);
        }).finally(() => pending.delete(promise));
        pending.add(promise);
      } catch (error) { failures.push(`reportLog: ${error.message}`); }
    }
    return event;
  }
  function observe(kind, sources, detail = {}) {
    if (!sources.length) return;
    for (const context of contexts) for (const source of sources) context.sources.add(source);
    return emit(kind, { from: sources, stack: new Error().stack, ...detail });
  }
  function raw(value) {
    const data = meta(value);
    if (!data) return value;
    observe('coerce', data.sources);
    return data.raw;
  }
  function gap(reason, detail = {}) { return emit('gap', { reason, ...detail }); }
  const pointer = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

  function wrap(value, sources, info = {}) {
    if (!active || !sources.length) return value;
    const existing = meta(value);
    if (existing) return value;
    if (value === null || value === undefined) return value;
    if (typeof value === 'function') return callable(value);
    const primitive = !isObject(value);
    // DOM objects must keep their native identity and internal slots. Metadata
    // can be attached out-of-band; never proxy an Element returned by rendering.
    if (!primitive && host.Node && value instanceof host.Node) {
      metadata.set(value, { raw: value, sources, primitive: false, hostObject: true });
      return value;
    }
    if (!primitive && objectProxies.has(value)) {
      const proxy = objectProxies.get(value);
      const data = meta(proxy);
      data.sources = union(data.sources, sources);
      return proxy;
    }
    // Object(bigint/symbol) works; neither BigInt nor Symbol is a constructor.
    const target = primitive ? Object(value) : value;
    const data = { raw: value, sources, primitive, fields: new Map(), ...info };
    const proxy = new Proxy(target, {
      get(target, key, receiver) {
        if (primitive && key === '__v_skip') return true; // Vue 3 must not proxy our primitive wrappers again.
        if (primitive && (key === 'toJSON' || key === Symbol.toPrimitive)) return () => raw(receiver);
        // Native primitive accessors need internal slots on the real wrapper.
        const internal = value instanceof Map || value instanceof Set || value instanceof Date || value instanceof RegExp || ArrayBuffer.isView(value);
        const result = Reflect.get(target, key, primitive || internal ? target : receiver);
        if (result === undefined && !Reflect.getOwnPropertyDescriptor(target, key)) return result;
        let field = data.fields.get(key);
        if (!field || !Object.is(field.value, result)) {
          const from = meta(result)?.sources || (data.sourceRoot && typeof key !== 'symbol' && typeof result !== 'function' && !(Array.isArray(target) && key === 'length')
            ? [`${data.sourceRoot}:${data.path || ''}/${pointer(key)}`] : data.sources);
          field = { value: result, sources: from };
          data.fields.set(key, field);
        }
        observe('get', field.sources, { prop: String(key), logIndex: round });
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (descriptor && !descriptor.configurable && 'value' in descriptor && !descriptor.writable) {
          if (!isObject(result) || !meta(result)) gap('fixed-property', { prop: String(key), from: field.sources });
          return result; // Required by Proxy invariants, including frozen objects.
        }
        if (typeof result === 'function') return callable(result);
        if (primitive) return result;
        if (!('boxed' in field)) field.boxed = wrap(result, field.sources, data.sourceRoot
          ? { sourceRoot: data.sourceRoot, path: `${data.path || ''}/${pointer(key)}` } : {});
        return field.boxed;
      },
      set(target, key, value, receiver) {
        const stored = meta(value)?.raw ?? value;
        const success = Reflect.set(target, key, stored, receiver);
        if (success) data.fields.set(key, { value: stored, boxed: value, sources: labels(value) });
        return success;
      },
      defineProperty(target, key, descriptor) {
        const clean = { ...descriptor };
        if ('value' in clean) clean.value = meta(clean.value)?.raw ?? clean.value;
        const success = Reflect.defineProperty(target, key, clean);
        if (success) {
          if ('value' in descriptor) data.fields.set(key, {
            value: clean.value, boxed: descriptor.value, sources: labels(descriptor.value)
          });
          else data.fields.delete(key);
        }
        return success;
      },
      deleteProperty(target, key) {
        const success = Reflect.deleteProperty(target, key);
        if (success) data.fields.delete(key);
        return success;
      },
      has(target, key) {
        observe('has', data.sources, { prop: String(key) });
        return Reflect.has(target, key);
      },
      ownKeys(target) {
        observe('keys', data.sources);
        return Reflect.ownKeys(target);
      }
    });
    metadata.set(proxy, data);
    if (!primitive) objectProxies.set(value, proxy);
    return proxy;
  }

  function callable(fn) {
    if (functionProxies.has(fn)) return functionProxies.get(fn);
    const proxy = new Proxy(fn, {
      apply(target, receiver, args) {
        const data = meta(receiver);
        const from = union(labels(receiver), ...args.map(labels));
        observe('call', from, { method: target.name });
        // Preserve dynamic this (including .call/.apply and detached methods).
        // Only known internal-slot builtins use raw receivers.
        const internal = data && (data.primitive || data.raw instanceof Date ||
          data.raw instanceof Map || data.raw instanceof Set || data.raw instanceof RegExp ||
          ArrayBuffer.isView(data.raw));
        const arraySearch = data && Array.isArray(data.raw) &&
          [Array.prototype.includes, Array.prototype.indexOf, Array.prototype.lastIndexOf].includes(target);
        let forwarded = internal || arraySearch ? args.map(value => meta(value)?.raw ?? value) : args;
        const predicates = [Array.prototype.filter, Array.prototype.find, Array.prototype.findIndex,
          Array.prototype.findLast, Array.prototype.findLastIndex, Array.prototype.some, Array.prototype.every, Array.prototype.sort];
        if (data && Array.isArray(data.raw) && predicates.includes(target) && typeof args[0] === 'function') {
          forwarded = [...args];
          forwarded[0] = function (...values) { return raw(Reflect.apply(args[0], this, values)); };
        }
        const result = Reflect.apply(target, internal || arraySearch ? data.raw : receiver, forwarded);
        // Iterators and promises have internal slots; their individual yielded
        // values are observed through the proxied array, not a proxy of next().
        if (result instanceof Promise || [Array.prototype.values, Array.prototype.keys, Array.prototype.entries,
          Map.prototype.values, Map.prototype.keys, Map.prototype.entries,
          Set.prototype.values, Set.prototype.keys, Set.prototype.entries].includes(target)) {
          if (internal) gap('native-carrier', { method: target.name, from });
          return result;
        }
        if (internal && isObject(result)) gap('native-result-summary', { method: target.name, from });
        return wrap(result, from);
      }
    });
    metadata.set(proxy, { raw: fn, sources: [], primitive: false });
    functionProxies.set(fn, proxy);
    return proxy;
  }

  function source(value, detail = {}) {
    const id = detail.id || `${realm}/response#${++responseSequence}`;
    emit('source', { sourceId: id, ...detail });
    return wrap(value, [`${id}:`], { sourceRoot: id, path: '' });
  }
  function capture(thunk, site, iteration = round) {
    const context = { sources: new Set(), site };
    contexts.push(context);
    try {
      const result = thunk();
      const from = union([...context.sources], labels(result));
      if (from.length) emit('derive', { site, from, logIndex: iteration });
      return wrap(result, from);
    } finally { contexts.pop(); }
  }
  const runtime = {
    source, raw, capture, meta, labels, gap, emit,
    key(value) { return Reflect.ownKeys({ [raw(value)]: 0 })[0]; },
    condition(value) { observe('control', labels(value)); return !!raw(value); },
    sink(kind, value, detail = {}) {
      observe('sink', labels(value), { sink: kind, ...detail });
      return raw(value);
    },
    varProxy(value, iteration, ...parents) {
      if (parents.length === 1 && parents[0] === '_f_init') return source(value);
      return wrap(value, union(...parents.map(labels)), { iteration });
    },
    events, failures,
    async flush() {
      while (pending.size) await Promise.all([...pending]);
      return { count: sequence, failures: [...failures] };
    },
    stop() { active = false; }
  };
  return runtime;
}
module.exports = createTraceRuntime;
