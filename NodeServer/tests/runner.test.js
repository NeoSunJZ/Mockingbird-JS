const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {parseConfig}=require('../ede-killer');
const {executeCommands}=require('../tools/command');
const {ScriptStore}=require('../tools/scripts');

test('config supports LF/CRLF, validates target, and preserves JavaScript spaces',()=>{
  assert.deepEqual(parseConfig('# comment\nTARGET /api\nLOAD http://localhost\nEVALUATE window.x="a  b"\n'),{
    targetAPI:'/api',commands:['LOAD http://localhost','EVALUATE window.x="a  b"']});
  assert.throws(()=>parseConfig('LOAD http://localhost'),/TARGET/);
  assert.throws(()=>parseConfig('TARGET a\nTARGET b\nLOAD x'),/exactly one/);
});
test('command failures propagate and response waits are installed before actions',async()=>{
  const order=[];
  const page={context:()=>({}),evaluate:async text=>order.push(text),click:async()=>order.push('click'),
    waitForResponse:()=>{order.push('wait');return Promise.resolve({});}};
  await executeCommands(page,['EVALUATE window.x="a  b"','CLICK //button','WAIT_FOR_RESPONSE /api']);
  assert.deepEqual(order,['window.x="a  b"','wait','click']);
  await assert.rejects(executeCommands(page,['UNKNOWN']),/Unknown command/);
  await assert.rejects(executeCommands({...page,click:async()=>{throw Error('missing');}},['CLICK //button']),/missing/);
});
test('script identity isolates same basenames, query variants and changed source versions',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-scripts-'));
  try {
    const store=new ScriptStore(dir);
    const a=await store.register('http://localhost/a/index.js','const a=1');
    const b=await store.register('http://localhost/b/index.js','const a=1');
    const c=await store.register('http://localhost/a/index.js?v=2','const a=1');
    const d=await store.register('http://localhost/a/index.js','const a=2');
    assert.equal(new Set([a.id,b.id,c.id,d.id]).size,4);
    assert.equal((await store.register('http://localhost/a/index.js','const a=1')).id,a.id);
    assert.equal(store.manifest().length,4);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('quoted action arguments, inspection commands and invalid waits are handled explicitly',async()=>{
  const seen=[];const page={context:()=>({cookies:async()=>[{name:'a',value:'b'}]}),
    fill:async(...args)=>seen.push(args)};
  await executeCommands(page,['INPUT "//input[@name=\'full name\']" "Alice Smith"','GET_COOKIES'],{onResult:r=>seen.push(r)});
  assert.deepEqual(seen[0],["xpath=//input[@name='full name']",'Alice Smith']);
  assert.equal(seen[1].value[0].name,'a');
  await assert.rejects(executeCommands(page,['SLEEP nope']),/nonnegative/);
});
test('whole XPath arguments retain quotes inside predicates',async()=>{
 let selector;const page={context:()=>({}),click:async value=>{selector=value;}};
 await executeCommands(page,["CLICK //button[contains(., 'get login message')]"]);
 assert.equal(selector,"xpath=//button[contains(., 'get login message')]");
});
