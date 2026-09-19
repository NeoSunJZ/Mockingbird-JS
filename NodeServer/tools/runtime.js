// Self-contained: this function is serialized into each browser realm.
function createTraceRuntime(host, options = {}) {
  const metadata = new WeakMap();
  const objectProxies = new WeakMap();
  const functionProxies = new WeakMap();
  const conversions = new Set([Boolean, Number, String, BigInt]);
  const objectIs = Object.is;
  const nativeMethods = new Set();
  for (const ctor of [Number, String, Boolean, BigInt, Symbol, Date, RegExp, Map, Set, WeakMap, WeakSet, Promise, DataView,
    Object.getPrototypeOf(Uint8Array)]) {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(ctor.prototype))) {
      if (typeof descriptor.value === 'function') nativeMethods.add(descriptor.value);
    }
  }
  const arrayMethods = new Set(Object.values(Object.getOwnPropertyDescriptors(Array.prototype)).map(d=>d.value).filter(v=>typeof v==='function'));
  const isInternal = v => v instanceof Date || v instanceof RegExp || v instanceof Map || v instanceof Set ||
    v instanceof WeakMap || v instanceof WeakSet || ArrayBuffer.isView(v);
  const pending = new Set();
  const events = [];
  const failures = [];
  const eventLimit = options.eventLimit ?? 100000;
  let sequence = 0;
  let responseSequence = 0;
  let valueSequence = 0;
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
    if (events.length >= eventLimit || pending.size >= (options.pendingLimit ?? 10000)) {
      const reason = events.length >= eventLimit ? 'event-buffer-overflow' : 'report-backpressure';
      if (!failures.includes(reason)) failures.push(reason);
      return;
    }
    events.push(event);
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
    return emit(kind, { from: sources, stack: new Error().stack, ...detail });
  }
  function raw(value) {
    const data = meta(value);
    if (!data) return value;
    observe('coerce', data.sources, { valueId: data.valueId });
    return data.raw;
  }
  function gap(reason, detail = {}) { return emit('gap', { reason, ...detail }); }
  const pointer = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

  function wrap(value, sources, info = {}) {
    if (!active || !sources.length) return value;
    const existing = meta(value);
    if (existing) return value;
    if (value === null || value === undefined) {
      gap('nullish-propagation', { from: sources });
      return value;
    }
    if (typeof value === 'function') { gap('function-result-summary',{from:sources});return callable(value); }
    const valueId = `${realm}/value#${++valueSequence}`;
    const lineage = { valueId, parents: info.parents || [], precision: info.sourceRoot ? 'source-field' : 'conservative' };
    emit('value', { ...lineage, from: sources });
    const primitive = !isObject(value);
    // DOM objects must keep their native identity and internal slots. Metadata
    // can be attached out-of-band; never proxy an Element returned by rendering.
    if (!primitive && host.Node && value instanceof host.Node) {
      metadata.set(value, { raw: value, sources, ...lineage, primitive: false, hostObject: true });
      return value;
    }
    if (!primitive && !Array.isArray(value) && !isInternal(value) &&
      ![Object.prototype, null].includes(Reflect.getPrototypeOf(value))) {
      metadata.set(value, { raw:value, sources, ...lineage, primitive:false, opaque:true });
      gap('opaque-result', { from:sources, valueId });
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
    const data = { raw: value, sources, primitive, fields: new Map(), ...info, ...lineage };
    const proxy = new Proxy(target, {
      get(target, key, receiver) {
        if (primitive && key === '__v_skip') return true; // Vue 3 must not proxy our primitive wrappers again.
        if (primitive && (key === 'toJSON' || key === Symbol.toPrimitive)) return () => raw(receiver);
        // Native primitive accessors need internal slots on the real wrapper.
        const internal = isInternal(value);
        const result = Reflect.get(target, key, primitive || internal ? target : receiver);
        if (result === undefined && !Reflect.getOwnPropertyDescriptor(target, key)) return result;
        let field = data.fields.get(key);
        if (!field || !Object.is(field.value, result)) {
          const from = meta(result)?.sources || (data.sourceRoot && typeof key !== 'symbol' && typeof result !== 'function' && !(Array.isArray(target) && key === 'length')
            ? [`${data.sourceRoot}:${data.path || ''}/${pointer(key)}`] : primitive || internal ? data.sources : []);
          field = { value: result, sources: from };
          data.fields.set(key, field);
        }
        observe('get', typeof result === 'function' && (data.sourceRoot || primitive || internal || Array.isArray(target)) ? data.sources : field.sources, { prop: String(key), logIndex: round, valueId: data.valueId });
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (descriptor && !descriptor.configurable && 'value' in descriptor && !descriptor.writable) {
          if (!isObject(result) || !meta(result)) gap('fixed-property', { prop: String(key), from: field.sources });
          return result; // Required by Proxy invariants, including frozen objects.
        }
        if (typeof result === 'function') return callable(result);
        if (primitive) return result;
        if (!('boxed' in field)) field.boxed = wrap(result, field.sources, data.sourceRoot
          ? { sourceRoot: data.sourceRoot, path: `${data.path || ''}/${pointer(key)}`, parents: [data.valueId] } : { parents: [data.valueId] });
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
        observe('has', data.sourceRoot ? data.sources : [], { prop: String(key), valueId: data.valueId });
        return Reflect.has(target, key);
      },
      ownKeys(target) {
        observe('keys', data.sourceRoot ? data.sources : [], { valueId: data.valueId });
        return Reflect.ownKeys(target);
      }
    });
    metadata.set(proxy, data);
    if (!primitive) objectProxies.set(value, proxy);
    return proxy;
  }

  function callable(fn) {
    // User functions keep exact identity and dynamic this. Their bodies are
    // discovered by proxy reads and instrumented in later rounds.
    if (!nativeMethods.has(fn) && !arrayMethods.has(fn)) return fn;
    if (functionProxies.has(fn)) return functionProxies.get(fn);
    const proxy = new Proxy(fn, { apply(target, receiver, args) {
      return invoke(target, receiver, args, 'native-summary');
    } });
    metadata.set(proxy, { raw:fn, sources:[], primitive:false });
    functionProxies.set(fn, proxy);
    return proxy;
  }

  function derive(value, inputs = [], site) {
    const from = union(...inputs.map(labels));
    const parents = inputs.map(input=>meta(input)?.valueId).filter(Boolean);
    const result = wrap(value, from, { parents });
    if (from.length) emit('derive', { site, from, valueId:meta(result)?.valueId,
      parents:parents.filter(id=>id!==meta(result)?.valueId) });
    return result;
  }

  function object(value) {
    // Inspect descriptors, never reread accessors. The literal's actual values
    // were already evaluated once, individually, by the AST rewriter.
    const fields = Object.values(Object.getOwnPropertyDescriptors(value)).filter(d=>'value' in d).map(d=>d.value);
    return derive(value, fields, 'object-fields');
  }

  function invoke(fn, receiver, args, site, selector, valueNeeded = true) {
    const target = meta(fn)?.raw ?? fn;
    const data = meta(receiver);
    const inputs = [fn, receiver, selector, ...args];
    const from = union(...inputs.map(labels));
    observe('call', from, { method:target?.name, valueId:data?.valueId });
    const intrinsic = nativeMethods.has(target);
    // A container holding a tracked field is not automatically an input to
    // every user method on that container. Actual this-field reads are traced.
    const resultInputs = [fn, selector, ...args];
    if(intrinsic || arrayMethods.has(target)) resultInputs.push(receiver);
    const actualReceiver = intrinsic && data ? data.raw : receiver;
    let forwarded = args;
    if (conversions.has(target) || target === objectIs) forwarded = args.map(raw);
    else if (intrinsic) {
      // Keep object key identity for Map/WeakMap/Set/WeakSet. Only tracer
      // primitive wrappers must become primitives at the native interface.
      forwarded = args.map((arg,index)=>[Map.prototype.set,WeakMap.prototype.set].includes(target) && index===1 ? arg : meta(arg)?.primitive ? raw(arg) : arg);
    }
    if (data && Array.isArray(data.raw)) {
      if ([Array.prototype.includes,Array.prototype.indexOf,Array.prototype.lastIndexOf].includes(target)) {
        forwarded=args.map(raw);
        const result=Reflect.apply(target,data.raw,forwarded);
        return derive(result,resultInputs,site);
      }
      const predicates=[Array.prototype.filter,Array.prototype.find,Array.prototype.findIndex,
        Array.prototype.findLast,Array.prototype.findLastIndex,Array.prototype.some,Array.prototype.every,Array.prototype.sort];
      if(predicates.includes(target) && typeof args[0]==='function') {
        forwarded=[...args];forwarded[0]=function(...values){return raw(Reflect.apply(args[0],this,values));};
      }
    }
    const result=Reflect.apply(target,actualReceiver,forwarded);
    if (!valueNeeded) return result;
    if (data && result===data.raw) return receiver;
    const iterators=[Array.prototype.values,Array.prototype.keys,Array.prototype.entries,
      Map.prototype.values,Map.prototype.keys,Map.prototype.entries,Set.prototype.values,Set.prototype.keys,Set.prototype.entries,String.prototype[Symbol.iterator]];
    if(iterators.includes(target)) {
      if(intrinsic && from.length)gap('native-carrier',{method:target.name,from});
      return result;
    }
    if(target===Object.keys || target===Object.getOwnPropertyNames || target===Object.getOwnPropertySymbols) {
      if(meta(args[0])?.sourceRoot)gap('structure-propagation',{from:labels(args[0]),method:target.name});
      return result;
    }
    if(target===Object.values)return object(result);
    if(target===Object.entries)return object(result.map(pair=>object(pair)));
    if ([Map.prototype.get,WeakMap.prototype.get].includes(target)) return derive(result,[result,args[0]],site);
    if ([Map.prototype.set,WeakMap.prototype.set,Set.prototype.add,WeakSet.prototype.add].includes(target)) return result;
    if (Array.isArray(result) && arrayMethods.has(target)) return object(result);
    const resultFrom=union(...resultInputs.map(labels));
    if (isObject(result) && !meta(result) && resultFrom.length) gap('object-result-summary',{method:target?.name,from:resultFrom});
    return derive(result,resultInputs,site);
  }

  function source(value, detail = {}) {
    const id = detail.id || `${realm}/response#${++responseSequence}`;
    emit('source', { sourceId: id, ...detail });
    return wrap(value, [`${id}:`], { sourceRoot: id, path: '', parents: [id] });
  }
  // Compatibility only: callers must pass explicit inputs. Reads that happen
  // elsewhere during thunk execution cannot taint its unrelated return value.
  function capture(thunk, site, iteration = round, ...inputs) {
    return derive(thunk(), inputs, site);
  }
  const runtime = {
    source, raw, capture, meta, labels, gap, emit, derive, object, invoke,
    result(value, site, iteration = round) {
      if(labels(value).length)emit('result',{site,logIndex:iteration,from:labels(value),valueId:meta(value)?.valueId});
      return value;
    },
    member(receiver, key, site) {
      const value=receiver[key];
      return derive(value,meta(receiver)?.primitive ? [receiver,key,value] : [key,value],site);
    },
    remove(receiver, key, site) {
      return derive(delete receiver[key],[receiver,key],site);
    },
    construct(fn,args,site) { return derive(Reflect.construct(meta(fn)?.raw ?? fn,args),args,site); },
    nullish(value) { observe('control',labels(value),{valueId:meta(value)?.valueId});return raw(value)==null; },
    builtin(fn, receiver, args) {
      return Reflect.apply(fn, receiver, conversions.has(fn) || fn === objectIs ? args.map(raw) : args);
    },
    key(value) { return Reflect.ownKeys({ [raw(value)]: 0 })[0]; },
    controlValue(value) { observe('control',labels(value),{valueId:meta(value)?.valueId});return raw(value); },
    condition(value) { observe('control', labels(value), { valueId: meta(value)?.valueId }); return !!raw(value); },
    sink(kind, value, detail = {}) {
      observe('sink', labels(value), { sink: kind, valueId: meta(value)?.valueId, ...detail });
      return raw(value);
    },
    varProxy(value, iteration, ...parents) {
      if (parents.length === 1 && parents[0] === '_f_init') return source(value);
      return wrap(value, union(...parents.map(labels)), { iteration, parents: parents.map(parent => meta(parent)?.valueId).filter(Boolean) });
    },
    step(value, direction) {
      // Native ++ performs ToNumeric (including bigint and custom coercion)
      // exactly once. Expose both values for prefix/postfix reference rewriting.
      let after = raw(value);
      const before = direction === 1 ? after++ : after--;
      const parents = [meta(value)?.valueId].filter(Boolean);
      return { before: wrap(before, labels(value), { parents }), after: wrap(after, labels(value), { parents }) };
    },
    events, failures,
    async flush(timeoutMs = 5000) {
      let timer;
      try {
        await Promise.race([
          (async () => { while (pending.size) await Promise.all([...pending]); })(),
          new Promise(resolve => { timer = setTimeout(() => { failures.push('report-flush-timeout'); resolve(); }, timeoutMs); })
        ]);
      } finally { clearTimeout(timer); }
      return { count: sequence, failures: [...new Set(failures)] };
    },
    stop() { active = false; }
  };
  return runtime;
}
module.exports = createTraceRuntime;
