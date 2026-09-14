const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const injected = require('../../tools/injected');

test('native fetch and XHR retain response behavior and track before readyState callbacks', async () => {
  const server = http.createServer((req,res) => {
    if (req.url === '/stream') { res.setHeader('content-type','text/event-stream'); res.write('data: hello\n\n'); return; }
    if (req.url === '/api') { res.setHeader('content-type','application/json'); res.end('{"n":42,"flag":false,"s":"123"}'); return; }
    if (req.url === '/api-bad') { res.end('{broken'); return; }
    res.end('<!doctype html><div id="app"></div>');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless:true, ...(process.env.BROWSER_PATH ? {executablePath:process.env.BROWSER_PATH} : {}) });
    const page = await browser.newPage();
    await page.addInitScript(injected, {targetAPI:'/api',round:0});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const t=__mockingbird;
      const response=await fetch('/api');
      const clone=response.clone();
      const text=await response.text();
      const parsed=JSON.parse(text);
      const json=await clone.json();
      const stream=await Promise.race([fetch('/stream').then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),1000))]);
      let parseThrows=false,bodyThrows=false;
      try {JSON.parse('{broken');} catch {parseThrows=true;}
      try {await response.json();} catch {bodyThrows=true;}
      const xhr=await new Promise((resolve,reject)=>{
        const x=new XMLHttpRequest();const seen=[];
        x.onreadystatechange=()=>{if(x.readyState===4)seen.push(t.labels(JSON.parse(x.responseText).n));};
        x.onload=()=>resolve({seen,load:t.labels(JSON.parse(x.responseText).n),isInstance:x instanceof XMLHttpRequest});
        x.onerror=reject;x.open('GET','/api');x.send();
      });
      const xhrJSON=await new Promise((resolve,reject)=>{
        const x=new XMLHttpRequest();x.open('GET','/api');x.responseType='json';
        x.onload=()=>{let throws=false;try{x.responseText;}catch{throws=true;}resolve({source:t.labels(x.response.n),throws});};x.onerror=reject;x.send();
      });
      const ordinary=await new Response('{"ismocking":true,"src":7}').json();
      return {url:response.url,text:t.raw(text),bodyUsed:response.bodyUsed,n:t.raw(json.n),s:t.raw(parsed.s),
        source:t.labels(json.n),parsedSource:t.labels(parsed.n),stream,parseThrows,bodyThrows,xhr,xhrJSON,
        DONE:XMLHttpRequest.DONE,ordinary};
    });
    assert.match(result.url,/\/api$/);
    assert.equal(result.text,'{"n":42,"flag":false,"s":"123"}');
    assert.equal(result.n,42);assert.equal(result.s,'123');
    assert.ok(result.stream && result.parseThrows && result.bodyThrows && result.bodyUsed);
    assert.deepEqual(result.source,result.parsedSource);
    assert.ok(result.xhr.seen[0][0].endsWith(':/n'));
    assert.deepEqual(result.xhr.seen[0],result.xhr.load);
    assert.ok(result.xhr.isInstance && result.xhrJSON.throws);
    assert.ok(result.xhrJSON.source[0].endsWith(':/n'));
    assert.equal(result.DONE,4);
    assert.deepEqual(result.ordinary,{ismocking:true,src:7});
  } finally {
    await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});
