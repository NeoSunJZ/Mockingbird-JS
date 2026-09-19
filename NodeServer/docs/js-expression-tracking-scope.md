# JavaScript 表达式：Mockingbird 应关注的语义范围

2026-09-19。本文是下一步实现的语义分类，不代表现有代码已支持全部项目。不修改产品代码。与 [语句和声明完整分类](js-statement-semantics-research.md) 配套阅读。

## 结论

不能把“要分析的节点”“要补装箱的位置”“证明有效消费的 sink”视为同一张白名单。

对一次被追踪值的实际读取，应关注五类行为：

1. **保存和更新**：变量/属性/元素/绑定获得新值，值之后还可能被使用。
2. **传递**：进入调用参数/接收者/被调用目标，或跨 return、throw、await、yield、模块导出等位置。
3. **选择**：条件、短路、迭代决策及动态属性/调用目标选择。
4. **结构操作**：对象/数组构造、解构、展开、键、存在性、删除和成员读取。
5. **实际消费**：具体 DOM/storage/navigation/network/被声明的关键函数，以及项目定义的控制流 sink。

以上五类是面向 EDE 的设计建议，不是 ECMAScript 规范定义的污点算法。保留论文装箱/Proxy/AST/重放主流程；其中较新的语言结构是覆盖扩展，不应倒推成论文原算法已有完整支持。

规范基础：[ECMA-262 Expressions](https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html)、[ESTree ES5](https://github.com/estree/estree/blob/master/es5.md)、[ESTree ES2015](https://github.com/estree/estree/blob/master/es2015.md)。

## 表达式完整分类（标准运行时 JS，按语义合并 AST 变体）

| 节点类别 | 实际读值位置与处理建议 | 何时不需要独立补装箱 |
| --- | --- | --- |
| Identifier / ThisExpression | 解析实际绑定或 this 值，连接现有来源。声明名、标签、非计算属性名不是变量读取。 | 简单别名仍保留同一个代理时，不制造第二层代理；独立读取无后续值用途时只保留访问证据。 |
| 字面量：字符串、数值、布尔、null、BigInt、正则 | 固定字面量本身没有来自某次响应读取的直接数据来源；不能因旁边出现被追踪变量就污染它。 | 不将常量整体作为新的来源；隐式控制依赖须另设政策。 |
| MemberExpression / OptionalMemberExpression / ChainExpression；含私有成员、super 成员 | 区分 base、computed key、读/写/调用角色。动态 key 决定选哪个属性；getter 可执行代码；可选链有 nullish 短路。 | obj.x 中 x 是静态键名，不是变量 x；不能把对象整棵子树判为已消费。 |
| AssignmentExpression（=、算术/位复合赋值、&&=/||=/??=） | 区分目标 reference、RHS 和赋值表达式的结果。复合形式读取旧值；逻辑赋值具有分支。左侧 object/key 的求值也可能依赖响应。 | 普通赋值左侧标识符不是旧值读取；RHS 无来源且无显式控制传播策略，不应继承旧标签。 |
| UpdateExpression（前后 ++/--） | 数值转换、更新目标和前/后缀结果分别追踪，保持一次求值。 | 不因结果被丢弃而忽略目标更新。 |
| BinaryExpression（算术、位、比较、in、instanceof） | 结果进入后续用途时维护来源；in 是结构存在性，instanceof 是类型/原型检查，不能与字段内容使用混为一谈。 | 结果确实丢弃时不为结果补代理；仍处理隐式转换、has/hasInstance、异常等实际副作用。 |
| UnaryExpression：+、-、!、~、typeof | 数值/布尔/类型派生，按外层用途处理；typeof 未声明变量的规则必须保留。 | 结果未被使用时不继续传播结果，不能把所有一元表达式当作 sink。 |
| UnaryExpression：delete | 修改属性存在性；关注 base/key、删除效果和布尔结果。 | 不能因它是一元表达式而丢弃其写入/结构效果；delete obj.x 不等于读取 obj.x 的值。 |
| UnaryExpression：void | 子表达式照常执行，结果为 undefined；继续分析子表达式中的调用/写入等。 | 不把子表达式的数据来源自动传播为 void 结果的直接数据来源。 |
| LogicalExpression（&&、||、??） | 左侧决定是否求值右侧；表达式结果是所选操作数，而非统一 Boolean。分别记录选择与所选值来源。 | 未执行的一侧不是本次运行输入；不扩大到所有语法子节点。 |
| ConditionalExpression（?:） | test 是条件用途；只有实际选中的分支贡献直接结果。控制依赖与直接数据依赖分开。 | 不把两个分支来源全合并，尤其不执行未选中分支来收集依赖。 |
| SequenceExpression（逗号） | 每项均执行，最后一项提供直接结果；前面的项仍可能调用、写入或抛出。 | 前项被读取但结果丢弃，不自动成为最终结果的数据来源。 |
| ParenthesizedExpression / 括号标记 | 按内部表达式分析，保留语法位置和调用 reference 语义。 | 不把括号单独当作传播目标或 sink。 |
| CallExpression / OptionalCallExpression | 关注实际 callee、receiver、每个实际参数、返回和副作用；可选调用保持短路。只有已认定的调用才是 sink，普通调用继续追踪。 | f(x) 返回结果丢弃不代表参数没被消费；也不能认定所有函数调用都必要。 |
| NewExpression（包括构造过程与 super 调用） | 参数、构造器、this 初始化、结果对象与构造副作用；原生对象需要具体模型。 | 不把一个参数的来源赋给实例的全部字段，也不能因结果丢弃而忽略构造副作用。 |
| ArrayExpression / ObjectExpression | 每个元素、属性值、计算键独立分析；包含 getter/method 定义时区分定义与后续执行。 | 容器存在一个带来源字段，不代表所有字段都有同一来源。 |
| TemplateLiteral | 每个插值及转换参与字符串生成；按字符串结果去向继续分析。 | 纯模板结果确认丢弃时，不独立代理结果；保留转换副作用。 |
| TaggedTemplateExpression | 是调用边界，关注 tag、接收者、插值参数、返回与副作用。 | 不按普通字符串拼接处理；tag 可返回任何值。 |
| FunctionExpression / ArrowFunctionExpression（含 async/generator） | 参数/默认值按调用处理，闭包体按实际执行处理，简写箭头体等价于返回用途。 | 创建闭包不等于执行函数体；自由变量出现在函数文本里，不足以污染函数对象。 |
| ClassExpression | extends、计算键、静态字段/static block 在类定义时分析；实例字段初始化、方法调用另按实际执行时机处理。 | 不把类体作为一个同步表达式收集全部读取；不能跳过静态初始化副作用。 |
| AwaitExpression | 等待输入、兑现值或拒绝原因、恢复执行。异步函数 return 还涉及 Promise 同化。 | 不是普通同步一元运算；不能用共享全局 capture 跨 await 包围其他任务。 |
| YieldExpression（yield/yield*） | 向外产出值、next(value) 恢复输入、委托迭代分别处理。 | yield 表达式的最终结果不总是其 argument。 |
| ImportExpression / Babel 7 的 CallExpression(callee=Import) | 动态模块标识符、选项、实际加载行为及 Promise 结果。 | 不与静态 import 声明混淆。 |
| MetaProperty（new.target、import.meta）/ Super | 作为构造/模块/父类 reference 上下文。若字段流入这些对象的后续属性操作，按真实操作分析。 | 单凭出现节点就不应制造响应来源；Super 不是普通可独立读取的值。 |

节点定义与差异依据：[ESTree ES2015](https://github.com/estree/estree/blob/master/es2015.md)、[ES2017 await](https://github.com/estree/estree/blob/master/es2017.md)、[ES2018 spread/async iteration](https://github.com/estree/estree/blob/master/es2018.md)、[ES2020 optional chain/import](https://github.com/estree/estree/blob/master/es2020.md)、[ES2021 logical assignment](https://github.com/estree/estree/blob/master/es2021.md)、[ES2022 fields/static blocks](https://github.com/estree/estree/blob/master/es2022.md)。

## 不属于 Expression/Statement 但必须分析的辅助节点

| 节点/位置 | 必要分析 |
| --- | --- |
| ObjectPattern / ArrayPattern | 被解构对象或迭代器 → 每个实际绑定/赋值；包括计算键。 |
| AssignmentPattern | 仅在默认分支实际执行时读取右侧；包含函数参数、解构默认值。 |
| RestElement | 剩余参数/属性/元素的实际来源，不污染未复制项。 |
| SpreadElement | 对象展开涉及取键取值，数组/参数展开涉及迭代；按实际拷贝/产出项传播。 |
| ObjectProperty / ObjectMethod | shorthand `{a}` 是值读取；`{a: 0}` 的 a 不是标识符读取；计算 key 与 value 分开。方法体延后执行。 |
| ClassProperty / ClassPrivateProperty / ClassMethod / ClassPrivateMethod / StaticBlock | 类定义、实例初始化、方法调用的时机和来源分别处理。 |
| SwitchCase / CatchClause | 动态 case.test 与异常绑定，不要遗漏非 Statement 节点。 |
| 函数 params、for-in/of left、export default expression | 是隐式绑定/传递位置，即使没有显式 `x = ...` 也需要分析。 |

Babel 和 ESTree 名称不同：Literal 被拆成具体字面量节点，Property 拆成 ObjectProperty/ObjectMethod，可选链有独立 OptionalMemberExpression/OptionalCallExpression；动态 import 形态受版本/选项影响。依据 [Babel parser AST output](https://babeljs.io/docs/babel-parser#output)。应按项目实际 parser 输出编写规则，而不是把所有 Babel aliases 都视为标准 JS。

## 何时可以停止结果传播

建议只在确认以下条件后停止：表达式结果没有被保存、传参、返回、产出、用于选择或被宿主读取，且相关副作用已独立分析。不是删除原语句，也不是撤销访问日志。

- `a+b;`：普通程序中若结果确实丢弃，可停止结果传播；但对象转换仍可能执行用户代码。
- `const x=a+b`、`return a+b`、`consume(a+b)`、`if(a+b)`、`()=>a+b`、`export default a+b`：均有明确去向。
- `const x=(read(a),0)`：read(a) 独立分析；0 的直接数据来源不能默认取 read(a) 所读的全部来源。
- `eval('a+b')` 可观察表达式语句的正常完成值，因此不能仅根据 ExpressionStatement 判定结果丢弃。依据 [PerformEval](https://tc39.es/ecma262/multipage/global-object.html#sec-performeval)。
- 逗号的前项即使结果不使用也必须 GetValue，规范明确保留可观察副作用；见 [Comma Operator](https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-comma-operator)。

一个位置可以对应多种用途：`if ((x = response.n + 1) > 3)` 同时有 x 的值传播和条件使用；`if (ok) { x = response.n + 1; }` 中 response.n 不因此成为 if 的条件来源。

## 支持范围说明

本文覆盖标准运行时 JavaScript 的表达式、语句及必要辅助节点；语句明细见配套报告，包括 using/await using 的隐式释放。规范中的语法可用性与项目 Babel 7.24.5/浏览器能力是两件事，应明确报告未支持语法。

JSX/TS/Flow/装饰器及其他提案节点不能混入标准节点白名单。若处理浏览器实际执行的构建产物，通常分析转换后的标准 JS；若明确直接解析源文件，则 JSX 的 props/children/表达式容器需展开，纯类型节点不参与运行时传播，而 TS enum/namespace 等可产生运行时代码的语法需要编译语义。本文不声称这些扩展已实现。

## 与当前算法的关系

声明/赋值/update 是论文补充装箱的核心候选；控制条件和特定调用属于使用分析。为减少现代 JS 漏场景，return、计算实参、结构构造、解构、async/generator、模块和隐式协议需要单独的规则或明确缺口。所有候选仍受“本次相关输入已被追踪”的运行时门控约束，但门控不是结果精确因果依赖的证明。

最小而正确的下一步不是给所有表达式套 Proxy，而是让 AST 分析器返回：本次变量实际所在的输入位置、值去向、控制角色与副作用位置，再分别决定传播和消费。
