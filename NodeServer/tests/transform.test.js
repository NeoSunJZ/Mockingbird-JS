const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const traverse = require('@babel/traverse').default;
const { parse, prepareScript, splitVariableDeclarations, wrapExpressionsAtPositions, getExpression, parseStack } = require('../tools/tools');
const createRuntime = require('../tools/runtime');
function run(source, transform = true) {
  const context = vm.createContext({});
  vm.runInContext(`globalThis.__mockingbird = (${createRuntime.toString()})(globalThis, {realmId:'test'});`, context);
  const code = transform ? prepareScript(source).code : source;
  return vm.runInContext(code, context);
}
function wrap(source, type) {
  const positions = new Set();
  traverse(parse(source), { [type](p) { positions.add(p.node.loc); } });
  return wrapExpressionsAtPositions(source, positions, 1);
}

test('formatting preserves compound receiver/key evaluation and export declarations', () => {
  const s = 'let calls=0,i=0; const a=[1,2]; function get(){calls++;return a;} get()[i++]+=2; JSON.stringify({calls,i,a});';
  assert.equal(run(splitVariableDeclarations(s), false), run(s, false));
  assert.doesNotThrow(() => splitVariableDeclarations('export const a=1,b=2; for(let x=0,y=1;x<1;x++){}'));
});
test('wrapping evaluates getters and methods once with dynamic this', () => {
  const s = 'let n=0; const obj={get x(){n++; return 2;}, m(){return this.x;}}; const out=obj.m()+obj.x; JSON.stringify([out,n]);';
  assert.equal(run(wrap(s, 'VariableDeclarator')), run(s));
});
test('short circuit, ternary, optional access and logical assignments retain branch order', () => {
  const s = 'let hits=0;const x=null;const a=x&&x.missing;const b=x?x.bad:7;const c=x?.missing;let d=0;d&&=++hits;d||=3;d??=++hits;JSON.stringify([a,b,c,d,hits]);';
  assert.equal(run(wrap(prepareScript(s).code, 'VariableDeclarator'), false), run(s, false));
});
test('compound assignment captures result, evaluates key conversion once and keeps target sourced', () => {
  const s = 'let hits=0; const obj={n:__mockingbird.source(2)};const key={toString(){hits++;return "n";}};obj[key]+=3;JSON.stringify([__mockingbird.raw(obj.n),hits,__mockingbird.labels(obj.n)]);';
  assert.equal(run(wrap(s, 'AssignmentExpression'), false), '[5,1,["test/response#1:"]]');
});
test('basic adapters preserve false branches, typeof, strict equality and switch selection', () => {
  const s = 'const data=__mockingbird.source({flag:false,n:0,s:""});let x=0;if(data.flag)x++;const a=data.flag?1:2;const b=data.n||7;const c=data.s&&9;let y;switch(data.n){case 0:y="zero";break;default:y="wrong";}JSON.stringify([x,a,b,c,typeof data.n,data.n===0,y]);';
  assert.equal(run(s), '[0,2,7,"","number",true,"zero"]');
  assert.equal(run('typeof notDeclared'), 'undefined');
  assert.throws(() => run('typeof x;let x=1'), /before initialization/);
  assert.equal(run('const x=new Boolean(false);if(x){"object truthy";}'), 'object truthy');
});
test('capture propagates operators, concise arrows and direct call arguments', () => {
  const s = 'const a=__mockingbird.source(1);const add=x=>x+1;const result=add(a);JSON.stringify(__mockingbird.labels(result));';
  const ast = parse(s);let node;
  traverse(ast, { BinaryExpression(p) { node=p.node; } });
  const found = getExpression(ast,s,{lineNumber:node.loc.start.line-1,columnNumber:node.loc.start.column});
  assert.equal(run(wrapExpressionsAtPositions(s,new Set(found.candidates)),false),'["test/response#1:"]');
  const direct = 'consume(data.n+1);';
  const result = getExpression(parse(direct),direct,{lineNumber:0,columnNumber:10});
  assert.equal(result.expression.type,'BinaryExpression');
});
test('destructuring is recognized and unsupported suspended expressions are reported', () => {
  const s='const {x,y}=data;';
  assert.equal(getExpression(parse(s),s,{lineNumber:0,columnNumber:14}).expression.type,'VariableDeclarator');
  const gaps=[];const asyncCode='async function f(){return await fetch("/api");}';
  const locs=new Set();traverse(parse(asyncCode),{ReturnStatement(p){locs.add(p.node.loc);}});
  const out=wrapExpressionsAtPositions(asyncCode,locs,0,g=>gaps.push(g));
  assert.ok(!out.includes('.capture'));
  assert.equal(gaps[0].reason,'suspended-expression');
});
test('stack parser handles anonymous URLs with ports and empty/missing stacks', () => {
  assert.deepEqual(parseStack('Error\n at http://localhost:4173/a.mjs?v=2:10:20\n at async fn (http://localhost:4173/b.vue:3:4)'),[
    {functionName:undefined,fileURL:'http://localhost:4173/a.mjs?v=2',line:10,column:20},
    {functionName:'async fn',fileURL:'http://localhost:4173/b.vue',line:3,column:4}
  ]);
  assert.deepEqual(parseStack(null),[]);
});
test('prefix/postfix updates preserve numeric conversion, reference side effects and provenance', () => {
  const s='let gets=0,keys=0,sets=0;let value=__mockingbird.source("2");const obj={get n(){gets++;return value;},set n(v){sets++;value=v;}};const key={toString(){keys++;return "n";}};const before=obj[key]++;const after=--obj[key];JSON.stringify([Number(before),Number(after),Number(value),gets,keys,sets,__mockingbird.labels(value)]);';
  assert.equal(run(wrap(s,'UpdateExpression'),false),'[2,2,2,2,2,2,["test/response#1:"]]');
  assert.equal(run(wrap('let n=1n;const a=n++;const b=++n;String(a)+":"+String(b)+":"+String(n);','UpdateExpression'),false),'1:3:3');
  assert.throws(()=>run(wrap('const n=1;n++;','UpdateExpression'),false),/constant variable/);
});
