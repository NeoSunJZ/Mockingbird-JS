const test=require('node:test');
const assert=require('node:assert/strict');
const {parse,getExpression}=require('../tools/tools');
const at=(code,fragment)=>getExpression(parse(code),code,{lineNumber:0,columnNumber:code.indexOf(fragment)});
test('nested update and declaration are independent destinations, with full statement context',()=>{
 const r=at('let a = b + c++;','c++');
 assert.deepEqual(r.expressions.map(x=>x.type),['UpdateExpression','VariableDeclarator']);
 assert.equal(r.statement.code,'let a = b + c++;');assert.equal(r.candidates.length,2);
});
test('assignment and enclosing condition are both recorded without confusing body reads',()=>{
 const r=at('if ((x = data.n + 1) > 3) work(x);','data.n');
 assert.equal(r.expression.type,'AssignmentExpression');assert.ok(r.uses.some(x=>x.role==='control'));
 assert.equal(r.statement.type,'IfStatement');assert.equal(r.statement.isController,true);
 const body=at('if (ok) { const x = data.n + 1; }','data.n');
 assert.equal(body.statement.type,'VariableDeclaration');assert.ok(!body.uses.some(x=>x.role==='control'));
 assert.ok(body.statements.some(x=>x.type==='IfStatement'));
});
test('switch discriminant/case tests and for slots have explicit roles',()=>{
 assert.ok(at('switch(data.n){case 1:break;}','data.n').uses.some(x=>x.role==='control'));
 assert.ok(at('switch(x){case data.n:break;}','data.n').uses.some(x=>x.role==='control'));
 assert.ok(at('for(let i=data.n;i<5;i++){}','data.n').uses.some(x=>x.role==='loop-init'));
 assert.ok(!at('for(let i=data.n;i<5;i++){}','data.n').uses.some(x=>x.role==='control'));
 assert.ok(at('for(const x of data.items){}','data.items').uses.some(x=>x.role==='iteration'));
});
test('discarded arithmetic is not a candidate, calls/returns/export are destinations',()=>{
 assert.equal(at('data.n + 1;','data.n').candidates.length,0);
 assert.equal(at('consume(data.n + 1);','data.n').expression.type,'CallExpression');
 assert.equal(at('export default data.n + 1;','data.n').expression.type,'ExportDefaultDeclaration');
 assert.equal(at('function f(){throw data.n;}','data.n').expression.type,'ThrowStatement');
});
test('instrumented expression is handled, but its deferred callback is still analyzed',()=>{
 const r=at('const a=globalThis.__mockingbird.result(data.n+1,"s");','data.n');
 assert.equal(r.candidates.length,0);assert.ok(r.statements.length);
 const callback=at('const a=globalThis.__mockingbird.result(()=>data.n+1,"s");','data.n');
 assert.equal(callback.candidates.length,1);assert.equal(callback.expressions[0].role,'return');
});
