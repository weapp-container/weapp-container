# Selector 私有调用链与 Stats 接收边界

固定基线为微信基础库 3.17.3、`miniprogram-api-typings@5.2.3`，1265 项 API × 七端 = 8855 单元。实现状态、源码测试、安装产物和真实 SDK 验收分别记账。本批 SelectorQuery、NodesRef 和所有文件 producer 的完整状态不因有限测试提升。

## Selector 的请求与生命周期

两个引擎共用 `selector-query.js`。请求、回调、实际 Page/Component incarnation 和选择时作用域存入私有状态；Session 通过原生保留的 capture/dispatch 函数读取和完成请求。公开诊断队列、对象别名和兼容函数不再承载这条调用链的 authority。没有实际 owner 的旧查询不能在稍后出现 Page 时借用其身份；仅保留原先 Created、尚未测量的手工嵌入扩展。

每个 NodesRef 保留其选取时的作用域，后续 builder.in() 不会重定向旧引用；便携 NodesRef.in() 扩展同时更新该引用。当前 Page 的回退只提供生命周期 authority，不虚构同步回调上下文；回调进入实际同步或显式 in(receiver) 的 owner，未指定上下文的 timer 保留旧行为。执行、每个 callback 以及失败结算重新核对原有 owner、作用域、当前页面和呈现模式。组件替换、隐藏、卸载、取消及原始 deadline 继续阻断旧结果。

私有异步完成在 Session 边界执行有界 Promise job 检查点；生命周期 retained dispatcher 本身仍不运行应用 job。原生收到一次投递 ACK 后移除 routing ticket，guest 在调度 callback 前先消费 pending 状态。job 新生成的即时查询会触发下一轮 effect drain，避免提前宣称队列静止。双引擎回归要求三个嵌套即时查询的最终 setData 直接出现在原始 dispatch；单独删除续跑条件的负对照准确失败，原始源码随后逐字节恢复。该机制不声明可重试传输：执行/环境故障会锁住 Session，没有持久 completion replay 协议。

## 基本几何及保留范围

基本 boundingClientRect/scrollOffset 投影共用公开 id、typed dataset、结果 slot 次序与 viewport 空身份。没有公开 id 的节点返回空字符串；内部 occurrence id 不能充当公开结果 id。viewport 不借用 render-root 的 id 或 dataset。

原生内容尺寸使用 renderer 实际用于 scroll clamping 的内容范围；Web 从 iframe 的真实 element 和 `document.scrollingElement` 读取内容尺寸与偏移。viewportExtent 只在新请求需要时出现，旧请求保持原形。原生 border-box、overflow、ink 和完整几何仍有缺口；没有据此声明微信布局等价。

exec 继续保留现有 Promise 扩展。锁定声明写 NodesRef，却没有定义返回选区；已保存的官方实现证据不足以支持构造终端 NodesRef cursor。本批不虚构该对象。

SelectorQuery/NodesRef 仍为 partial：完整 selector 语法（包括 `>>>`）、fields/computedStyle/properties、node/context/ref 的真实 handle、完整几何和固定版本生命周期/返回值范围尚未闭合。测试明确拒绝当前不支持的深层组合符，不把普通 descendant 伪装为其语义。

## Stats 方法与 producer 分开记账

共享 decoder 只在 stat/fstat/statSync/fstatSync 的文档返回位置转换内部标记：顶层 Stats、异步 result.stats、FileStats[].stats。方法捕获真实 native metadata 的两个布尔值；之后修改返回对象不改变既有快照。缺失、继承或非布尔 flag 被拒绝，业务 JSON 和额外字段保持数据。

六个原生 host 的 statSync/fstatSync 在本批前已返回可调用的 isFile()/isDirectory()。本批实际修复 Harmony 既有异步 stat 内嵌 Stats 仍暴露布尔值的接收缺陷，并补齐 API 专属解码。两个无参数 receiver 方法的 12 单元调整属于原有实现漏计纠正，不能表述为新增 12 项平台 API；Web 不在该范围。它们返回已取得 metadata 的快照，fd 关闭、路径替换及 owner retirement 不使本地谓词改读其他文件，也不允许继续访问退休 provider。

真正的 built-in recursive stat 和 async fstat 仍缺。使用真实磁盘 metadata 的测试适配器覆盖这些 wire 形状，只证明 receiver/decoder，不代表 SDK 安装了相应 producer。FileSystemManager 的路径、递归、编码、quota、fd 和其他参数缺口继续留在对应 producer 行。

Stats.mode 在非 Unix 仍合成权限，时间字段把不可用或 epoch 前值映为 0；这些成员保持 partial。size 未发现具体数值差异，但不在本批提升范围。12 单元的实现状态不代表六端构建、安装或 accepted。

## 真实浏览器的有限证据

隔离 headless Chromium 149 使用当前实际 DomViewPresenter。viewport 内容 900×1500→900×1800、window scroll 30/80、scroll-view 514×414→514×664、offset 45/60 均与浏览器原始采样相同。旧请求省略新增字段，stale/retired 请求拒绝，dispose 后 iframe 为 0；context、浏览器、页面和 loopback 服务全部关闭。

这不是公开 SDK、WeChat 3.17.3 oracle、设备或商户执行。首次测试把 boolean 放入只允许 string 的 legacy attrs，输入被严格拒绝；原始失败及清理记录保留。源码和原生测试的各轮失败同样保留，最终冻结结果以对应版本的证据为准。
