const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const injected=require('../../tools/injected');

test('DOM sinks retain source through detached nodes and unbox native values',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await page.goto('about:blank');
    await page.evaluate(injected,{targetAPI:'/api'});
    const result=await page.evaluate(()=>{
      const t=__mockingbird;const p=t.source({text:'hello',flag:false});
      const node=document.createTextNode(p.text);
      const before=t.events.filter(e=>e.kind==='sink').length;
      document.body.appendChild(node);
      const input=document.createElement('input');input.type='checkbox';document.body.appendChild(input);input.checked=p.flag;
      return {before,text:document.body.textContent,checked:input.checked,sinks:t.events.filter(e=>e.kind==='sink').map(e=>({sink:e.sink,from:e.from}))};
    });
    assert.equal(result.before,0);assert.equal(result.text,'hello');assert.equal(result.checked,false);
    assert.ok(result.sinks.some(s=>s.sink==='text' && s.from[0].endsWith(':/text')));
    assert.ok(result.sinks.some(s=>s.sink==='checked' && s.from[0].endsWith(':/flag')));
  } finally {await browser.close();}
});
test('ignored nodeValue writes and replaced detached text do not create stale sinks',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await page.evaluate(injected,{});
    const result=await page.evaluate(()=>{
      const t=__mockingbird;const value=t.source('secret');
      const div=document.createElement('div');document.body.appendChild(div);
      div.nodeValue=value; // Native no-op on Element.
      const text=document.createTextNode(value);text.data='public';div.appendChild(text);
      const other=document.createElement('div');other.textContent=value;other.firstChild.nodeValue='public';div.appendChild(other);
      return {text:div.textContent,sinks:t.events.filter(e=>e.kind==='sink')};
    });
    assert.equal(result.text,'publicpublic');assert.equal(result.sinks.length,0);
  } finally {await browser.close();}
});
