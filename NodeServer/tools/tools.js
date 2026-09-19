const fsp = require('node:fs/promises');
const path = require('node:path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generator = require('@babel/generator').default;
const t = require('@babel/types');

const parse = source => parser.parse(source, { sourceType: 'unambiguous', plugins: ['jsx'], ranges: true });
const print = ast => generator(ast, { comments: true }).code;
const runtime = method => t.memberExpression(t.memberExpression(t.identifier('globalThis'), t.identifier('__mockingbird')), t.identifier(method));
const call = (method, args) => t.callExpression(runtime(method), args);
function isHelper(node, method) {
  return t.isCallExpression(node) && t.isMemberExpression(node.callee) &&
    t.isMemberExpression(node.callee.object) && t.isIdentifier(node.callee.object.object, { name: 'globalThis' }) &&
    t.isIdentifier(node.callee.object.property, { name: '__mockingbird' }) &&
    (!method || t.isIdentifier(node.callee.property, { name: method }));
}
function temp(p) {
  const id = p.scope.generateUidIdentifier('mb');
  p.scope.push({ id: t.cloneNode(id), kind: 'var' });
  return id;
}
const assign = (left, right) => t.assignmentExpression('=', t.cloneNode(left), right);
const contains = (node, line, column) => node.loc &&
  (line > node.loc.start.line || line === node.loc.start.line && column >= node.loc.start.column) &&
  (line < node.loc.end.line || line === node.loc.end.line && column < node.loc.end.column);
const locationKey = loc => `${loc.start.index}:${loc.end.index}`;

async function saveToFile(content, filename, type = 'new', filepath = __dirname) {
  if (!['new', 'add'].includes(type)) throw new Error(`Invalid save mode: ${type}`);
  await fsp.mkdir(filepath, { recursive: true });
  await fsp[type === 'add' ? 'appendFile' : 'writeFile'](path.join(filepath, filename), content, 'utf8');
}

// Compatibility name. Formatting must not duplicate assignment references or
// split declarations inside export / for initializers.
function splitVariableDeclarations(source) { return print(parse(source)); }

function unsafeReason(node) {
  let reason;
  function visit(child) {
    if (!child || t.isFunction(child) || t.isClass(child)) return;
    if (t.isAwaitExpression(child) || t.isYieldExpression(child)) reason = 'suspended-expression';
    if (t.isCallExpression(child) && t.isIdentifier(child.callee, { name: 'eval' })) reason = 'direct-eval';
    for (const key of t.VISITOR_KEYS[child.type] || []) {
      const value=child[key];
      if (Array.isArray(value)) value.forEach(visit); else visit(value);
    }
  }
  visit(node);
  return reason;
}

// First-pass semantic protection is independent of iterative propagation sites.
// It only unwraps our own boxes; business-created Number/Boolean objects stay objects.
function prepareScript(source) {
  const ast = parse(source);
  const gaps = [];
  traverse(ast, {
    Program(p) {
      if (p.scope.hasBinding('globalThis', { noGlobals: true })) throw new Error('Reserved runtime binding globalThis is shadowed');
    },
    enter(p) {
      if (p.isScope() && p.scope.hasOwnBinding('globalThis')) throw new Error('Reserved runtime binding globalThis is shadowed');
      if (isHelper(p.node)) p.skip();
    },
    'IfStatement|WhileStatement|DoWhileStatement|ForStatement|ConditionalExpression': {
      exit(p) { if (p.node.test) p.node.test = call('condition', [p.node.test]); }
    },
    CallExpression: {
      exit(p) {
        const n = p.node;
        if (t.isIdentifier(n.callee, {name:'eval'}) && !p.scope.getBinding('eval')) {
          p.replaceWith(t.sequenceExpression([call('gap',[t.stringLiteral('direct-eval')]),n]));
          p.skip(); return;
        }
        if (t.isIdentifier(n.callee, {name:'Function'}) && !p.scope.getBinding('Function')) {
          p.replaceWith(t.sequenceExpression([call('gap',[t.stringLiteral('dynamic-function')]),n]));
          p.skip(); return;
        }
        if (t.isIdentifier(n.callee) && ['Boolean', 'Number', 'String', 'BigInt'].includes(n.callee.name) && !p.scope.getBinding(n.callee.name)) {
          p.replaceWith(call('builtin', [n.callee, t.unaryExpression('void', t.numericLiteral(0)), t.arrayExpression(n.arguments)]));
          p.skip();
        } else if (t.isMemberExpression(n.callee) && !n.callee.computed && t.isIdentifier(n.callee.object, {name:'Object'}) &&
          t.isIdentifier(n.callee.property, {name:'is'}) && !p.scope.getBinding('Object')) {
          const receiver = temp(p);
          p.replaceWith(t.sequenceExpression([assign(receiver,n.callee.object),call('builtin',[
            t.memberExpression(t.cloneNode(receiver),t.identifier('is')),t.cloneNode(receiver),t.arrayExpression(n.arguments)])]));
          p.skip();
        }
      }
    },
    NewExpression: {
      exit(p) {
        if (t.isIdentifier(p.node.callee, {name:'Function'}) && !p.scope.getBinding('Function')) {
          p.replaceWith(t.sequenceExpression([call('gap',[t.stringLiteral('dynamic-function')]),p.node]));
          p.skip();
        }
      }
    },
    UnaryExpression: {
      exit(p) {
        const n = p.node;
        if (n.operator === '!') n.argument = call('raw', [n.argument]);
        if (n.operator === 'typeof') {
          // Keep typeof unresolvableReference and TDZ semantics. A global
          // accessor must never be read a second time merely to inspect it.
          if (!t.isIdentifier(n.argument) || p.scope.getBinding(n.argument.name)) n.argument = call('raw', [n.argument]);
          else gaps.push({ reason: 'unbound-typeof', location: n.loc });
        }
      }
    },
    BinaryExpression: {
      exit(p) {
        if (['===', '!==', '==', '!='].includes(p.node.operator)) {
          p.node.left = call('raw', [p.node.left]);
          p.node.right = call('raw', [p.node.right]);
        }
      }
    },
    SwitchStatement: { exit(p) { p.node.discriminant = call('controlValue', [p.node.discriminant]); } },
    SwitchCase: { exit(p) { if (p.node.test) p.node.test = call('controlValue', [p.node.test]); } },
    LogicalExpression: {
      exit(p) {
        const n = p.node;
        const saved = temp(p);
        const test = n.operator === '??'
          ? t.binaryExpression('==', call('raw', [t.cloneNode(saved)]), t.nullLiteral())
          : call('condition', [t.cloneNode(saved)]);
        const yes = n.operator === '||' ? t.cloneNode(saved) : n.right;
        const no = n.operator === '||' ? n.right : t.cloneNode(saved);
        p.replaceWith(t.sequenceExpression([assign(saved, n.left), t.conditionalExpression(test, yes, no)]));
        p.skip();
      }
    },
    AssignmentExpression: {
      exit(p) {
        if (!['&&=', '||=', '??='].includes(p.node.operator)) return;
        const n = p.node;
        const { prefix, ref } = reference(p, n.left);
        const saved = temp(p);
        const test = n.operator === '??='
          ? t.binaryExpression('==', call('raw', [t.cloneNode(saved)]), t.nullLiteral())
          : call('condition', [t.cloneNode(saved)]);
        const write = assign(ref, n.right);
        p.replaceWith(t.sequenceExpression([...prefix, assign(saved, t.cloneNode(ref)),
          t.conditionalExpression(test, n.operator === '||=' ? t.cloneNode(saved) : write,
            n.operator === '||=' ? write : t.cloneNode(saved))]));
        p.skip();
      }
    }
  });
  return { code: print(ast), gaps };
}

function reference(p, left) {
  if (t.isIdentifier(left)) return { prefix: [], ref: left };
  if (!t.isMemberExpression(left) || t.isSuper(left.object) || t.isPrivateName(left.property)) {
    throw new Error('Unsupported assignment reference');
  }
  const object = temp(p);
  const prefix = [assign(object, left.object)];
  let key = left.property;
  if (left.computed) {
    key = temp(p);
    prefix.push(assign(key, call('key', [left.property])));
  }
  return { prefix, ref: t.memberExpression(t.cloneNode(object), t.cloneNode(key), left.computed) };
}

function describe(node, source) {
  if (!node) return null;
  return { type: node.type, code: source.slice(node.start, node.end), position: node.loc,
    left: t.isVariableDeclarator(node) ? print(node.id) : t.isAssignmentExpression(node) ? print(node.left) : null,
    node };
}
// Locations follow CDP: zero-based line/column, exclusive end offsets.
// Collect value destinations and context independently: c++ and a's initializer
// both matter in `let a = b + c++`; an enclosing block is not a condition use.
function getExpression(ast, source, location) {
  const line = location.lineNumber + 1, column = location.columnNumber;
  let leaf;
  traverse(ast, { enter(p) {
    if (contains(p.node, line, column)) leaf = p;
    else p.skip();
  } });
  const expressions = [], statements = [], uses = [], candidates = [];
  let update = null, handled = false;
  const add = (p, role) => {
    const item = { ...describe(p.node, source), role };
    if (!expressions.some(item => item.node === p.node)) expressions.push(item);
    uses.push({ role, type: p.node.type, position: p.node.loc });
    if (!handled && !candidates.some(loc => locationKey(loc) === locationKey(p.node.loc))) candidates.push(p.node.loc);
  };
  const slot = (p, key, role) => {
    const node = p.node[key];
    if (node && contains(node, line, column)) uses.push({role, type:p.node.type, position:node.loc});
  };
  // A result marker covers one evaluated expression, not nested callback bodies.
  for (let p = leaf; p && !p.isProgram(); p = p.parentPath) {
    if (p.isFunction()) {
      if (isHelper(p.parentPath?.node, 'capture')) handled = true;
      break;
    }
    if (isHelper(p.node, 'result') || isHelper(p.node, 'capture') || isHelper(p.node, 'step')) { handled = true; break; }
  }
  for (let p = leaf; p && !p.isProgram(); p = p.parentPath) {
    if (p.isFunction()) break;
    if (p.isStatement()) statements.push(describe(p.node, source));
    if (p.isUpdateExpression()) { update = describe(p.node, source); add(p, 'update'); }
    else if (p.isAssignmentExpression()) add(p, 'write');
    else if (p.isVariableDeclarator() && p.node.init && contains(p.node.init, line, column)) add(p, 'binding');
    else if ((p.isReturnStatement() || p.isThrowStatement()) && p.node.argument) add(p, p.isReturnStatement() ? 'return' : 'throw');
    else if (p.isExportDefaultDeclaration() && t.isExpression(p.node.declaration)) add(p, 'export');
    else if ((p.isCallExpression() || p.isOptionalCallExpression() || p.isNewExpression() || p.isTaggedTemplateExpression()) && !isHelper(p.node)) add(p, 'call');
    if (p.isAssignmentPattern()) {
      slot(p,'right','default');
      if(contains(p.node.right,line,column)) add(p.get('right'),'default');
    }
    if (p.parentPath?.isArrowFunctionExpression() && p.key === 'body' && p.isExpression()) add(p, 'return');
    if (p.isIfStatement() || p.isWhileStatement() || p.isDoWhileStatement() || p.isForStatement() || p.isConditionalExpression()) slot(p, 'test', 'control');
    if (p.isSwitchStatement()) slot(p, 'discriminant', 'control');
    if (p.isSwitchCase()) slot(p, 'test', 'control');
    if (p.isForStatement()) { slot(p, 'init', 'loop-init'); slot(p, 'update', 'loop-update'); }
    if (p.isForInStatement() || p.isForOfStatement()) slot(p, 'right', p.isForInStatement() ? 'keys' : 'iteration');
    if (p.isLogicalExpression()) slot(p, 'left', 'control');
    if (p.isWithStatement()) slot(p, 'object', 'dynamic-scope');
    if (p.isMemberExpression() || p.isOptionalMemberExpression()) {
      slot(p, 'object', 'member-base');
      if (p.node.computed) slot(p, 'property', 'member-key');
    }
    if (p.isAwaitExpression() || p.isYieldExpression()) slot(p, 'argument', 'suspend');
  }
  const statement = statements.find(item => item.type !== 'BlockStatement') || statements[0] || null;
  for (const item of statements) item.isController = uses.some(use => use.role === 'control' &&
    (item.node.test === undefined ? item.type === 'SwitchStatement' && (contains(item.node.discriminant, line, column) || item.node.cases.some(c => c.test && contains(c.test, line, column))) : contains(item.node.test, line, column)) &&
    ['IfStatement','WhileStatement','DoWhileStatement','ForStatement','SwitchStatement'].includes(item.type));
  return { expression: expressions[0] || null, statement, update, expressions, statements, uses, candidates, handled };
}

// Only compile observed value destinations. Dependencies are the operands that
// actually execute, saved before coercion; unrelated reads never enter a frame.
function instrumentExpression(node, p, onGap, valueNeeded = true) {
  const site = t.stringLiteral(`${node.start ?? 'generated'}:${node.end ?? 'generated'}`);
  const c = (n, needed = true) => instrumentExpression(n, p, onGap, needed);
  const operand = n => isHelper(n, 'raw') ? c(n.arguments[0]) : c(n);
  const derived = (value, inputs, needed = valueNeeded) => needed ? call('derive', [value, t.arrayExpression(inputs.map(n=>t.cloneNode(n))), t.cloneNode(site)]) : value;
  const unsupported = reason => {
    onGap({ reason, location: node.loc });
    return node; // Preserve the operation rather than pretend to cover it.
  };
  if (isHelper(node, 'result') || isHelper(node, 'step')) return node;
  if (t.isFunction(node) || t.isClass(node)) return node; // Bodies execute later.
  if (t.isBinaryExpression(node)) {
    const left = temp(p), right = temp(p);
    const op = t.binaryExpression(node.operator,
      call('raw', [t.cloneNode(left)]), node.operator === 'in' ? t.cloneNode(right) : call('raw',[t.cloneNode(right)]));
    return t.sequenceExpression([assign(left,operand(node.left)),assign(right,operand(node.right)),derived(op,[left,right])]);
  }
  if (t.isUnaryExpression(node)) {
    if (node.operator === 'delete') {
      if (!t.isMemberExpression(node.argument) || t.isSuper(node.argument.object) || t.isPrivateName(node.argument.property)) return unsupported('delete-reference');
      return call('remove', [c(node.argument.object),node.argument.computed ? c(node.argument.property) : t.stringLiteral(node.argument.property.name),site]);
    }
    if (node.operator === 'void') return t.unaryExpression('void', c(node.argument,false));
    if (node.operator === 'typeof' && t.isIdentifier(node.argument) && !p.scope.getBinding(node.argument.name)) return node;
    const value = temp(p);
    return t.sequenceExpression([assign(value,operand(node.argument)),derived(t.unaryExpression(node.operator,call('raw',[t.cloneNode(value)])),[value])]);
  }
  if (t.isLogicalExpression(node)) {
    const value = temp(p);
    const condition = node.operator === '??' ? call('nullish',[t.cloneNode(value)]) : call('condition',[t.cloneNode(value)]);
    return t.sequenceExpression([assign(value,c(node.left)),t.conditionalExpression(condition,
      node.operator === '||' ? t.cloneNode(value) : c(node.right),node.operator === '||' ? c(node.right) : t.cloneNode(value))]);
  }
  if (t.isConditionalExpression(node)) return t.conditionalExpression(call('condition',[c(node.test)]),c(node.consequent),c(node.alternate));
  if (t.isSequenceExpression(node)) {
    // Earlier items have effects but do not contribute their values to the result.
    return t.sequenceExpression(node.expressions.map((expr,index)=>c(expr,valueNeeded && index===node.expressions.length-1)));
  }
  if (t.isUpdateExpression(node)) {
    try {
      const {prefix,ref} = reference(p,node.argument);
      const step = temp(p);
      const before = t.memberExpression(t.cloneNode(step),t.identifier('before'));
      const after = t.memberExpression(t.cloneNode(step),t.identifier('after'));
      return t.sequenceExpression([...prefix.map(n=>c(n)),assign(step,call('step',[t.cloneNode(ref),t.numericLiteral(node.operator==='++'?1:-1)])),
        assign(ref,t.cloneNode(after)),node.prefix ? after : before]);
    } catch { return unsupported('update-reference'); }
  }
  if (t.isAssignmentExpression(node)) {
    if (node.operator === '=') {
      if (t.isPattern(node.left)) return t.assignmentExpression('=',node.left,c(node.right));
      // Native assignment evaluates the reference before RHS, and invokes its setter once.
      return t.assignmentExpression('=',node.left,c(node.right));
    }
    try {
      const {prefix,ref} = reference(p,node.left);
      const before = temp(p);
      if (['&&=','||=','??='].includes(node.operator)) {
        const condition = node.operator==='??=' ? call('nullish',[t.cloneNode(before)]) : call('condition',[t.cloneNode(before)]);
        const write = assign(ref,c(node.right));
        return t.sequenceExpression([...prefix.map(n=>c(n)),assign(before,t.cloneNode(ref)),t.conditionalExpression(condition,
          node.operator==='||=' ? t.cloneNode(before) : write,node.operator==='||=' ? write : t.cloneNode(before))]);
      }
      const right = temp(p);
      const result = derived(t.binaryExpression(node.operator.slice(0,-1),call('raw',[t.cloneNode(before)]),call('raw',[t.cloneNode(right)])),[before,right],true);
      return t.sequenceExpression([...prefix.map(n=>c(n)),assign(before,t.cloneNode(ref)),assign(right,c(node.right)),assign(ref,result)]);
    } catch { return unsupported('assignment-reference'); }
  }
  if (t.isOptionalMemberExpression(node) || t.isOptionalCallExpression(node)) return unsupported('optional-chain-propagation');
  if (t.isMemberExpression(node)) {
    if (t.isSuper(node.object) || t.isPrivateName(node.property)) return unsupported('special-member-reference');
    return call('member',[c(node.object),node.computed ? c(node.property) : t.stringLiteral(node.property.name),site]);
  }
  if (t.isCallExpression(node) || t.isNewExpression(node)) {
    if (t.isSuper(node.callee) || t.isImport(node.callee) || t.isV8IntrinsicIdentifier(node.callee)) return unsupported('special-call');
    if (t.isIdentifier(node.callee,{name:'eval'}) && !p.scope.getBinding('eval')) return unsupported('direct-eval');
    if (isHelper(node)) {
      if (isHelper(node,'builtin')) return call('invoke',[c(node.arguments[0]),node.arguments[1],t.arrayExpression(node.arguments[2].elements.map(n=>c(n))),site,t.unaryExpression('void',t.numericLiteral(0)),t.booleanLiteral(valueNeeded)]);
      // Semantic adapters retain their purpose; compile their operand without
      // interpreting the adapter itself as a business function dependency.
      return t.callExpression(node.callee,node.arguments.map(arg=>t.isExpression(arg)?c(arg):arg));
    }
    if (node.arguments.some(a=>t.isArgumentPlaceholder(a))) return unsupported('partial-application');
    const args = t.arrayExpression(node.arguments.map(arg=>t.isSpreadElement(arg)?t.spreadElement(c(arg.argument)):c(arg)));
    if (t.isNewExpression(node)) return call('construct',[c(node.callee),args,site]);
    if (t.isMemberExpression(node.callee)) {
      if (t.isSuper(node.callee.object) || t.isPrivateName(node.callee.property)) return unsupported('special-call-reference');
      const receiver=temp(p), key=temp(p), fn=temp(p);
      return t.sequenceExpression([assign(receiver,c(node.callee.object)),
        assign(key,node.callee.computed ? c(node.callee.property) : t.stringLiteral(node.callee.property.name)),
        assign(fn,t.memberExpression(t.cloneNode(receiver),t.cloneNode(key),true)),
        call('invoke',[t.cloneNode(fn),t.cloneNode(receiver),args,site,t.cloneNode(key),t.booleanLiteral(valueNeeded)])]);
    }
    return call('invoke',[c(node.callee),t.unaryExpression('void',t.numericLiteral(0)),args,site,t.unaryExpression('void',t.numericLiteral(0)),t.booleanLiteral(valueNeeded)]);
  }
  if (t.isArrayExpression(node)) return call('object',[t.arrayExpression(node.elements.map(el=>el===null?null:t.isSpreadElement(el)?t.spreadElement(c(el.argument)):c(el)))]);
  if (t.isObjectExpression(node)) {
    const properties=node.properties.map(prop=>{
      if (t.isSpreadElement(prop)) return t.spreadElement(c(prop.argument));
      if (t.isObjectMethod(prop)) {
        const copy=t.cloneNode(prop,true);if(copy.computed)copy.key=c(copy.key);return copy;
      }
      const copy=t.cloneNode(prop,true);
      copy.value=c(prop.value);
      if(copy.computed)copy.key=c(prop.key);
      if(!t.isIdentifier(copy.value) || !t.isIdentifier(copy.key) || copy.key.name!==copy.value.name)copy.shorthand=false;
      return copy;
    });
    return call('object',[t.objectExpression(properties)]);
  }
  if (t.isTemplateLiteral(node)) {
    // Conversions occur between substitutions, not after evaluating all of them.
    const inputs=[];
    const expressions=node.expressions.map(expr=>{
      const value=temp(p);inputs.push(value);return assign(value,c(expr));
    });
    return derived(t.templateLiteral(node.quasis,expressions),inputs);
  }
  if (t.isAwaitExpression(node)) return unsupported('suspended-expression');
  if (t.isYieldExpression(node)) return unsupported('generator-propagation');
  if (t.isTaggedTemplateExpression(node)) return unsupported('tagged-template-propagation');
  if (t.isParenthesizedExpression(node)) return t.parenthesizedExpression(c(node.expression));
  if (t.isJSXElement(node) || t.isJSXFragment(node)) return unsupported('jsx-source');
  return node;
}

function wrapExpressionsAtPositions(source, locations, iteration = 0, onGap = () => {}) {
  if (!(locations instanceof Set)) throw new TypeError('wrapLocations must be a Set');
  const wanted = new Set([...locations].map(locationKey));
  const ast = parse(source), found = new Set();
  traverse(ast, { exit(p) {
    if (!p.node.loc || !wanted.has(locationKey(p.node.loc))) return;
    const key=locationKey(p.node.loc);found.add(key);
    let value=p;
    if(p.isVariableDeclarator())value=p.get('init');
    else if(p.isReturnStatement() || p.isThrowStatement())value=p.get('argument');
    else if(p.isExportDefaultDeclaration())value=p.get('declaration');
    if(!value.node || !value.isExpression() || value.isFunction() || value.isClass() || isHelper(value.node,'result')) return;
    let parameter=false;
    for(let ancestor=value;ancestor && !ancestor.isFunction();ancestor=ancestor.parentPath) {
      if(ancestor.listKey==='params')parameter=true;
    }
    if(parameter){onGap({reason:'parameter-initializer',location:p.node.loc});return;}
    const reason=unsafeReason(value.node);
    if(reason){onGap({reason,location:p.node.loc});return;}
    const transformed=instrumentExpression(value.node,p,onGap,!p.parentPath.isExpressionStatement());
    value.replaceWith(call('result',[transformed,t.stringLiteral(key),t.numericLiteral(iteration)]));
    p.skip();
  }});
  for(const key of wanted)if(!found.has(key))throw new Error(`Instrumentation location not found: ${key}`);
  return print(ast);
}

function parseStack(stack) {
  if (typeof stack !== 'string') return [];
  const frames = [];
  for (const line of stack.split(/\r?\n/)) {
    // Greedy URL capture parses ports, Windows drives and query colons from the right.
    const chromium = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    const firefox = /^(.*?)@(.+):(\d+):(\d+)$/.exec(line);
    const match = chromium || firefox;
    if (!match) continue;
    frames.push({ functionName: match[1] || undefined, fileURL: match[2].replace(/^async /, ''), line: Number(match[3]), column: Number(match[4]) });
  }
  return frames;
}
module.exports = { saveToFile, parse, prepareScript, getExpression, splitVariableDeclarations, wrapExpressionsAtPositions, parseStack };
