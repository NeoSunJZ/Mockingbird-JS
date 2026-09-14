响应数据追踪的非装箱路线，2026-09-14

本次只核对设计路线、官方协议和公开实现，没有安装或运行下面的第三方追踪工具，没有修改 Mockingbird 的运行代码。“追踪调用”在本文指响应字段及派生值的实际使用和传播，而不只是观察某个函数是否执行。

对于保持业务原始值、又要构建实际派生链条的目标，主要机制是操作级代码插桩或执行引擎内部追踪。静态分析、断点、对象读取与宿主边界观测可以辅助，但各自提供的证据范围不同。

| 路线 | 来源信息放在哪里 | 触发方式 | 主要限制 |
|---|---|---|---|
| AST插桩与影子元数据 | 变量/临时值/参数/属性槽对应的旁路状态 | 执行插入的读取、运算、调用和返回探针 | 要覆盖相关代码与原生传播规则，选择性插桩的完整性需验证 |
| JS引擎内部追踪 | 引擎的值表示、运行时表、寄存器/AST依赖等 | 引擎执行指令或内建操作 | 改浏览器构建与维护成本高；现有实现类型范围有限 |
| 静态数据流/污点分析 | 程序的数据流图 | 分析可能的赋值、参数、返回及属性传播 | 表示潜在路径，不等于这次实际执行；框架与动态行为需模型 |
| CDP断点和单步 | 调试器的调用帧、作用域及外部分析状态 | 代码断点、函数调用断点、单步暂停 | 没有任意primitive的来源传播/watch接口；频繁暂停影响时序 |
| 对象读取加消费边界观测 | 对象属性来源和已知边界记录 | Proxy/getter、DOM/存储/网络hook | 能观察局部事件，不能独自恢复裸值中间的任意计算 |

**操作级插桩有可参考的现成基础，但不能把基础框架当完整EDE工具。**

Jalangi2提供变量读写、属性读写、二元运算、函数进入、调用和返回等分析回调；返回原值即可让业务继续处理原始类型。它可以作为探针体系和运行时组织方式的参考，实际污点来源、传播、消费判定及覆盖缺口仍需实现。[官方回调模板](https://github.com/Samsung/jalangi2/blob/master/src/js/runtime/analysisCallbackTemplate.js)

其README的测试环境描述仍提及Node 12，不能据“有浏览器支持”就断言现成版本适配当下React/Vue与完整现代JavaScript。本项目此前的小实验是自行实现的有限同步子集，也不是Jalangi2兼容性验收。[Jalangi2官方仓库](https://github.com/Samsung/jalangi2)

**引擎级方案能避免JS可见类型变化，但仍有覆盖边界。**

Foxhound修改Firefox的SpiderMonkey与Gecko，在内部字符串表示中携带taint。主线以字符串为核心；核查时数字扩展PR #211仍为Draft，不能视为发布版已完整支持数字/布尔值。它适合研究字符串传播，不宜直接覆盖Mockingbird的任意JSON字段目标。[官方仓库](https://github.com/SAP/project-foxhound)、[数字扩展](https://github.com/SAP/project-foxhound/pull/211)

Foxhound的structuredClone/postMessage传播修复PR #275核查时也仍为Draft，说明原生序列化路径并不会因进入引擎就自动拥有正确的传播能力。[官方修复PR](https://github.com/SAP/project-foxhound/pull/275)

PanoptiChrome修改V8字节码生成与运行时，并结合AST的数据/控制依赖和运行时来源表。公开补丁基于V8 11.6.189.2 / Chromium 116，需要专门构建或移植。[官方仓库及版本说明](https://github.com/therahulkanyal/PanoptiChrome)

其部分路径将Smi转换为V8内部HeapNumber，JS侧仍是number，这不同于业务可见的new Number包装。不过来源表存在对true/false、null、undefined、空字符串和部分Smi的过滤，另有AST标签机制，因此不能据此宣称全部基本类型、跨调用和转换都已完整覆盖。[数值转换](https://github.com/therahulkanyal/PanoptiChrome/blob/master/panoptichrome_patches.diff#L4261-L4264)、[过滤逻辑](https://github.com/therahulkanyal/PanoptiChrome/blob/master/panoptichrome_patches.diff#L5419-L5433)

它还提供单独的Blink字符串/存储补丁；JS引擎与浏览器宿主API需要分别维护传播规则。[Blink补丁](https://github.com/therahulkanyal/PanoptiChrome/blob/master/dom_storage_blink_patch.diff)

**静态分析适合减少需要观察的代码范围。**

CodeQL的JS/TS分析支持局部、全局数据流以及包含非保值操作的污点传播。可定义响应字段读取为Source、消费位置为Sink，分析可能路径，再用运行时证据确认。官方文档明确全局分析可能报告不可实际发生的路径，并有更高的时间和内存成本。因此建议将它作为候选生成或辅助分析，不把潜在可达等同于本轮有效使用。[CodeQL官方数据流文档](https://codeql.github.com/docs/codeql-language-guides/analyzing-data-flow-in-javascript-and-typescript/)

**CDP可以解释某条断链，但没有直接替换装箱的通用值观察能力。**

Debugger协议提供断点、单步、调用帧、scopeChain和实验性的setBreakpointOnFunctionCall。其setInstrumentationBreakpoint目前列举的是脚本执行前的事件，而非每个变量读取/运算。指定函数断点需要函数对象ID；它不等于跟随任意42或false的来源。暂停后读取值也无法区分两个相同值的不同来源，需要额外分析记录。[官方协议定义](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/js_protocol.pdl)

**getter、方法hook及字符串标记的能力不应被扩大。**

对象getter或返回原值的Proxy可记录response.name读取，但name脱离对象成为原始值之后的复制、运算和传参不会自动继续报告。修改String.prototype也不能覆盖所有字符串运算。DOM或存储hook只能看到当时的入参，值相等、子串匹配、水印标记都不能普遍证明其来自哪个原始字段；变异测试可辅助EDE判定，但不直接提供实际传播链。这些判断来自语言操作边界与当前项目已有实验，未把它们描述为完整替代方案。

针对Mockingbird的建议：如果要求普通浏览器、原始值语义和实际派生链，优先评估“原始响应对象读取观测 + 局部数据流分析选取位置 + 类型保持的运行时探针 + 已知原生/框架传播规则”。这仍需要选择性插桩，并不能保证只改最初几个赋值位置。若更重视少改业务脚本、愿意维护专用浏览器，可把PanoptiChrome/Foxhound路线作为独立研究方向，先验证数字、布尔、字符串转换、序列化及框架宿主边界，再决定是否投入移植。
