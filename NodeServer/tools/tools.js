const fsp = require("fs").promises;
const _ = require("lodash");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generator = require("@babel/generator").default;
const t = require("@babel/types");
const path = require("path");

/**
 * async save text to file, if no address, default to current folder
 * @param {string} content - content to save
 * @param {string} filename - filename to save
 * @param {string} type - save type, new for new file, add for append content
 * @param {string} filepath - save path, default to current folder
 * @returns {Promise<void>}
 */
const saveToFile = async (
  content,
  filename,
  type = "new",
  filepath = __dirname
) => {
  try {
    // ensure directory exists
    await fsp.mkdir(filepath, { recursive: true });
    const filePath = path.join(filepath, filename);

    if (type === "new") {
      await fsp.writeFile(filePath, content, "utf8");
    } else if (type === "add") {
      await fsp.appendFile(filePath, content, "utf8");
    } else {
      console.error(
        `Invalid type specified for saveToFile: ${type}. Use 'new' or 'add'.`
      );
    }
  } catch (err) {
    console.error(`Error saving file ${path.join(filepath, filename)}:`, err);
  }
};

/**
 * get current statement and expression by code and location
 * @param {string} scriptSource  - Code
 * @param {object} location - location { lineNumber, columnNumber }
 * @returns {
 *   expression: {
 *     type: string,
 *     code: string,
 *     op: string | null,
 *     position: object | null,
 *     left: string | null,
 *     funcname: string | null,
 *     relativeLoc: object | null,
 *     node: object | null
 *   },
 *   statement: {
 *     type: string,
 *     isController: boolean,
 *     code: string,
 *     position: object | null,
 *     relativeLoc: object | null,
 *     node: object | null
 *   }
 * }
 */
function getExpression(ast, scriptSource, location) {
  // parse source code to generate AST
  // const ast = parser.parse(scriptSource, {
  //   sourceType: "unambiguous",
  //   plugins: ["jsx"],
  //   errorRecovery: true,
  // });

  let targetStatement = null;
  let targetExpression = null;
  let updateExpression = null;

  // traverse AST nodes, find expression and statement that contains the target location
  traverse(ast, {
    enter(path) {
      const node = path.node;
      const parent = path.parent;
      if (node.loc) {
        let { lineNumber, columnNumber } = location;
        lineNumber += 1;

        // check if the location is within the current node
        const isWithin =
          (lineNumber > node.loc.start.line ||
            (lineNumber === node.loc.start.line &&
              columnNumber >= node.loc.start.column)) &&
          (lineNumber < node.loc.end.line ||
            (lineNumber === node.loc.end.line &&
              columnNumber <= node.loc.end.column));

        if (isWithin) {
          if (targetExpression) {
            // if there is new statement in the node, it should be empty
            if (
              t.isStatement(node) ||
              t.isClassExpression(node) ||
              t.isAssignmentExpression(node) ||
              t.isFunctionExpression(node) ||
              t.isArrowFunctionExpression(node)
              // t.isSequenceExpression(node)
            ) {
              targetExpression = null;
            }
          }
          // handle expression node
          if (
            t.isAssignmentExpression(node) ||
            t.isVariableDeclarator(node) ||
            t.isCallExpression(node) ||
            t.isOptionalCallExpression(node) ||
            t.isConditionalExpression(node)
          ) {
            // priority handling: AssignmentExpression and VariableDeclarator have the highest priority
            if (!targetExpression || isHigherPriority(node, targetExpression)) {
              targetExpression = node;
            }
            // ugly patch
            if (
              t.isSequenceExpression(parent) ||
              t.isExpressionStatement(parent)
            ) {
              targetExpression = node;
            }
          }

          if (t.isUpdateExpression(node)) {
            updateExpression = node;
          }

          if (
            t.isDoWhileStatement(node) ||
            t.isWhileStatement(node) ||
            t.isForStatement(node) ||
            t.isIfStatement(node) ||
            t.isSwitchStatement(node) ||
            t.isReturnStatement(node)
            // t.isVariableDeclaration(node)
          ) {
            targetStatement = node;
          }
        }
      }
    },
  });

  // auxiliary function: check if the current node has higher priority
  function isHigherPriority(currentNode, existingNode) {
    const priority = {
      AssignmentExpression: 3,
      VariableDeclarator: 3,
      ConditionalExpression: 1, // condition : test ? expr1 : expr2 -> if(test) expr1 else expr2
      CallExpression: 2,
      OptionalCallExpression: 2,
    };

    const currentPriority = priority[currentNode.type] || 0;
    const existingPriority = priority[existingNode.type] || 0;
    return currentPriority >= existingPriority;
  }

  // handle expression part
  let expressionResult = null;
  if (targetExpression) {
    let { code } = generator(targetExpression, { compact: true }, scriptSource);
    let relativeLoc = calculateRelativeLoc(location, targetExpression.loc);
    let op = null;
    let left = null;
    let funcname = null;

    if (t.isVariableDeclarator(targetExpression)) {
      left = targetExpression.id.name;
      op = "=";
    } else if (t.isAssignmentExpression(targetExpression)) {
      left = generator(
        targetExpression.left,
        { compact: true },
        scriptSource
      ).code;
      op = targetExpression.operator;
    } else if (
      t.isCallExpression(targetExpression) ||
      t.isOptionalCallExpression(targetExpression)
    ) {
      if (t.isMemberExpression(targetExpression.callee)) {
        funcname = generator(
          targetExpression.callee,
          { compact: true },
          scriptSource
        ).code;
      } else if (t.isIdentifier(targetExpression.callee)) {
        funcname = targetExpression.callee.name;
      }
    } else if (t.isConditionalExpression(targetExpression)) {
      // at this time, not only in the test part, but also definitely not assignment or call
      targetStatement = targetExpression;
      targetExpression = targetExpression.test;
      code = generator(targetExpression, { compact: true }, scriptSource).code;
      relativeLoc = calculateRelativeLoc(location, targetExpression.loc);
    }

    expressionResult = {
      type: targetExpression.type,
      code: code,
      op: op || null,
      position: targetExpression.loc || null,
      left: left || null,
      funcname: funcname || null,
      relativeLoc: relativeLoc || null,
      node: targetExpression || null,
    };
  }

  // handle statement part
  let statementResult = null;
  if (targetStatement) {
    let { code } = generator(targetStatement, { compact: true }, scriptSource);
    let relativeLoc = calculateRelativeLoc(location, targetStatement.loc);
    let isController = false;

    if (
      t.isDoWhileStatement(targetStatement) ||
      t.isWhileStatement(targetStatement) ||
      t.isIfStatement(targetStatement) ||
      t.isForStatement(targetStatement)
    ) {
      if (isLocationWithin(location, targetStatement.test.loc)) {
        isController = true;

        if (!targetExpression) {
          targetExpression = targetStatement.test;
          let expCode = generator(
            targetExpression,
            { compact: true },
            scriptSource
          ).code;
          relativeLoc = calculateRelativeLoc(location, targetExpression.loc);
          // update expressionResult
          expressionResult = {
            type: targetExpression.type,
            code: expCode,
            op: null,
            position: targetExpression.loc || null,
            left: null,
            funcname: null,
            relativeLoc: relativeLoc || null,
            node: targetExpression || null,
          };
        }
      }
    } else if (t.isSwitchStatement(targetStatement)) {
      if (isLocationWithin(location, targetStatement.discriminant.loc)) {
        isController = true;
        if (!targetExpression) {
          targetExpression = targetStatement.discriminant;
          let expCode = generator(
            targetExpression,
            { compact: true },
            scriptSource
          ).code;
          relativeLoc = calculateRelativeLoc(location, targetExpression.loc);
          // update expressionResult
          expressionResult = {
            type: targetExpression.type,
            code: expCode,
            op: null,
            position: targetExpression.loc || null,
            left: null,
            funcname: null,
            relativeLoc: relativeLoc || null,
            node: targetExpression || null,
          };
        }
      } else {
        for (let cases of targetStatement.cases) {
          if (isLocationWithin(location, cases.loc)) {
            isController = true;
            if (!targetExpression) {
              targetExpression = cases;
              let expCode = generator(
                targetExpression,
                { compact: true },
                scriptSource
              ).code;
              relativeLoc = calculateRelativeLoc(
                location,
                targetExpression.loc
              );
              // update expressionResult
              expressionResult = {
                type: targetExpression.type,
                code: expCode,
                op: null,
                position: targetExpression.loc || null,
                left: null,
                funcname: null,
                relativeLoc: relativeLoc || null,
                node: targetExpression || null,
              };
            }
            break;
          }
        }
      }
    } else if (t.isConditionalExpression(targetStatement)) {
      isController = true;
    } else if (t.isReturnStatement(targetStatement)) {
      code = generator(targetStatement, { compact: true }, scriptSource).code;
      isController = false;
    }

    statementResult = {
      type: targetStatement.type,
      isController: isController,
      code: code,
      position: targetStatement.loc || null,
      relativeLoc: relativeLoc || null,
      node: targetStatement || null,
    };
  }

  // calculate relative location
  function calculateRelativeLoc(location, nodeLoc) {
    if (!nodeLoc) return null;
    let { lineNumber, columnNumber } = location;
    lineNumber += 1;
    let { start } = nodeLoc;

    let relativeLine = lineNumber - start.line;
    let relativeColumn =
      relativeLine === 0 ? columnNumber - start.column : columnNumber;

    return {
      line: relativeLine,
      column: relativeColumn,
    };
  }

  // check if the location is within a certain range
  function isLocationWithin(location, nodeLoc) {
    if (!nodeLoc) return false;
    let { lineNumber, columnNumber } = location;
    const { start, end } = nodeLoc;
    lineNumber += 1;

    return (
      (lineNumber > start.line ||
        (lineNumber === start.line && columnNumber >= start.column)) &&
      (lineNumber < end.line ||
        (lineNumber === end.line && columnNumber <= end.column))
    );
  }

  let updateResult = null;
  if (updateExpression) {
    // here temporarily only capture and do not process, theoretically should insert the statement of proxying itself after the current expression
    const { code } = generator(
      updateExpression,
      { compact: true },
      scriptSource
    );
    const relativeLoc = calculateRelativeLoc(location, updateExpression.loc);
    let left = generator(
      updateExpression.argument,
      { compact: true },
      scriptSource
    ).code;

    updateResult = {
      code: code,
      position: updateExpression.loc,
      left: left,
      node: updateExpression || null,
      relativeLoc: relativeLoc || null,
    };
  }

  // build return result
  const result = {
    expression: expressionResult,
    statement: statementResult,
    update: updateResult,
  };

  // console.log(result);
  return result;
}

/**
 * split the declaration statements of multiple VariableDeclarators into separate declarations, change the += form of assignment statements.
 * @param {string} scriptSource - original JavaScript code.
 * @returns {string} - converted JavaScript code.
 */
const splitVariableDeclarations = (scriptSource) => {
  const ast = parser.parse(scriptSource, {
    sourceType: "unambiguous",
    plugins: ["jsx"], // add plugins as needed
  });

  traverse(ast, {
    VariableDeclaration(path) {
      const { node, parent } = path;
      const { declarations, kind } = node;

      // ignore for loop
      if (parent.type === "ForStatement" && parent.init === node) {
        return;
      }

      // only split when there are multiple VariableDeclarators
      if (declarations.length > 1) {
        // create a new VariableDeclaration for each VariableDeclarator
        const newDeclarations = declarations.map((declarator) =>
          t.variableDeclaration(kind, [declarator])
        );

        // replace the original one with the new multiple VariableDeclarations
        path.replaceWithMultiple(newDeclarations);
      }
    },

    // new feature, split assignment expressions,这样可以减少所需的插入代码
    AssignmentExpression(path) {
      const { node } = path;
      const compoundOperators = [
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "<<=",
        ">>=",
        ">>>=",
        "&=",
        "^=",
        "|=",
      ];
      if (compoundOperators.includes(node.operator)) {
        // get the identifier on the left
        const left = node.left;
        const right = node.right;

        // build a new simple assignment expression
        const newOperator = node.operator.slice(0, -1); // 去掉 '='，获取实际的运算符
        const newRight = t.binaryExpression(
          newOperator,
          t.cloneNode(left),
          t.cloneNode(right)
        );

        const newAssignment = t.assignmentExpression(
          "=",
          t.cloneNode(left),
          newRight
        );

        // replace the current node
        path.replaceWith(newAssignment);
      }
    },
  });

  const output = generator(ast, {
    retainLines: true,
    /* retain lines for better debugging */
  });

  return output.code;
};

/**
 * wrap expressions at specified positions to varProxy(). Here we need to append insert statements because of a+=1, a++等情况
 * @param {string} scriptSource - original JavaScript code.
 * @param {Set<{ start: { line: number, column: number, index: number }, end: { line: number, column: number, index: number } }>} wrapLocations - 包含需要包装的位置的 Set。
 * @returns {string} - converted JavaScript code.
 */
function wrapExpressionsAtPositions(scriptSource, wrapLocations, index = 0) {
  if (!(wrapLocations instanceof Set)) {
    throw new Error("wrapLocations must be a Set");
  }
  // --- 新增去重逻辑 ---
  const uniqueEntriesMap = new Map();
  for (const entry of wrapLocations) {
    // use start and end index to create a unique key
    const uniqueKey = `${entry.start.index}-${entry.end.index}`;
    // if the key is repeated, the later entry will overwrite the previous one
    uniqueEntriesMap.set(uniqueKey, entry);
  }
  const uniqueWrapArray = Array.from(uniqueEntriesMap.values());

  // sort the array by start.index in descending order
  const sortedWrapArray = uniqueWrapArray.sort(
    (a, b) => b.start.index - a.start.index
  );
  // // convert wrapLocations to an array and sort by start.index in descending order
  // const sortedWrapArray = Array.from(wrapLocations).sort(
  //   (a, b) => b.start.index - a.start.index
  // );

  // parse source code to AST
  const ast = parser.parse(scriptSource, {
    sourceType: "unambiguous",
    plugins: ["jsx"],
    ranges: true, // include range information
    tokens: true,
  });

  // collect all VariableDeclarator and AssignmentExpression nodes
  const targetNodes = [];

  traverse(ast, {
    VariableDeclarator(path) {
      const { node } = path;
      if (node.loc && node.start !== undefined && node.end !== undefined) {
        targetNodes.push({
          type: "VariableDeclarator",
          node,
          path,
        });
      }
    },
    AssignmentExpression(path) {
      const { node } = path;
      if (node.loc && node.start !== undefined && node.end !== undefined) {
        targetNodes.push({
          type: "AssignmentExpression",
          node,
          path,
        });
      }
    },
    ReturnStatement(path) {
      const { node } = path;
      if (node.loc && node.start !== undefined && node.end !== undefined) {
        targetNodes.push({
          type: "ReturnStatement",
          node,
          path,
        });
      }
    },
  });

  // handle each wrapLocation, in descending order
  for (const loc of sortedWrapArray) {
    const key = `${loc.start.index}-${loc.end.index}`;
    let found = false;

    for (const target of targetNodes) {
      if (
        target.node.start === loc.start.index &&
        target.node.end === loc.end.index
      ) {
        // let code = generator(target.node).code;
        // let args = convertToASTNodes(extractMemberChainsAndIdentifiers(code));

        // check if it has been wrapped by varProxy
        if (target.type === "VariableDeclarator") {
          const { node } = target;
          if (node.init) {
            if (
              t.isCallExpression(node.init) &&
              t.isIdentifier(node.init.callee, { name: "varProxy" })
            ) {
              found = true;
              break; // already wrapped, skip
            }

            // wrap the right expression to varProxy(...)
            const args = convertToASTNodes(getVariablesFromNode(node.init));
            node.init = t.callExpression(t.identifier("varProxy"), [
              node.init,
              t.numericLiteral(index),
              ...args,
            ]);
            found = true;
            break;
          }
        } else if (target.type === "AssignmentExpression") {
          const { node } = target;
          if (node.right) {
            if (
              t.isCallExpression(node.right) &&
              t.isIdentifier(node.right.callee, { name: "varProxy" })
            ) {
              found = true;
              break; // already wrapped, skip
            }

            // wrap the right expression to varProxy(...)
            const args = convertToASTNodes(getVariablesFromNode(node.right));
            node.right = t.callExpression(t.identifier("varProxy"), [
              node.right,
              t.numericLiteral(index),
              ...args,
            ]);
            found = true;
            break;
          }
        } else if (target.type === "ReturnStatement") {
          const { node } = target;
          if (node.argument) {
            if (
              t.isCallExpression(node.argument) &&
              t.isIdentifier(node.argument.callee, { name: "varProxy" })
            ) {
              found = true;
              break; // already wrapped, skip
            }
            const args = convertToASTNodes(getVariablesFromNode(node.argument));
            node.argument = t.callExpression(t.identifier("varProxy"), [
              node.argument,
              t.numericLiteral(index),
              ...args,
            ]);
            found = true;
            break;
          }
        }
      }
    }

    if (!found) {
      console.warn(
        ` start.index: ${loc.start.index}, end.index: ${loc.end.index}` // not found matching position
      );
      console.log(sortedWrapArray);
    }
  }

  // generate converted code
  const output = generator(ast, {
    retainLines: true, // retain original lines
    /* add other generator options as needed */
  });

  return output.code;
}

// new feature: convert the collected strings to AST nodes
function convertToASTNodes(references) {
  return references.map((ref) => {
    try {
      // strictly maintain the original expression structure
      const ast = parser.parseExpression(ref, {
        plugins: ["jsx"],
        tokens: false,
      });

      // handle possible parentheses
      const unwrappedAst =
        ast.type === "ParenthesizedExpression" ? ast.expression : ast;

      // clone nodes to avoid position information conflicts
      return cloneNodeWithSanitization(unwrappedAst);
    } catch (e) {
      console.error(`cannot convert expression "${ref}": ${e.message}`);
      return t.identifier("INVALID_REFERENCE");
    }
  });
}

// clone nodes and retain necessary information
function cloneNodeWithSanitization(node) {
  const cloned = t.cloneNode(node, true);

  // clear possible conflicting position information
  if (cloned.loc) {
    cloned.loc = null;
  }

  // special handling for MemberExpression
  if (t.isMemberExpression(cloned)) {
    cloned.computed = node.computed; // keep computed property mark
  }

  return cloned;
}

/**
 * if you want to exclude some reserved words, keywords, built-in objects, etc., you can implement it here.
 */
function isExcludedIdentifier(name) {
  return false;
}

/**
 * handle the "outermost" MemberExpression, return its complete chain string.
 */
function parseMemberExpression(node, isTopLevel, references) {
  const { object, property, computed } = node;

  // 1. parse object
  let objectStr = "";
  if (object.type === "Identifier") {
    // a.b => object = a
    objectStr = object.name;
  } else if (object.type === "MemberExpression") {
    // a.b.c => recursive parsing, but isTopLevel = false
    objectStr = parseMemberExpression(object, false, references);
  } else {
    // maybe other expressions, such as CallExpression, BinaryExpression, etc.
    parseExpression(object, references);
    objectStr = generator(object).code;
  }

  // 2. parse property
  if (!computed) {
    // a.b form
    if (property.type === "Identifier") {
      const fullChain = `${objectStr}.${property.name}`;
      if (isTopLevel) {
        references.add(fullChain);
      }
      return fullChain;
    } else {
      // like a.(callExpression())
      parseExpression(property, references);
      const fullChain = `${objectStr}.[UnknownProperty]`;
      if (isTopLevel) {
        references.add(fullChain);
      }
      return fullChain;
    }
  } else {
    // a[b] form
    const propStr = parseComputedProperty(property, references);
    const fullChain = `${objectStr}[${propStr}]`;
    if (isTopLevel) {
      references.add(fullChain);
    }
    return fullChain;
  }
}

function isReflectGetCall(node) {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Reflect" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "get" &&
    node.arguments.length >= 2
  );
}

/**
 * parse the "[]" part of MemberExpression, such as c[d.log], x[y+1], etc.
 */
function parseComputedProperty(property, references) {
  switch (property.type) {
    case "Identifier":
      // a[b] => return "b", and collect the bare identifier b (because the value of b is used to calculate the index)
      if (!isExcludedIdentifier(property.name)) {
        references.add(property.name);
      }
      return property.name;

    case "MemberExpression":
      // c[d.log] => collect "d.log" as the outermost
      return parseMemberExpression(property, true, references);

    case "BinaryExpression":
    case "LogicalExpression":
    case "ConditionalExpression":
      // a[d + 1], a[d?.log], etc.
      parseExpression(property, references);
      return generator(property).code;

    case "CallExpression":
      parseExpression(property, references);
      return generator(property).code;

    case "Literal":
    case "StringLiteral":
    case "NumericLiteral":
    case "BigIntLiteral":
      // a[123] or a["abc"]
      // directly return the string form of the literal, without collecting it separately (because it is not a variable)
      return JSON.stringify(property.value);

    case "UpdateExpression":
      parseExpression(property, references);
      return generator(property.argument).code;

    case "OptionalCallExpression":
    default:
      // other expressions, continue deep traversal
      console.log("default");
      parseExpression(property, references);
      return `[${property.type}]`;
  }
}

/**
 * general parseExpression, used to traverse any node, find:
 * - "outermost" MemberExpression (only collect complete chain access)
 * - "bare identifier" (non-function call name)
 */
function parseExpression(node, references) {
  if (!node) return;

  switch (node.type) {
    case "Identifier":
      // collect "bare identifier"
      if (!isExcludedIdentifier(node.name)) {
        references.add(node.name);
      }
      break;

    case "MemberExpression":
      // like b.name, c[d.log], a.b.c
      parseMemberExpression(node, true, references);
      break;

    case "CallExpression":
      // // skip simple function name: foo(x, y) => foo not collect
      // // if callee is MemberExpression => obj.func(...) => collect "obj.func"
      // if (node.callee.type === "MemberExpression") {
      //   // if needed, can collect obj.func
      //   // parseMemberExpression(node.callee, true, references);
      // } else if (node.callee.type !== "Identifier") {
      //   // if it is other form (like (x+y)() ), continue parsing
      //   parseExpression(node.callee, references);
      // }

      // // parse arguments
      // node.arguments.forEach((arg) => parseExpression(arg, references));
      // break;
      if (isReflectGetCall(node)) {
        // convert Reflect.get(obj, prop) to MemberExpression of obj[prop]
        const virtualNode = {
          type: "MemberExpression",
          object: node.arguments[0],
          property: node.arguments[1],
          computed: true, // force视为 computed property
        };
        parseMemberExpression(virtualNode, true, references);
      } else {
        // original logic for other function calls
        if (node.callee.type === "MemberExpression") {
          parseMemberExpression(node.callee, true, references);
        } else if (node.callee.type !== "Identifier") {
          parseExpression(node.callee, references);
        }
        node.arguments.forEach((arg) => parseExpression(arg, references));
      }
      break;

    // common binary, logical, assignment, conditional expressions, etc. -> deep traverse its child nodes
    case "BinaryExpression":
    case "LogicalExpression":
    case "AssignmentExpression":
    case "ConditionalExpression":
    case "UnaryExpression":
    case "UpdateExpression":
    case "AwaitExpression":
      Object.keys(node).forEach((key) => {
        const val = node[key];
        if (val && typeof val === "object" && val.type) {
          parseExpression(val, references);
        }
      });
      break;

    case "ArrayExpression":
      node.elements.forEach((elem) => parseExpression(elem, references));
      break;

    case "ObjectExpression":
      node.properties.forEach((prop) => {
        // check if the property is SpreadElement (like ...obj)
        if (prop.type === "SpreadElement") {
          parseExpression(prop.argument, references);
        } else {
          // only when the key is computed property (like { [a]: 1 }), it is regarded as a variable for parsing
          if (prop.computed) {
            parseExpression(prop.key, references);
          }
          // value part always needs to be parsed
          parseExpression(prop.value, references);
        }
      });
      break;

    default:
      // other types, continue traversal
      Object.keys(node).forEach((key) => {
        const val = node[key];
        if (Array.isArray(val)) {
          val.forEach(
            (child) => child && child.type && parseExpression(child, references)
          );
        } else if (val && val.type) {
          parseExpression(val, references);
        }
      });
  }
}

/**
 * extract all variables and member expression references from an AST node
 * @param {t.Node} node - Babel AST node.
 * @returns {string[]} - array of strings of variables and member expressions.
 */
function getVariablesFromNode(node) {
  const references = new Set();
  if (node) {
    parseExpression(node, references);
  }
  return Array.from(references);
}

/**
 * main function: given JS code, collect "bare identifier" and "member access" in the right expression.
 * and do not collect function name (like foo in foo(x,y) ).
 */
function extractMemberChainsAndIdentifiers(code) {
  const ast = parser.parse(code, {
    sourceType: "module",
  });

  const references = new Set();

  traverse(ast, {
    // handle variable declaration let a = ...; const a = ...; var a = ...
    VariableDeclarator(path) {
      const init = path.node.init;
      if (init) {
        parseExpression(init, references);
      }
    },

    // handle assignment expression a = ...
    AssignmentExpression(path) {
      const right = path.node.right;
      if (right) {
        parseExpression(right, references);
      }
    },

    ReturnStatement(path) {
      const argument = path.node.argument;
      if (argument) {
        parseExpression(argument, references);
      }
    },
  });

  return Array.from(references);
}

/**
 * parse the Error.stack string to { functionName, fileURL, line, column } array
 * support V8 (Chrome/Node.js), SpiderMonkey (Firefox), JavaScriptCore (Safari) format (the last two are not tested)
 * @param {string} stackStr - Error().stack returned stack string
 * @returns {Array<{ functionName: string|undefined, fileURL: string, line: number, column: number }>}
 */
function parseStack(stackStr) {
  if (!stackStr) return null;
  const lines = stackStr.split("\n").map((l) => l.trim());
  const frames = [];

  // skip the first line (usually "Error: msg" or "<message>")
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue; // skip empty line

    let match;
    let functionName, fileURL, lineNum, colNum;

    // 1. V8 standard format: at functionName (file:line:col)
    if ((match = /^\s*at\s+([^(]+?)\s+\(([^)]+):(\d+):(\d+)\)$/.exec(line))) {
      [, functionName, fileURL, lineNum, colNum] = match;
      functionName = functionName.trim();
    }
    // 2. V8 direct URL format (new): at https://example.com/file.js:line:col
    else if ((match = /^\s*at\s+(https?:\/\/[^:]+):(\d+):(\d+)$/.exec(line))) {
      [, fileURL, lineNum, colNum] = match;
      functionName = undefined;
    }
    // 3. V8 file path format: at file:line:col or at /path/file.js:line:col
    else if ((match = /^\s*at\s+([^:]+):(\d+):(\d+)$/.exec(line))) {
      [, fileURL, lineNum, colNum] = match;
      functionName = undefined;
    }
    // 4. V8 complex function name format: at Object.method [as alias] (file:line:col)
    else if (
      (match =
        /^\s*at\s+(.+?)\s+\[as\s+([^\]]+)\]\s+\(([^)]+):(\d+):(\d+)\)$/.exec(
          line
        ))
    ) {
      [, , functionName, fileURL, lineNum, colNum] = match;
      // use alias as function name
    }
    // 5. V8 object method format: at Object.method (file:line:col)
    else if (
      (match = /^\s*at\s+([\w.$]+\.[\w$]+)\s+\(([^)]+):(\d+):(\d+)\)$/.exec(
        line
      ))
    ) {
      [, functionName, fileURL, lineNum, colNum] = match;
    }
    // 6. V8 constructor format: at new Constructor (file:line:col)
    else if (
      (match = /^\s*at\s+new\s+([^(]+?)\s+\(([^)]+):(\d+):(\d+)\)$/.exec(line))
    ) {
      [, functionName, fileURL, lineNum, colNum] = match;
      functionName = `new ${functionName.trim()}`;
    }
    // 7. handle the special format you encountered: Object.i$e [as getCoverArtUrl] (https://...)
    else if (
      (match =
        /^\s*at\s+(.+?)\s+\[as\s+([^\]]+)\]\s+\(([^)]+):(\d+):(\d+)\)/.exec(
          line
        ))
    ) {
      [, , functionName, fileURL, lineNum, colNum] = match;
    }
    // 8. handle the special characters in the obfuscated code: at i$e (file:line:col)
    else if (
      (match = /^\s*at\s+([^\s(]+)\s+\(([^)]+):(\d+):(\d+)\)$/.exec(line))
    ) {
      [, functionName, fileURL, lineNum, colNum] = match;
    }
    // 9. SpiderMonkey (Firefox) format: functionName@file:line:col
    else if ((match = /^([^@]+)@([^:]+):(\d+):(\d+)$/.exec(line))) {
      [, functionName, fileURL, lineNum, colNum] = match;
    }
    // 10. SpiderMonkey anonymous format: @file:line:col
    else if ((match = /^@([^:]+):(\d+):(\d+)$/.exec(line))) {
      [, fileURL, lineNum, colNum] = match;
      functionName = undefined;
    }
    // 11. Safari/JavaScriptCore format: functionName@[native code]
    else if ((match = /^([^@]+)@\[native code\]$/.exec(line))) {
      [, functionName] = match;
      fileURL = "[native code]";
      lineNum = colNum = 0;
    }
    // 12. Safari format variant: global code@file:line:col
    else if ((match = /^(global code)@([^:]+):(\d+):(\d+)$/.exec(line))) {
      [, functionName, fileURL, lineNum, colNum] = match;
    }
    // 13. Node.js eval format: at eval (eval at <anonymous> (file:line:col))
    else if (
      (match =
        /^\s*at\s+eval\s+\(eval\s+at\s+[^(]*\(([^)]+):(\d+):(\d+)\)\)$/.exec(
          line
        ))
    ) {
      [, fileURL, lineNum, colNum] = match;
      functionName = "eval";
    }
    // 14. Webpack/bundler format: at __webpack_require__ (file:line:col)
    else if (
      (match =
        /^\s*at\s+(__webpack_require__|webpackJsonp)\s+\(([^)]+):(\d+):(\d+)\)$/.exec(
          line
        ))
    ) {
      [, functionName, fileURL, lineNum, colNum] = match;
    }
    // 15. async function format: at async functionName (file:line:col)
    else if (
      (match = /^\s*at\s+async\s+([^(]+?)\s+\(([^)]+):(\d+):(\d+)\)$/.exec(
        line
      ))
    ) {
      [, functionName, fileURL, lineNum, colNum] = match;
      functionName = `async ${functionName.trim()}`;
    }
    // 16. handle the case where the file URL contains function information (you encountered the problem)
    else if ((match = /^\s*at\s+.*?\(([^)]+):(\d+):(\d+)\)$/.exec(line))) {
      [, fileURL, lineNum, colNum] = match;
      // try to extract the function name from the complete line
      const funcMatch = /^\s*at\s+(.+?)\s+\(/.exec(line);
      if (funcMatch) {
        functionName = funcMatch[1].trim();
        // handle [as alias] format
        const asMatch = functionName.match(/\[as\s+([^\]]+)\]/);
        if (asMatch) {
          functionName = asMatch[1];
        }
      }
    } else {
      // 17. other unrecognized format error handling
      // console.warn(`未识别的堆栈格式: ${line}`);
      continue;
    }

    // clean and verify the parsed results
    if (fileURL) {
      frames.push({
        functionName: functionName || undefined,
        fileURL,
        line: parseInt(lineNum) || 0,
        column: parseInt(colNum) || 0,
      });
    }
  }

  return frames;
}

module.exports = {
  saveToFile,
  getExpression,
  splitVariableDeclarations,
  wrapExpressionsAtPositions,
  parseStack,
};
