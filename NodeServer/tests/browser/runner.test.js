const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {runScenario}=require('../../ede-killer');

test('full runner performs baseline, rewrites mjs and converges without repeating side effects',async()=>{
  const server=http.createServer((req,res)=>{
    if(req.url==='/api'){res.setHeader('content-type','application/json');res.end('{"n":2,"flag":false}');return;}
    if(req.url==='/app.mjs'){
      res.setHeader('content-type','application/javascript');
      res.end('const data=await (await fetch("/api")).json();let count=0;const value={get n(){count++;return data.n;}};const derived=value.n+1;document.querySelector("#app").textContent=(data.flag?"bad":"ok")+":"+derived+":"+count;');return;
    }
    res.end('<!doctype html><div id="app"></div><script type="module" src="/app.mjs"></script>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const output=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-run-'));
  try {
    const url=`http://127.0.0.1:${server.address().port}`;
    const result=await runScenario({targetAPI:'/api',commands:[`LOAD ${url}`,'WAIT_FOR_FUNCTION document.querySelector("#app").textContent === "ok:3:1"']},
      {chromium,headless:true,output,maxRounds:6,quietMs:80,settleTimeout:1500});
    assert.equal(result.status,'converged',JSON.stringify(result));
    assert.notEqual(result.reason,'max-rounds',JSON.stringify(result));
    assert.ok(result.cycles.every(c=>c.matchesBaseline!==false),JSON.stringify(result));
    assert.ok(result.cycles.length>=3,JSON.stringify(result));
    assert.ok(result.scripts[0].generation>0);
    assert.ok((await fs.readdir(output)).includes('summary.json'));
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
