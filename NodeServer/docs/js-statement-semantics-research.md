# JS 语句、声明与追踪边界

2026-09-19。仅研究语言语义和 Mockingbird 的设计分类，不表示当前实现已覆盖。以下“建议”是针对 EDE 的分析规则，ECMAScript 本身不定义污点或业务必要性。覆盖标准 JS；JSX、TypeScript、装饰器等插件语法应另立支持清单。在线 ECMA-262 是持续更新版本，不能由语法已出现在规范推断当前 Babel/浏览器支持。

**结论：不能选中一个外层 statement 后统一合并其中所有来源。应识别实际读值所处的语义槽位：存储、控制、传递、结构/属性操作、执行边界。** 关注不等于补装箱，补装箱也不等于已消费。

## 语句及声明完整分类

节点名称参考 [ESTree 核心](https://github.com/estree/estree/blob/master/es5.md)、[ES2015 扩展](https://github.com/estree/estree/blob/master/es2015.md)、[Babel AST 类型](https://babel.dev/docs/babel-types)；规范区分 Statement 与 Declaration，Babel 的别名集合不完全等于规范语法。

| 类别 | Mockingbird 应关注的槽位 | 建议动作及限制 |
|---|---|---|
| `VariableDeclaration` / `VariableDeclarator`：var、let、const | 每个初始化值、每个绑定目标 | 初始值到绑定传播。无初始化表达式的声明不读旧值。解构拆成各属性/元素绑定；不能把整个 RHS 的来源发给全部目标。 |
| `ExpressionStatement` | 内部表达式及正常完成值 | 是容器，不是自动 sink。确认结果丢弃才可停止结果传播；eval 可返回该完成值。其中调用、赋值、getter、转换、异常仍需分析。 |
| `IfStatement` | `test` | 控制使用；分支体递归独立分析。变量仅出现在分支体中，不代表它影响 if 的选择。 |
| `WhileStatement` / `DoWhileStatement` | `test` | 控制使用；区分先测条件与先执行一次循环体。 |
| `ForStatement` | `init`、`test`、`update`、`body` | 四部分分别处理；只有 test 是循环条件，不能把 init/update 的每次读取都叫条件消费。 |
| `ForInStatement` | `right`、每轮 `left` 绑定/写入 | 对象结构及可枚举键使用；键与字段值是不同来源维度。遍历某字段的名字不证明读取该字段的值。 |
| `ForOfStatement`、`for await ... of` | 迭代器、每轮 value→left、done 决策、异步恢复 | 隐式调用与隐式赋值，需要迭代协议边界。不能仅处理源码中的 RHS 一次读取。 |
| `SwitchStatement` / `SwitchCase` | discriminant、实际求值的 case.test | 两边都可能来自响应，按比较选择记录。default 无 test；进入后贯穿执行的 case 体不意味着其 test 执行过。 |
| `ReturnStatement` | argument | 传播到实际调用结果；不是自动最终消费。无 argument 不直接读取业务变量。 |
| `ThrowStatement` | argument | 传播到 catch 参数、Promise 拒绝或宿主错误出口；抛出本身不宜自动证明业务必要。 |
| `TryStatement` / `CatchClause` | 异常对象→catch 参数；块中实际操作 | try/finally 没有普通条件表达式；catch 解构仍需绑定分析。不得把整个 try 的读取合并到异常。 |
| `WithStatement` | object、其间动态标识符解析 | 特殊环境/结构使用，不是普通布尔条件。建议明确支持边界或报告缺口。 |
| `FunctionDeclaration`、async/generator 变体 | 参数绑定、默认值、执行的函数体、返回/抛出 | 声明创建函数不能当作执行函数体。函数体里的自由变量不能立即污染函数对象或外层初始化值。 |
| `ClassDeclaration` | extends、计算键、静态初始化；实例字段初始化另计 | 类定义期间的执行与构造期间的执行分开；方法体在调用时分析。 |
| `ImportDeclaration`、具名导出、再导出 | 模块绑定关联 | 静态名字/字符串不是对响应变量的动态读取。跨模块追踪需要绑定关联；不自动消费。 |
| `ExportDefaultDeclaration`、导出的变量/类声明 | 实际表达式/初始化值 | 默认表达式值传播；嵌套声明仍按相应规则处理。动态 import 属于表达式另行分析。 |
| `using` / `await using`（若所选语言版本支持） | 初始化值、离开作用域时的 dispose 调用 | 与普通绑定分开，需建模隐式调用/异步清理；不能悄悄当成 const。 |
| `BlockStatement`、`Program`、`LabeledStatement` | 内部节点 | 仅作用域/顺序/控制目标容器，不把所有子节点来源合并。 |
| `BreakStatement`、`ContinueStatement` | 无值操作数 | 改变控制流，但标签标识符不是变量读取；不直接补装箱或算字段消费。 |
| `EmptyStatement`、`DebuggerStatement` | 无业务值操作数 | 无直接来源传播；保留原行为。 |

## 隐式执行与延迟执行是必要覆盖项

- **迭代**：for-of/await-of 每轮取得 value 后写入绑定；循环退出可能调用 iterator.return。for-in 使用结构和键，不等于使用对象全部值。依据 [For-in/of/await-of 算法](https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-for-in-and-for-of-statements)。
- **异常与控制跳转**：catch 绑定实际异常，finally 可以替换之前的返回/抛出完成状态。因此 AST 里出现 return argument 不等于调用者最终收到该值。依据 [try 语义](https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-try-statement)。
- **函数与类**：默认参数在调用时按需求值；闭包体不在闭包创建时执行。类的 extends、计算键、静态字段和 static block 在类定义阶段执行，实例字段在实例初始化时执行，方法体在调用时执行。依据 [函数与类语义](https://tc39.es/ecma262/multipage/ecmascript-language-functions-and-classes.html)，类字段节点见 [ESTree ES2022](https://github.com/estree/estree/blob/master/es2022.md)。
- **yield / yield\***：它们是表达式，不是独立 statement 类型。必须区分生成器向外产出的值、后续 next(value) 向内送回的值，以及委托迭代器结果。不能把 yield 表达式结果一概当成其 argument。依据 [YieldExpression](https://tc39.es/ecma262/multipage/ecmascript-language-functions-and-classes.html#sec-generator-function-definitions-runtime-semantics-evaluation)。
- **await**：operand 是等待对象/值，完成结果和拒绝原因经过异步边界，不能按普通同步一元表达式处理；异步函数 return 也涉及 Promise 同化。依据 [Await](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#await)。
- **with**：修改名字解析环境，严格模式禁止；单纯词法 Binding→来源映射在此不足。依据 [with 语义](https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-with-statement)。
- **模块**：静态导入/导出与运行时表达式应分开，默认导出表达式需取值；导出列表保留绑定关系。依据 [模块语义](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html#sec-exports)。
- **表达式语句的完成值**：`const y = eval('a + b')` 中 `a+b` 虽未显式赋值，仍可能经 eval 结果逃逸；块、if、循环等也有完成记录传播。因此“独立表达式结果总被丢弃”不成立。应在确认结果不被宿主/eval 观察的上下文才停止结果传播，且 direct eval 不能因探针包装变为 indirect eval。依据 [PerformEval](https://tc39.es/ecma262/multipage/global-object.html#sec-performeval)。
- **资源声明**：初始化时登记释放方法，退出作用域时隐式调用，await using 还涉及等待；提前 return/throw/break 的路径也可能释放，释放异常可改变最终完成状态。建议单列资源绑定与释放边界。依据 [DisposeResources](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-disposeresources)。
- **默认导出和动态加载**：`export default a + b` 对计算结果建立模块默认导出绑定，不能因没有 VariableDeclarator 而丢失；`import(specifier, options)` 是实际运行时加载边界，其动态 specifier/options 和 Promise 结果应分析，不与静态 import 混淆。依据 [导出求值](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html#sec-exports)、[Import Calls](https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-import-calls)。

## 用于设计 AST 选择器的规则

建议输出一个语义记录列表，而非只找“最近 expression + 最近 statement”二元组：

1. **直接求值槽位**：读值最终参与哪个表达式结果、引用位置、调用参数/接收者，按执行路径提取输入。
2. **最近的传播/使用边界**：绑定、赋值、返回、抛出、调用、条件、属性/结构操作。结果丢弃与带副作用的操作分开。
3. **必要上下文**：控制条件、循环区域、异常处理、函数/异步边界，用于解释执行，不自动给所有内部值添加控制来源。

例：`if (ok) { const y = response.x + 1; }` 中 response.x 的直接传播边界是 y 的初始化；外层 if 可以保留作上下文，但它的 test 是 ok，不能把 response.x 记成 if 条件来源。`if (response.x) y = 1` 则记录 response.x 的控制使用，y 是否继承隐式控制来源必须是单独、明确的策略。

最易遗漏的事实是：**没有重新装箱，不表示没有使用；读到了值，也不表示它必然影响计算结果；处于某语句内部，也不表示影响该语句的控制决策。**
