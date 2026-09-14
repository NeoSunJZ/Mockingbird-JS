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
  t.traverseFast(node, child => {
    if (t.isAwaitExpression(child) || t.isYieldExpression(child)) reason = 'suspended-expression';
    if (t.isCallExpression(child) && t.isIdentifier(child.callee, { name: 'eval' })) reason = 'direct-eval';
  });
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
    SwitchStatement: { exit(p) { p.node.discriminant = call('raw', [p.node.discriminant]); } },
    SwitchCase: { exit(p) { if (p.node.test) p.node.test = call('raw', [p.node.test]); } },
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
// Locations here follow CDP: zero-based line and column. End offsets are exclusive.
function getExpression(ast, source, location) {
  let leaf;
  traverse(ast, { enter(p) {
    if (contains(p.node, location.lineNumber + 1, location.columnNumber)) leaf = p;
    else p.skip();
  } });
  if (!leaf) return { expression: null, statement: null, update: null, candidates: [] };
  if (leaf.findParent(p => isHelper(p.node, 'capture') || isHelper(p.node, 'step'))) return { expression: null, statement: null, update: null, candidates: [] };
  let expression, statement, update;
  const candidates = [];
  for (let p = leaf; p && !p.isProgram(); p = p.parentPath) {
    if (p.isUpdateExpression()) { update = p.node; expression = p.node; candidates.push(p.node.loc); break; }
    if (!statement && p.isStatement()) statement = p.node;
    if (isHelper(p.node, 'capture')) break; // This boundary has already been handled.
    if (p.isVariableDeclarator() && p.node.init || p.isAssignmentExpression() || p.isReturnStatement() && p.node.argument) {
      expression = p.node;
      candidates.push(p.node.loc);
      break;
    }
    // Direct computed call arguments and concise arrow returns were missing.
    if (p.parentPath?.isCallExpression() && p.listKey === 'arguments' && p.isExpression() && !p.isIdentifier() && !p.isMemberExpression() && !isHelper(p.parentPath.node)) {
      expression = p.node; candidates.push(p.node.loc); break;
    }
    if (p.parentPath?.isArrowFunctionExpression() && p.key === 'body' && p.isExpression()) {
      expression = p.node; candidates.push(p.node.loc); break;
    }
    if (p.isFunction()) break;
  }
  const result = describe(statement, source);
  if (result) result.isController = Boolean(statement.test && contains(statement.test, location.lineNumber + 1, location.columnNumber));
  return { expression: describe(expression, source), statement: result, update: describe(update, source), candidates };
}

function wrapExpressionsAtPositions(source, locations, iteration = 0, onGap = () => {}) {
  if (!(locations instanceof Set)) throw new TypeError('wrapLocations must be a Set');
  const wanted = new Set([...locations].map(locationKey));
  const ast = parse(source);
  const found = new Set();
  traverse(ast, {
    exit(p) {
      if (!p.node.loc || !wanted.has(locationKey(p.node.loc))) return;
      const key = locationKey(p.node.loc);
      found.add(key);
      let valuePath = p;
      if (p.isVariableDeclarator()) valuePath = p.get('init');
      else if (p.isReturnStatement()) valuePath = p.get('argument');
      else if (p.isAssignmentExpression() && p.node.operator === '=') valuePath = p.get('right');
      if (!valuePath.node || isHelper(valuePath.node, 'capture')) return;
      const reason = unsafeReason(valuePath.node);
      if (reason) { onGap({ reason, location: p.node.loc }); return; }
      const site = `${p.node.start}:${p.node.end}`;
      const captured = expr => call('capture', [t.arrowFunctionExpression([], expr), t.stringLiteral(site), t.numericLiteral(iteration)]);
      if (p.isAssignmentExpression() && p.node.operator !== '=') {
        const n = p.node;
        if (['&&=', '||=', '??='].includes(n.operator)) {
          onGap({ reason: 'logical-assignment-needs-prepass', location: n.loc }); return;
        }
        try {
          const { prefix, ref } = reference(p, n.left);
          const write = assign(ref, captured(t.binaryExpression(n.operator.slice(0, -1), t.cloneNode(ref), n.right)));
          p.replaceWith(prefix.length ? t.sequenceExpression([...prefix, write]) : write);
        } catch (error) { onGap({ reason: error.message, location: n.loc }); }
      } else if (p.isUpdateExpression()) {
        const n = p.node;
        try {
          const { prefix, ref } = reference(p, n.argument);
          const step = temp(p);
          const before = t.memberExpression(t.cloneNode(step), t.identifier('before'));
          const after = t.memberExpression(t.cloneNode(step), t.identifier('after'));
          p.replaceWith(t.sequenceExpression([...prefix,
            assign(step, call('step', [t.cloneNode(ref), t.numericLiteral(n.operator === '++' ? 1 : -1)])),
            assign(ref, t.cloneNode(after)), n.prefix ? after : before]));
        } catch (error) { onGap({ reason: error.message, location: n.loc }); }
      } else if (valuePath.isExpression() && !valuePath.isFunction() && !valuePath.isClass()) {
        valuePath.replaceWith(captured(valuePath.node));
      } else onGap({ reason: 'unsupported-expression', location: p.node.loc });
      p.skip();
    }
  });
  for (const key of wanted) if (!found.has(key)) throw new Error(`Instrumentation location not found: ${key}`);
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
