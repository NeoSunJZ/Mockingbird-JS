> 历史审查：本文针对初始提交 `cf245f2`。后续代码已修复，当前状态与验证见 [implementation-status.md](implementation-status.md)，本文旧行号不对应当前实现。

Mockingbird 方法与实现审查，2026-09-14

本次仅审查“动态字段追踪 + 静态辅助补充插桩 + 消费点判定”的方法及当前实现，不评价论文实验指标，不补写自增/自减。分析基于当前 cf245f2 检出的代码。未修改运行代码；只新增本报告及实验记录。

**结论：方法值得保留，但当前实现不能可靠保证原程序语义，也不能保证贯穿 React/Vue 到实际消费点。最优先的改进是语义透明和可审计的来源传播；扩大插桩范围应排在它们之后。**

本次完成 34 个 Node/AST 隔离探针、8 组真实浏览器原始/追踪渲染对照、1 个 Vue 身份实验和2个网络模式实验。Node 26.0.0；Babel parser/traverse/generator/types 均为项目锁文件对应的 7.24.5，lodash 4.17.21。浏览器为 Chromium 151.0.7922.34，React/ReactDOM 19.1.1，Vue 3.4.21（项目锁定版本）。浏览器测试直接运行现有 injected.js，并使用独立 DOM 观察记录；不是整个 ede-killer.js 多轮调度器的端到端验收。Vue 重新包装 toDisplayString 的用例是显式模拟补充插桩效果，没有声称完整 runner 已自动选中并完成该改写。完整结果见[实验记录](/Users/sumorile/Desktop/Mockingbird-JS/NodeServer/docs/method-review-evidence.json)。

当前合理的设计包括：用动态读取缩小静态分析范围；跟随运行时位置做局部 AST 改写；通过重放延伸派生数据的追踪；只有相关输入已带来源时才传播来源。这些仍可作为后续方案的基础。但“有某字段读取日志”“派生值有来源”“到达预定义消费点”“真实执行了业务效果”是不同证据，需要分别记录。

**最严重的问题是主动装箱改变了语言语义。**

[injected.js:165](/Users/sumorile/Desktop/Mockingbird-JS/NodeServer/tools/injected.js:165) 及其子字段处理把 Number、Boolean、String 转成对象。实际结果：false、0、空串在条件判断中都成为真，typeof 数值变成 object，严格相等失效。这个问题不能靠补 get trap 或 valueOf 解决：对象的真假判断不执行这种转换。[ECMAScript ToBoolean](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-toboolean)

更直接的后果是 JSON.stringify({n:42,b:false,s:'Hi'}) 在追踪后变成 `{"n":{},"b":{},"s":{"0":"H","1":"i"}}`。所以它可能同时改变控制流、网络提交和本地存储结果。此时观测到的使用轨迹可能属于被插桩改变的程序，不能用于可靠的 EDE 结论。

建议把业务值与来源信息分开：基本类型保持原值；对象及属性槽的来源由 WeakMap 等旁路结构维护；局部变量、临时值、函数参数/返回值由 AST 插桩维护对应的来源槽。WeakMap 单独不能标记 primitive，同值 primitive 也不能按值作为唯一 key，否则两个同为 "admin" 的无关字段会被合并。此处需要真正的运行时数据流模型，不只是换一个元数据容器。

**方法接收者被统一绑定到快照，造成漏链和数据分叉。**

[injected.js:97](/Users/sumorile/Desktop/Mockingbird-JS/NodeServer/tools/injected.js:97) 的条件 `prop !== 'toString' || prop !== 'valueOf' || typeof prop !== 'symbol'` 恒为真。多数函数属性会提前返回，并 bind 到 `_f_src`；少数数组方法则 bind 到 target。这个选择直接绕开了代理读取，且 `_f_src` 是 structuredClone 得到的另一份数据。

| 现有代码的实际行为 | 方法层面的影响 |
|---|---|
| 对原 `[1,2]` 调用 push(3)，返回3，但代理数组 length 仍为2，快照 length为3 | 修改的是另一份数组，业务结果已改变 |
| slice 后的元素、for...of 的元素没有来源 | 迭代/复制从快照读出裸值，叶子字段日志缺失 |
| 每次读取 `.map` 返回新绑定函数，`a.map === a.map` 为 false | 方法身份被改变 |
| `proxy.hasOwnProperty('_f_src')` 为 false，但 descriptor 确实存在 | “已经代理”检查反而检查了快照，引发重复包装尝试 |
| `map(x => x)` 的数值对象仍有来源 | 并非所有数组操作都失败，应逐方法定义传播规则 |

建议将原始业务对象作为唯一的数据存储，把快照限制为诊断用途。对迭代、变更、复制、查找、字符串转换等操作分别定义 receiver、返回值、来源及身份规则；不要用“一律 bind”处理所有内建方法。原生方法传播规则还要连接到 AST 的函数调用/返回值记录。

**AST 插桩没有保证只求值一次，并且静态引用不等于实际参与计算的输入。**

[wrapExpressionsAtPositions](/Users/sumorile/Desktop/Mockingbird-JS/NodeServer/tools/tools.js:574) 将源表达式和重新生成的引用一同作为实参。以下使用真实改写函数，再用恒等 varProxy 对照执行，排除了 Proxy 本身的干扰：

| 原始表达式 | 改写后的问题 |
|---|---|
| `const x = obj.n + 1`，n 是 getter | getter从1次变2次 |
| `const x = get().n + 1` | get从1次变2次 |
| `const x = obj && obj.name`，obj为null | 原返回null，改写后强制访问obj.name并抛错 |
| `const x = false ? obj.name : 1` | 原返回1，改写后访问未选中的分支并抛错 |
| `const x = obj?.missing` | 生成额外自由变量missing，抛ReferenceError |
| `getObj().n += 1` | 当前预处理重复执行getObj |

最后一项来自 [splitVariableDeclarations:428](/Users/sumorile/Desktop/Mockingbird-JS/NodeServer/tools/tools.js:428) 对复合赋值的改写。这不是要求补齐自增支持，而是已有的 += 路径没有保存左值引用、对象和属性键的单次求值语义。

解决方向是对表达式建立保序的临时值/来源槽，只传播实际执行路径的输入来源；对逻辑表达式、可选链、条件表达式、调用 receiver、访问器、异常分别处理。不能用“先算结果，再把原引用全部读一遍”近似动态依赖。调用传播还需要区分函数对象、this 和参数：当前 `data.name.toUpperCase()` 被改为 `varProxy(data.name.toUpperCase(), 1, data.name.toUpperCase)`，额外输入是函数，而 varProxy 跳过函数；已复现输出 ALICE 没有来源。应追踪这里的字符串 receiver。

**只跟随赋值和显式 return，覆盖不了全部派生数据。**

[getExpression](/Users/sumorile/Desktop/Mockingbird-JS/NodeServer/tools/tools.js:79) 与 [wrapLists 收集](/Users/sumorile/Desktop/Mockingbird-JS/NodeServer/ede-killer.js:380) 的组合有以下明确缺口：

- `consume(data.name + '!')`：只得到 CallExpression、left=null，不进入补充插桩。consume 的参数已经是裸字符串；若它不是已知终点，后续传播无法仅靠该值的 Proxy 恢复。
- `x => x + 1`：简写箭头的函数体既无当前目标 expression，也无 ReturnStatement。数组回调常见这种形式。
- `const {x} = data`：id.name 为空，候选被 left 过滤跳过。简单解构可能仍保留已有对象代理，所以不是每次都漏；默认值、rest、派生初始值及后续参数传播仍需专门支持。
- 原生回调、对象/数组展开、字符串和数值转换、序列化、structured clone、postMessage、异步参数和返回值，都需要明确的传递语义或覆盖缺口记录。不能从“没有新的 get”推断不再有数据传播。

建议插桩粒度从“为几类语句包装结果”扩展为“记录值从读取到计算、调用、存储及控制条件的传递”。闭包、递归与异步任务需要有各自的执行上下文，不能使用跨所有表达式共享的“上一次读取来源”。

**来源模型会拼出不存在的原始字段。**

[injected.js:180](/Users/sumorile/Desktop/Mockingbird-JS/NodeServer/tools/injected.js:180) 合并输入来源，但构造子字段时用第一个父来源再追加新字段名。在实验中，从 `root[a]` 和 `root[b]` 计算 `{x:a+1,y:b+1}` 后，记录变成 `root[a][x]` 与 `root[a][y]`。它们既不是原始响应字段，也不能准确表示x和y各自依赖谁。

响应路径只能标识原始 Source，不能用来代替派生图。建议 Source 使用 responseId + JSON路径，派生值使用独立 nodeId，依赖通过父节点集合表达。对象上的每个槽分别记录其来源；重命名、组合、数组排序都不改变原始 Source 的身份。还应区分值依赖、字段存在性/长度/键集合依赖、控制依赖，避免把“用过数组长度”扩大成“读过所有元素值”。

**structuredClone 不适合成为包装每个值的前提。**

[injected.js:84](/Users/sumorile/Desktop/Mockingbird-JS/NodeServer/tools/injected.js:84) 在包装前深拷贝。`{x:trackedValue}` 是很常见的派生结构，但因为内部含Proxy会直接克隆失败，随后原样返回。实验确认：容器没有来源，原有子字段来源尚在；这是部分断链，而不是所有来源瞬间消失。Promise、函数、DOM/框架对象等还会扩大不支持范围。标准明确排除了Proxy的structured clone。[HTML StructuredSerializeInternal](https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal)

其他已复现的边界包括null读/写报错、合法业务键`_f_src`导致绕过包装、`hasOwnProperty`同名业务字段导致崩溃、冻结后ownKeys过滤元数据违反Proxy不变量、BigInt派生值调用不可构造的BigInt、字符串"123"被再次JSON解析成number。JSON.parse对非法输入还会返回原文本，改变全局异常行为。建议用旁路元数据、显式类型策略及边界内的JSON解析修复；不能让“不支持”静默变成“未使用”。

**React 中最明显的断点发生在协调阶段的类型分派。**

本次固定React 19.1.1。主要链路是组件/JSX → element.props → reconciliation → HostComponent/HostText → DOM。`shouldSetTextContent`及reconciler通过typeof区分文本与对象；装箱数值落入对象路径，无法匹配有效React元素后报错。[ReactFiberConfigDOM](https://github.com/facebook/react/blob/v19.1.1/packages/react-dom-bindings/src/client/ReactFiberConfigDOM.js#L584-L595)、[ReactChildFiber](https://github.com/facebook/react/blob/v19.1.1/packages/react-reconciler/src/ReactChildFiber.js#L1784-L1934)

| 真实浏览器场景 | 原始结果 | 使用当前注入代码 |
|---|---|---|
| 数字children | 42 | 空白并报非法React child |
| 字符串children | Alice | 仍为Alice，但DOM收到5个无来源裸字符 |
| false条件分支 | NO | YES |
| 显式String转换后作为children | Alice | Alice；DOM收到无来源裸字符串 |

第二行尤其重要：跟踪后字符串走迭代路径，观察到createTextNode分别收到A、l、i、c、e，均不带来源。看起来文字相同，但树结构和数据传递路径已发生变化。当前迭代器绑定快照解释了这些裸值的产生。

不能把“交给props”或“render执行过”直接算实际DOM消费。React明确区分render和commit，子组件可以忽略传入属性，渲染候选也不一定最终提交。记录应把候选来源接到宿主效果，并涵盖首次挂载及更新。[React render and commit](https://react.dev/learn/render-and-commit)

**Vue 的响应式Proxy叠加并不必然断链，但字符串规范化与再次装箱存在冲突。**

本次固定Vue 3.4.21，路径为ref/reactive → render effect → toDisplayString → VNode → renderer → nodeOps/patchProp → DOM。`toRaw(reactive(tracerProxy)) === tracerProxy` 已通过浏览器验证；剥离Vue自身Proxy不等于剥离tracer。Vue的ref和reactive逻辑对内部标志和原始对象有特定约定，不能概括为“Vue Proxy冲突必然丢标签”。[ref.ts](https://github.com/vuejs/core/blob/v3.4.21/packages/reactivity/src/ref.ts#L155-L181)、[reactive.ts](https://github.com/vuejs/core/blob/v3.4.21/packages/reactivity/src/reactive.ts#L359-L362)

| 真实浏览器场景 | 原始结果 | 使用当前注入代码 |
|---|---|---|
| ref对象的模板字符串/数字插值 | Alice / 42 | 仍能显示；textContent收到裸字符串 |
| false条件分支 | NO | YES |
| h('div',null,字符串字段) | Alice | 空白，无异常 |
| 将toDisplayString结果显式再varProxy后交给h | Alice | 空白，无异常 |

模板能够显示，是因为toDisplayString在相应路径执行String转换。再次包装得到的object进入normalizeChildren的对象/slot分支，不能按TEXT_CHILDREN处理。这个实验说明“继续往框架深处增加包装”并不单调提高覆盖率，可能破坏已经正常的路径。[toDisplayString.ts](https://github.com/vuejs/core/blob/v3.4.21/packages/shared/src/toDisplayString.ts#L17-L27)、[vnode.ts](https://github.com/vuejs/core/blob/v3.4.21/packages/runtime-core/src/vnode.ts#L781-L827)

**追到最底层，应定义为来源连接到浏览器宿主API或经验证的业务消费语义。**

仅使用网页JS插桩不能进入浏览器C++内部布局和绘制，也不需要以此为目标。对于DOM消费，建议覆盖下列位置；这些是源码定位结果，不表示当前工程已完成这些适配器：

| 效果 | React 19.1.1路径 | Vue 3.4.21路径 |
|---|---|---|
| 新文本节点 | createTextInstance → createTextNode | nodeOps.createText → createTextNode |
| 文本更新 | commitTextUpdate / setTextContent → nodeValue、textContent | nodeOps.setText/setElementText → nodeValue、textContent |
| 属性、样式、表单值、URL | setProp/updateProperties的对应分支 | patchProp → patchAttr/patchDOMProp/style分支 |
| 节点进入页面 | 对应宿主插入/提交操作 | mount/patch及宿主insert操作 |

对应源码：[React文本创建与更新](https://github.com/facebook/react/blob/v19.1.1/packages/react-dom-bindings/src/client/ReactFiberConfigDOM.js#L597-L618)、[React setTextContent](https://github.com/facebook/react/blob/v19.1.1/packages/react-dom-bindings/src/client/setTextContent.js#L21-L34)、[React DOM属性](https://github.com/facebook/react/blob/v19.1.1/packages/react-dom-bindings/src/client/ReactDOMComponent.js#L338-L374)、[Vue nodeOps](https://github.com/vuejs/core/blob/v3.4.21/packages/runtime-dom/src/nodeOps.ts#L37-L47)、[Vue patchProp](https://github.com/vuejs/core/blob/v3.4.21/packages/runtime-dom/src/patchProp.ts#L18-L66)。

DOM hook只会观察当时的入参，无法凭空恢复此前已丢失的来源。必须将业务计算、props/VNode及宿主调用连接起来。将整个框架函数笼统标为Sink会把属性复制、缓存、响应式依赖收集、被忽略props等误认为业务消费。另一方面，合法存储、导航、后续请求和控制判断也可能是真实用途，不能以没有DOM变化为由否定。节点创建与进入页面可以分别记为构建/提交证据，最终判定政策显式定义。

**入口拦截已经存在与框架无关的漏场景。**

[fetch实现](/Users/sumorile/Desktop/Mockingbird-JS/NodeServer/tools/injected.js:329) 先对所有响应await clone().text()，之后才检查是否目标URL。浏览器实验中，非目标流式请求原本能在收到响应头后resolve，注入后500ms仍未resolve，因为它在等待不会正常结束的响应体。目标response.text()读到的是ismocking包装信封，response.url变成空串。[XHR实现](/Users/sumorile/Desktop/Mockingbird-JS/NodeServer/tools/injected.js:274) 在load中才包装，readystatechange===4中读取的响应仍未标记；XMLHttpRequest.DONE也从4变成undefined。

建议先按origin/method/URL/响应类型确定目标，保留非目标响应原行为；为每个response实例维护来源，尽量保留原Response的身份、元数据和消费语义。分别验证json/text/clone/body流入口。XHR需覆盖响应可读的时机、不同responseType以及构造器静态属性/原型，不只load事件。responseType=json、空响应、错误响应、reviver、流式解析等仍需后续独立验收。

**脚本定位与迭代停止条件目前不能构成覆盖证明。**

以下为代码证据或局部解析实验，未进行整个runner的故障注入验收：

| 位置 | 缺口 | 建议 |
|---|---|---|
| ede-killer.js:151、325 | 按basename存脚本，不同目录/域名同名文件冲突；旧logs可复用上次改写结果 | 按完整URL、响应/脚本身份和内容hash管理不可变原文与各轮版本 |
| ede-killer.js:154 | 只处理.js结尾，漏.mjs、Vite转换模块、内联/eval/blob等 | 依据实际脚本登记与内容类型；未支持上下文明确登记 |
| tools.js:983、ede-killer.js:319 | 无函数名且带端口的标准V8栈解析为空；找不到目标帧时while会越界 | 统一栈解析、帧边界检查；用scriptId与生成版本位置映射辅助 |
| ede-killer.js:340 | 行列与AST区间启发式定位；嵌套表达式、压缩单行需专门验证 | 稳定siteId/源码版本；原始、变换后位置不要混用 |
| ede-killer.js:418 | 每轮追加init脚本，多个脚本的执行顺序不受保证，注入初始化还重置index | 单一bootstrap原子设置epoch与hooks，避免积累多份配置脚本 |
| ede-killer.js:63、427 | 发现任何候选立即进入下一轮，10秒没候选就停止 | 场景结束标记、目标响应完成、报告队列flush、候选成功改写及新增覆盖共同判断 |
| command.js:381 | 页面操作失败只输出错误，后续仍可能表现为无新候选 | 失败进入inconclusive状态，不作为成功收敛 |
| ede-killer.js:380 | 当前轮index过滤候选，包装失败/不可处理路径可能没有后续事件 | 区分发现、已改写、实际执行、仍失踪和不可支持site |
| ede-killer.js:412 | 清cookies/cache不等于完整场景重置，storage及后台任务可能跨轮 | 明确可重放初始状态、上下文生命周期、目标输入版本 |

多init脚本顺序不保证由[Playwright官方文档](https://playwright.dev/docs/api/class-page#page-add-init-script)明确说明。Worker、iframe、新页面及Service Worker需要各自确认注入、脚本捕获与事件归属；不能因主页面有hook便视为全上下文覆盖。

**日志需要从文本说明升级为可连接的事件。**

[saveCycleLogs](/Users/sumorile/Desktop/Mockingbird-JS/NodeServer/ede-killer.js:99) 当前写入字段名/来源与代码文本，丢弃了内存中部分fileURL、行列、目标及时间信息，未保留控制条件标记。不同调用、不同响应实例、不同脚本版本难以准确区分。reportLog是逐次跨上下文调用，每次get还在[injected.js:127](/Users/sumorile/Desktop/Mockingbird-JS/NodeServer/tools/injected.js:127) stringify整个当前对象的源快照。若包含N字段的大对象被逐字段访问，序列化总工作可达到O(N²)；这只是该日志路径的复杂度推导，不是整工具性能benchmark。

建议事件最少包含：run/epoch、responseId、executionContextId、script版本、siteId、operationKind、source/parent nodeIds、传播/控制/消费种类及coverage状态。Source原始快照按响应保存一次，事件发送ID，批量传输并显式flush。把框架类型探测、元数据访问和真正业务操作区分开；不要将所有Symbol合并成一个不可区分的“[symbol]”。停止或异常时保留未处理队列和断链位置。

在字段分类之外增加覆盖状态：正常观察到消费、在已完成场景中未见消费、追踪断裂/不支持、执行被插桩干扰。后两类不能自动降格为Unused。

**建议的改进顺序与验收条件。**

| 顺序 | 工作 | 验收条件 |
|---|---|---|
| 1 | 确立保留primitive语义的来源表示；修复receiver、单次求值与短路 | 原始/追踪结果在DOM、请求、异常、关键分支、对象/方法身份上符合约定；本报告复现用例恢复一致 |
| 2 | 独立的来源图与类型/调用传播规则 | 重命名、组合、多输入、数组迭代、方法receiver、参数、返回、序列化能映射回准确Source；不支持行为明确报出 |
| 3 | 原子bootstrap、完整脚本身份、稳定siteId、可验证重放/flush | 不再把缺日志或操作失败当收敛；每个候选的处理结果可查询 |
| 4 | React/Vue到宿主效果的版本化适配 | 同时验证业务传播、框架候选和实际消费；覆盖文本、属性、样式、表单、URL以及非DOM用途 |
| 5 | 在准确性稳定后优化缓存、去重、批处理、局部AST索引 | 度量事件量、重复栈、序列化字节、每轮耗时及内存，确认优化不减少必要证据 |

模块接口可以按真实差异收敛为：TraceRuntime维护值/槽与来源，Instrumenter接收代码和site计划并返回变换代码/位置映射/不支持项，ReplayController管理轮次完成条件，EffectAdapter连接框架或通用宿主操作，Analyzer根据完整证据分类。React与Vue是已有的两个不同适配场景，因此在这个位置设置可替换接口有现实依据；其他模块不必为假设的未来场景抽象过度。

下一批针对性验收应包含：React数字/字符串/false/数组children、忽略props的组件、派生字符串、首次渲染与state更新、表单/样式/URL；Vue模板与h的差异、ref/reactive/shallowRef/computed/toRaw、v-if/v-for/v-model、首次挂载与nextTick更新；共同覆盖异步请求、数组展开、回调简写、网络/存储、异常与空值。Suspense、Portal/Teleport、hydration、SSR/RSC、Worker与跨frame暂时应标为未验证能力，不能借本次小样本宣称全面支持。
