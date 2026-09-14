const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const esbuild=require('esbuild');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {runScenario}=require('../../ede-killer');

for (const framework of ['react','vue']) test(`${framework} preserves rendering and reaches DOM sinks through the iterative runner`,async()=>{
  const bundle=framework==='vue' ? await fs.readFile(require.resolve('vue/dist/vue.runtime.global.prod.js'),'utf8')
    : esbuild.buildSync({stdin:{contents:'import {createElement} from "react";import {createRoot} from "react-dom/client";import {flushSync} from "react-dom";window.R={createElement,createRoot,flushSync};',resolveDir:process.cwd()},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
  const app=framework==='vue'
    ? 'const data=await(await fetch("/api")).json();const state=Vue.reactive(data);Vue.createApp({setup(){return ()=>Vue.h("div",null,[Vue.h("span",null,state.name),Vue.h("span",null,state.n),Vue.h("span",null,state.flag?"YES":"NO"),Vue.h("button",{onClick(){state.n++;}},"inc")]);}}).mount("#app");'
    : 'const data=await(await fetch("/api")).json();const root=R.createRoot(document.querySelector("#app"));const draw=()=>R.flushSync(()=>root.render(R.createElement("div",null,R.createElement("span",null,data.name),R.createElement("span",null,data.n),R.createElement("span",null,data.flag?"YES":"NO"),R.createElement("button",{onClick(){data.n++;draw();}},"inc"))));draw();';
  const server=http.createServer((req,res)=>{
    if(req.url==='/api'){res.setHeader('content-type','application/json');res.end('{"name":"Alice","n":42,"flag":false}');return;}
    if(req.url==='/framework.js' || req.url==='/app.mjs'){res.setHeader('content-type','application/javascript');res.end(req.url==='/framework.js'?bundle:app);return;}
    res.end('<!doctype html><div id="app"></div><script src="/framework.js"></script><script type="module" src="/app.mjs"></script>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const output=await fs.mkdtemp(path.join(os.tmpdir(),`mockingbird-${framework}-`));
  try {
    const url=`http://127.0.0.1:${server.address().port}`;
    const result=await runScenario({targetAPI:'/api',commands:[`LOAD ${url}`,'CLICK //button']},
      {chromium,headless:true,output,maxRounds:12,quietMs:120,settleTimeout:2500});
    assert.notEqual(result.status,'failed',`See ${output}: ${result.reason}`);
    assert.ok(result.cycles.every(c=>c.matchesBaseline!==false),`Behavior divergence; see ${output}`);
    assert.notEqual(result.reason,'max-rounds',`Did not converge; see ${output}`);
    assert.equal(result.cycles.at(-1).snapshot.text,'Alice43NOinc');
    const files=(await fs.readdir(output)).filter(f=>/^cycle-\d+\.jsonl$/.test(f));
    const events=(await Promise.all(files.map(f=>fs.readFile(path.join(output,f),'utf8')))).flatMap(s=>s.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
    for(const field of ['name','n']) assert.ok(events.some(e=>e.kind==='sink' && e.from.some(s=>s.endsWith(`:/${field}`))),`Missing ${field} DOM sink; see ${output}`);
    console.log(`${framework}: ${result.status}, ${result.cycles.length-1} traced rounds; evidence ${output}`);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
