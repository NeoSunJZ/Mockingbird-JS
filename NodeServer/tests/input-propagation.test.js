const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const traverse=require('@babel/traverse').default;
const {parse,prepareScript,getExpression,wrapExpressionsAtPositions}=require('../tools/tools');
const createRuntime=require('../tools/runtime');
function execute(source,types=['VariableDeclarator','AssignmentExpression','ReturnStatement','UpdateExpression']) {
 const prepared=prepareScript(source).code;
 const positions=new Set();traverse(parse(prepared),{enter(p){if(types.includes(p.node.type))positions.add(p.node.loc);}});
 const gaps=[];const code=wrapExpressionsAtPositions(prepared,positions,1,g=>gaps.push(g));
 const context=vm.createContext({});
 vm.runInContext(`globalThis.__mockingbird=(${createRuntime.toString()})(globalThis,{realmId:'test'});`,context);
 return {value:vm.runInContext(code,context),gaps,code};
}
test('nested b+c++ preserves old result, updates c, and records both dependencies',()=>{
 const source='let b=__mockingbird.source(10),c=__mockingbird.source(2);let a=b+c++;JSON.stringify([Number(a),Number(c),__mockingbird.labels(a),__mockingbird.labels(c)]);';
 assert.equal(execute(source).value,'[12,3,["test/response#1:","test/response#2:"],["test/response#2:"]]');
});
test('unrelated reads and discarded sequence values do not taint returns',()=>{
 const source='const data=__mockingbird.source({n:2});function f(){Number(data.n);return 123;}const x=f();const y=(Number(data.n),0);JSON.stringify([x,y,__mockingbird.labels(x),__mockingbird.labels(y)]);';
 assert.equal(execute(source).value,'[123,0,[],[]]');
 const t=createRuntime({});const p=t.source(1);
 assert.equal(t.capture(()=>{Number(p);return 0;},'legacy'),0);
});
test('a shared function taints only calls with tracked inputs, including nested calls',()=>{
 const source='const data=__mockingbird.source(2);function inner(x){return x+1;}function f(x){return inner(x)*2;}const a=f(data);const b=f(0);JSON.stringify([Number(a),b,__mockingbird.labels(a),__mockingbird.labels(b)]);';
 assert.equal(execute(source).value,'[6,2,["test/response#1:"],[]]');
});
test('derived object fields do not contaminate constants, caches, methods or sibling fields',()=>{
 const source='const data=__mockingbird.source({name:"Alice",n:2});const view={title:String(data.name),score:data.n+1,clean:0,cache:new WeakMap(),method(){return 7;}};const key={};view.cache.set(key,9);JSON.stringify([String(view.title),Number(view.score),view.cache.get(key),view.method(),__mockingbird.labels(view.clean),__mockingbird.labels(view.cache),__mockingbird.labels(view.title),__mockingbird.labels(view.score)]);';
 assert.equal(execute(source).value,'["Alice",3,9,7,[],[],["test/response#1:/name"],["test/response#1:/n"]]');
});
test('WeakMap and WeakSet keep native receivers and object key identity',()=>{
 const t=createRuntime({});const p=t.source(2),key=t.source({x:1}),plain={};
 const map=t.varProxy(new WeakMap(),1,p);map.set(key,p);map.set(plain,7);
 assert.equal(map.get(key),p);assert.equal(map.get(plain),7);assert.equal(map.get(t.raw(key)),undefined);
 const set=t.varProxy(new WeakSet(),1,p);set.add(key);assert.equal(t.raw(set.has(key)),true);
});
test('getters, method lookup, receiver and template coercions preserve evaluation order',()=>{
 const source='let log="";const obj={get m(){log+="m";return function(x){log+="c";return this.v+x;}},v:2};function arg(){log+="a";return 3;}const out=obj.m(arg());const a={toString(){log+="s";return "A";}};const text=`${a}${(log+="b","B")}`;JSON.stringify([out,text,log]);';
 const baseline=vm.runInNewContext(source);
 assert.equal(execute(source).value,baseline);
});
test('unselected branches and constants do not inherit condition provenance',()=>{
 const source='const flag=__mockingbird.source(false);let hits=0;const v=flag?(++hits):7;const x=flag&&(++hits);JSON.stringify([v,hits,__mockingbird.labels(v),__mockingbird.labels(x)]);';
 assert.equal(execute(source).value,'[7,0,[],["test/response#1:"]]');
});
test('multiple observed locations do not double transform a nested update',()=>{
 const source='let a=b+c++;';const ast=parse(source);
 const found=getExpression(ast,source,{lineNumber:0,columnNumber:source.indexOf('c++')});
 const code=wrapExpressionsAtPositions(source,new Set(found.candidates),1);
 assert.equal((code.match(/\.step\(/g)||[]).length,1);
});
test('destructuring defaults retain field-specific dependencies and laziness',()=>{
 const s='const data=__mockingbird.source({n:2});let hits=0;const {a=data.n+1,b=(++hits)}={b:0};JSON.stringify([Number(a),b,hits,__mockingbird.labels(a)]);';
 const prepared=prepareScript(s).code;const ast=parse(prepared);let location;
 traverse(ast,{AssignmentPattern(p){if(p.node.left.name==='a')location=p.node.right.loc;}});
 const selected=getExpression(ast,prepared,{lineNumber:location.start.line-1,columnNumber:location.start.column});
 assert.ok(selected.uses.some(u=>u.role==='default'));
 const code=wrapExpressionsAtPositions(prepared,new Set(selected.candidates));
 const context=vm.createContext({});vm.runInContext(`globalThis.__mockingbird=(${createRuntime.toString()})(globalThis,{realmId:'test'});`,context);
 assert.equal(vm.runInContext(code,context),'[3,0,0,["test/response#1:/n"]]');
});
test('deferred async methods do not block an unrelated object property initializer',()=>{
 const s='const data=__mockingbird.source(2);const view={n:data+1,async load(){await 0;}};JSON.stringify([Number(view.n),__mockingbird.labels(view.n)]);';
 const result=execute(s);assert.equal(result.value,'[3,["test/response#1:"]]');
 assert.ok(!result.gaps.some(g=>g.reason==='suspended-expression'));
});
test('discarded call outputs do not produce nullish propagation gaps',()=>{
 const s='function consume(x){}const data=__mockingbird.source(2);consume(data);__mockingbird.events.some(e=>e.kind==="gap"&&e.reason==="nullish-propagation");';
 assert.equal(execute(s,['CallExpression']).value,false);
});
test('container siblings do not contaminate unrelated method results or static key names',()=>{
 const s='const data=__mockingbird.source(2);const obj={value:data,method(x){return x+1;}};const n=obj.method(0);const keys=Object.keys(obj);JSON.stringify([n,__mockingbird.labels(n),__mockingbird.labels(keys),__mockingbird.labels(keys[0])]);';
 assert.equal(execute(s).value,'[1,[],[],[]]');
});
test('methods that actually read this fields still propagate through their return',()=>{
 const s='const data=__mockingbird.source(2);const obj={value:data,method(){return this.value+1;}};const n=obj.method();JSON.stringify([Number(n),__mockingbird.labels(n)]);';
 assert.equal(execute(s).value,'[3,["test/response#1:"]]');
});
