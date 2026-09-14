const fs = require('node:fs/promises');
const path = require('node:path');
const playwright = require('playwright');
const injectedFunction = require('./tools/injected');
const { executeCommands } = require('./tools/command');
const { ScriptStore } = require('./tools/scripts');
const { interceptPage } = require('./tools/intercept');

function parseConfig(text) {
  let targetAPI;
  const commands=[];
  for (const raw of text.split(/\r?\n/)) {
    const line=raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match=/^TARGET\s+(.+)$/i.exec(line);
    if (match) {
      if (targetAPI) throw new Error('Config must contain exactly one TARGET');
      targetAPI=match[1].trim();
    } else commands.push(line);
  }
  if (!targetAPI) throw new Error('Config is missing TARGET');
  if (!commands.some(c=>/^LOAD\s+/i.test(c))) throw new Error('Config is missing LOAD');
  return {targetAPI,commands};
}
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function snapshot(page) {
  return page.evaluate(()=>({url:location.href,title:document.title,text:document.body?.textContent || '',
    controls:[...document.querySelectorAll('input,select,textarea')].map(e=>({tag:e.tagName,type:e.type,value:e.value,checked:e.checked}))}));
}
async function runScenario(config, options = {}) {
  if (options.browserName && options.browserName !== 'chromium') throw new Error('This runner currently supports Chromium only');
  const output = options.output || path.join(__dirname,'logs',`run-${Date.now()}`);
  await fs.mkdir(output,{recursive:true});
  const logs=[];
  let round=-1, sequence=0, lastEvent=Date.now(), sourceCount=0;
  const report = event => { lastEvent=Date.now(); logs.push({recordSequence:++sequence,timestamp:Date.now(),cycle:round,...event}); };
  const store = new ScriptStore(path.join(output,'src'),report);
  const browser = await (options.chromium || playwright.chromium).launch({headless:options.headless ?? false,
    ...(options.executablePath ? {executablePath:options.executablePath} : {})});
  const summary={status:'running',output,cycles:[],limitations:['Only the configured scenario and observation interval are checked.','Inline/eval/worker code is not rewritten.']};
  let baseline;
  try {
    for (round = options.baseline === false ? 0 : -1; round < (options.maxRounds ?? 20); round++) {
      sourceCount=0;
      const start=logs.length;
      const errors=[];
      const context=await browser.newContext({serviceWorkers:'block',...(options.storageState ? {storageState:options.storageState} : {})});
      const tasks=new Set();
      let targetResponses=0;
      function task(promise) { tasks.add(promise); promise.finally(()=>tasks.delete(promise)).catch(()=>{}); return promise; }
      try {
        if (round>=0) {
          await context.exposeBinding('reportLog',(source,event)=>{
            const enriched={...event,frameURL:source.frame.url()};
            report(enriched);
            if (event.kind==='source') sourceCount++;
            store.observe(enriched);
          });
          await context.addInitScript(injectedFunction,{targetAPI:config.targetAPI,round,eventLimit:options.eventLimit});
        }
        const pageReady=new WeakMap();
        context.on('page',page=>{
          if(round>=0) pageReady.set(page,task(interceptPage(context,page,store,report,task)));
          page.on('pageerror',error=>{errors.push(error.message);report({kind:'pageerror',message:error.message,stack:error.stack});});
          page.on('requestfailed',request=>report({kind:'requestfailed',url:request.url(),failure:request.failure()}));
          page.on('response',response=>{if(response.url().includes(config.targetAPI)){targetResponses++;lastEvent=Date.now();}});
          page.on('worker',worker=>report({kind:'gap',reason:'worker',url:worker.url()}));
        });
        let page=await context.newPage();
        await pageReady.get(page);
        page=await executeCommands(page,config.commands,{onResult:result=>report({kind:'command-result',...result}),onPage:next=>pageReady.get(next)});
        const deadline=Date.now()+(options.settleTimeout ?? 10000);
        let settled=false;
        while (Date.now()<deadline) {
          await delay(25);
          if (tasks.size) continue;
          if (Date.now()-lastEvent >= (options.quietMs ?? 300) && targetResponses>0 && (round<0 || sourceCount>0)) {settled=true;break;}
        }
        for (const current of context.pages()) for (const frame of current.frames()) {
          if (round>=0) {
            const flush=await frame.evaluate(()=>globalThis.__mockingbird?.flush()).catch(error=>({failures:[error.message]}));
            for (const failure of flush?.failures || []) report({kind:'gap',reason:'runtime-flush',message:failure});
          }
        }
        await Promise.all([...tasks]);
        const observed=await snapshot(page);
        if (round<0) baseline=observed;
        const matchesBaseline=baseline ? JSON.stringify(observed)===JSON.stringify(baseline) : null;
        const cycle={round,settled,targetResponses,sourceCount,errors,matchesBaseline,snapshot:observed};
        summary.cycles.push(cycle);
        if (round<0) {
          if (!settled || errors.length) throw new Error('Baseline scenario failed or did not observe the target response');
          continue;
        }
        if (!settled || errors.length || matchesBaseline===false) {
          summary.status='incomplete';
          summary.reason=matchesBaseline===false ? 'behavior-diverged' : errors.length ? 'page-errors' : 'observation-timeout';
          break;
        }
        const changes=await store.advance(round+1);
        cycle.changedScripts=changes;
        if (!changes) {
          summary.status=logs.some(e=>e.kind==='gap') ? 'incomplete' : 'converged';
          summary.reason='no-new-supported-sites';
          break;
        }
      } finally {
        // Closing the context stops late timers before the final log snapshot.
        await context.close();
        await Promise.allSettled([...tasks]);
        await fs.writeFile(path.join(output,`cycle-${round}.jsonl`),logs.slice(start).map(e=>JSON.stringify(e)).join('\n')+'\n');
      }
    }
    if (summary.status==='running') {summary.status='incomplete';summary.reason='max-rounds';}
  } catch (error) {
    summary.status='failed';summary.reason=error.message;
  } finally {
    await browser.close();
    summary.scripts=store.manifest();
    summary.gaps=logs.filter(e=>e.kind==='gap');
    await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));
  }
  return summary;
}

async function main() {
  const name=process.argv[2];
  if (!name) throw new Error('Usage: node ede-killer.js <config-name-or-path>');
  const filename=name.endsWith('.config') ? path.resolve(name) : path.join(__dirname,'configs',`${name}.config`);
  const config=parseConfig(await fs.readFile(filename,'utf8'));
  const summary=await runScenario(config,{browserName:process.env.BROWSER,executablePath:process.env.BROWSER_PATH,
    headless:process.env.HEADLESS==='1',output:path.join(__dirname,'logs',`${path.basename(filename,'.config')}-${Date.now()}`)});
  console.log(`${summary.status}: ${summary.reason}. Results: ${summary.output}`);
  if(summary.status!=='converged') process.exitCode=1;
}
if(require.main===module) main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={parseConfig,runScenario};
