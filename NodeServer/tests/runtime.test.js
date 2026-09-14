const test = require('node:test');
const assert = require('node:assert/strict');
const createRuntime = require('../tools/runtime');
const setup = () => createRuntime({}, { realmId: 'test' });

test('lazy boxes preserve raw data, nulls, business keys and primitive types', () => {
  const t = setup();
  const raw = { n: 42, no: false, s: '123', nil: null, _f_src: 'business', hasOwnProperty: 3 };
  const p = t.source(raw);
  assert.equal(t.raw(p.n), 42);
  assert.equal(t.raw(p.s), '123');
  assert.equal(t.raw(p._f_src), 'business');
  assert.equal(p.nil, null);
  p.nil = null;
  assert.equal(raw.n, 42);
  assert.deepEqual(Object.keys(p), Object.keys(raw));
  assert.equal(JSON.stringify(p), JSON.stringify(raw));
  assert.equal(t.condition(p.no), false);
  assert.equal(t.raw(t.source(1n)), 1n);
  assert.equal(typeof t.raw(t.source(Symbol('x'))), 'symbol');
});
test('mutating arrays, slice, iteration and search use live storage', () => {
  const t = setup();
  const raw = [1, 2];
  const p = t.source(raw);
  assert.equal(t.raw(p.push(3)), 3);
  assert.deepEqual(raw, [1, 2, 3]);
  assert.equal(t.raw(p.length), 3);
  assert.equal(t.raw(p.indexOf(2)), 1);
  assert.equal(t.raw(p.includes(2)), true);
  assert.ok(t.labels(p.slice(0, 1)[0])[0].endsWith(':/0'));
  assert.ok(t.labels([...p][1])[0].endsWith(':/1'));
});
test('methods keep stable identity and dynamic receivers without cloning', () => {
  const t = setup();
  const p = t.source({ x: 2, method() { return this.x; } });
  assert.equal(p.method, p.method);
  assert.equal(t.raw(p.method()), 2);
  assert.equal(t.raw(p.method.call({ x: 9 })), 9);
  const method = t.source('alice').toUpperCase;
  assert.throws(() => method(), TypeError);
  assert.equal(t.raw(p.x.toFixed(1)), '2.0');
});
test('provenance never invents child paths for derived values', () => {
  const t = setup();
  const p = t.source({ a: 1, b: 2 });
  const out = t.capture(() => ({ x: Number(p.a) + 1, y: Number(p.b) + 1 }), 'object');
  assert.deepEqual(new Set(t.labels(out.x)), new Set(['test/response#1:/a', 'test/response#1:/b']));
  assert.equal(t.labels(t.varProxy({ x: p.a }, 1, p.a).x)[0], 'test/response#1:/a');
});
test('writes clear stale labels and copied children retain exact labels', () => {
  const t = setup();
  const p = t.source({ a: 1, b: 2 });
  p.a = p.b;
  assert.deepEqual(t.labels(p.a), ['test/response#1:/b']);
  p.a = 7;
  assert.equal(p.a, 7);
  assert.deepEqual(t.labels(p.a), []);
});
test('cycles, frozen objects and property operations satisfy proxy invariants', () => {
  const t = setup();
  const raw = {}; raw.self = raw;
  const p = t.source(raw);
  assert.equal(p.self, p);
  assert.throws(() => JSON.stringify(p), TypeError);
  const frozen = t.source(Object.freeze({ n: 2 }));
  assert.deepEqual(Object.keys(frozen), ['n']);
  assert.equal(frozen.n, 2);
  assert.ok(t.events.some(e => e.kind === 'gap' && e.reason === 'fixed-property'));
  assert.equal('self' in p, true);
  delete p.self;
  assert.equal('self' in p, false);
});
test('capture executes once, unwinds exceptions and preserves string results', () => {
  const t = setup();
  const p = t.source({ n: 1 });
  let count = 0;
  const value = t.capture(() => { count++; return Number(p.n) + 1; }, 'site');
  assert.equal(count, 1);
  assert.equal(t.raw(value), 2);
  assert.deepEqual(t.labels(value), ['test/response#1:/n']);
  assert.throws(() => t.capture(() => { throw Error('expected'); }, 'bad'), /expected/);
  assert.equal(t.capture(() => '123', 'clean'), '123');
});
test('report failures and buffer overflow remain visible and flush waits', async () => {
  const t = createRuntime({ reportLog: async () => { throw Error('offline'); } }, { eventLimit: 1 });
  t.source({ a: 1 }).a;
  const result = await t.flush();
  assert.ok(result.failures.includes('event-buffer-overflow'));
  assert.ok(result.failures.some(s => s.includes('offline')));
});
