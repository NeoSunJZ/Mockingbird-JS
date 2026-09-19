// Replay the user's saved Vite/Vue/Ant Design scripts without their old servers.
// Only HMR, API/asset URLs and the HTTP fixture are substituted; Vue/Ant modules
// and compiled application logic come from the saved original scripts.
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
const {runScenario}=require('../ede-killer');
async function main(){
 const directory=path.resolve(process.argv[2] || 'logs/test-1789488685964');
 const manifest=JSON.parse(await fs.readFile(path.join(directory,'summary.json'),'utf8'));
 const resources=new Map(await Promise.all(manifest.scripts.map(async record=>[
   new URL(record.url).pathname,await fs.readFile(path.join(directory,'src',`${record.id}.original.js`),'utf8')])));
 let base;
 const server=http.createServer((req,res)=>{
   const url=new URL(req.url,base);
   if(url.pathname==='/test/getUserInfo'){
     res.setHeader('content-type','application/json');res.end(JSON.stringify({userID:'0001',name:'mockingBrid',
       tags:[{color:'blue',content:'tab A',type:'normal'},{color:'green',content:'tab b',type:'normal'}],password:null,
       experience:100000,avatar:base+'/avatar.svg',authority:['admin','user','super_admin'],LastLoginTime:1716121099999,
       RegisterTime:1716121000000,personalSignature:'default signature'}));return;
   }
   if(url.pathname==='/avatar.svg'){res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="blue"/></svg>');return;}
   if(url.pathname==='/@vite/client'){
     res.setHeader('content-type','application/javascript');res.end('export function createHotContext(){return {accept(){},prune(){},on(){},off(){},invalidate(){},data:{}}} const styles=new Map();export function updateStyle(id,text){let s=styles.get(id);if(!s){s=document.createElement("style");styles.set(id,s);document.head.appendChild(s);}s.textContent=text;}export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}export function injectQuery(url){return url;}');return;
   }
   if(resources.has(url.pathname)){
     res.setHeader('content-type','application/javascript');
     res.end(resources.get(url.pathname).replaceAll('http://127.0.0.1:5000',base));return;
   }
   if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><title>Vite App</title></head><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>');return;}
   res.writeHead(404);res.end('not in snapshot');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
 const output=path.resolve('logs',`demo-snapshot-${Date.now()}`);
 try {
   const result=await runScenario({targetAPI:'/test/getUserInfo?userID=0001',commands:[`LOAD ${base}/`,"CLICK //button[contains(., 'get login message')]"]},
     {headless:true,output,maxRounds:12,quietMs:300,settleTimeout:10000});
   const gapCounts={};for(const g of result.gaps)gapCounts[g.reason]=(gapCounts[g.reason]||0)+1;
   console.log(JSON.stringify({status:result.status,reason:result.reason,output,cycles:result.cycles.map(c=>({round:c.round,matches:c.matchesBaseline,errors:c.errors,changes:c.changedScripts})),gapCounts},null,2));
   assert.notEqual(result.status,'failed');assert.notEqual(result.reason,'max-rounds');
   assert.ok(result.cycles.length>=2);assert.ok(result.cycles.every(c=>c.matchesBaseline===true && !c.errors.length));
   assert.ok(result.cycles.at(-1).snapshot.text.includes('mockingBrid(super_admin)'));
   assert.ok(result.cycles.at(-1).snapshot.text.includes('rank: 666'));
   const cycles=await Promise.all(result.cycles.filter(c=>c.round>=0).map(c=>fs.readFile(path.join(output,`cycle-${c.round}.jsonl`),'utf8')));
   const events=cycles.flatMap(s=>s.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
   for(const field of ['name','experience','LastLoginTime','personalSignature','tags/0/content','tags/1/content'])
     assert.ok(events.some(e=>e.kind==='sink'&&e.from.some(from=>from.endsWith(':/'+field))),`missing sink for ${field}`);
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
