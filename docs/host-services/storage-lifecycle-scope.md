# Storage 事务与应用生命周期通知的实现范围

本文说明共享存储的提交边界，以及应用前后台、页面销毁通知的实现和限制。源码清点按
微信基础库 3.17.3、`miniprogram-api-typings@5.2.3` 的固定 1265 API × 七端统计。
源码清点与实际平台验收分别记录；平台结论须绑定精确源码提交和可复核的执行证据。

## 源码清点变化

| API | Android/iOS/Harmony/Web/macOS/Windows/Linux | 单元变化 |
| --- | --- | ---: |
| `wx.onAppShow`、`wx.offAppShow`、`wx.onAppHide`、`wx.offAppHide` | partial → available | 28 |
| `wx.onBeforePageUnload`、`wx.offBeforePageUnload`、`wx.onAfterPageUnload`、`wx.offAfterPageUnload` | missing → available | 28 |
| `wx.batchSetStorage`、`wx.batchSetStorageSync` | missing → partial | 14 |

这八项生命周期 API 共用相同的真实运行时实现，新增 available 56。四项前后台通知是
已有 partial 的完成，四项页面销毁通知是新增实现。本批没有新增 storage available。
生成矩阵的当前候选值为 available **1393**、partial **995**、requiresHostService **86**、
missing **6381**，总数仍为 8855；accepted **0**、platformNotApplicable **87**。
available 占 15.73%，距离 7084 还差 5691。该源码清点不等于整批冻结或真实 SDK 验收。

此前 `wx.setStorage`、`wx.getStorage`、`wx.setStorageSync` 三项 × 七端共 21 单元的
高估更正保留。普通 quota 已实现，不能继续写成“完全没有 quota”；剩余 AES、完整
JSON 参数域和字节算法边界也不能因补了 quota 就从 missing 条件中删除。

固定类型文件 SHA-256 为
`25e9e6fdab1b4282ee5231d8f8de7a31a177d2edc690ec834e0da479cc166245`。
其 async set/get 定义包含 AES128 与 `encrypt` 配对；batch set 使用 `kvList`，同步
batch set 接收数组，没有 `encrypt` 参数。固定版本只有四项 batch 读写 API，没有
`batchRemoveStorage`。页面销毁通知中，before 的结果包含真实 `page`、`path`、
`routeEventId`，after 只包含 `path`、`routeEventId`；四个 off 均允许不传 listener
移除全部。不能根据其他版本或示例注释增加固定签名中不存在的能力。

## 存储从本地成功到宿主提交

原实现先修改 JS 存储，再排公开 patch；engine 在 Session 应用 patch 前就 ACK。
Rust 逐条应用时，后面的错误可能留下已提交前缀，JS 重放记录却已经释放。旧 clone
还会在 JSON 编码失败时返回原对象，随后修改、序列化或宿主刷新可能改变已经成功的值。

现在 QuickJS/V8 安装同一份 `container-core/src/storage.js`。写入先用启动时捕获的
JSON intrinsic 编码并验证，再预检完整事务，最后一次发布。batch setter 不循环调用
多个已成功的单项 setter。循环、BigInt、编码抛错、quota 或队列拒绝不会发布外层事务
前缀；getter/toJSON 中实际成功的嵌套写入保持自己的因果顺序，不被外层失败撤销。
读取返回独立快照，undefined/null/absent 继续分开保存。

私有 ledger 保存已接受的规范值字节、undefined 标记和连续事务序号。公开存储 map、
`storage.patch.batch` 与可伪造 sidecar 只作为兼容或诊断数据，不能取得写入权限。
native 捕获原始私有事务前缀，Session 先解码、验证，再通过 core typed transaction
提交。存储阶段先于无关的可失败公开 effect，避免一个无效 setData 丢掉已经成功的写入。
core 提交后先记录序号及 stamp，再 ACK ledger。ACK 失败重试时不重复应用已提交事务，
序列化期间新产生的 suffix 继续保留。

新增 storage-only reconciliation 直接从保留的 native ledger 取待提交事务，不转换公开
effects、不执行应用 microtask。即使公开 effect 的 toJSON 抛错或超过解码深度，后续宿主
写入、整个 MemoryStorage 替换或基线刷新前，也先按顺序提交已成功的 guest 写入。它不
通过重复完整 effect drain 来恢复，避免再次触发有副作用或持续失败的公开序列化。
已中断的 realm 仍服从 sticky execution fault，不能用 reconciliation 继续执行 guest。

`MemoryStorage` 以同一预检/提交路径处理 legacy 单项方法和新事务，预检失败不改值、
标记、计数、revision、stamp 或 runtime events。数值 `revision()` 与
`Session::storage_revision()` 保留兼容；freshness 改用不持久化的实例 stamp。
整个存储被另一个数值 revision 相同的实例替换时，engine 仍刷新，SDK 仍排队保存新快照。
SDK 只在 writer 接受快照后记录 stamp。

普通持久化格式保持 `values + undefinedKeys`，旧 values-only JSON 继续读取。usage
和 stamp 不写入磁盘。默认 restore 保留旧超限数据并重算计数，不截断、不在本批改为
strict 启动；超限状态只允许不增长的写入，remove/clear 可恢复，显式 strict restore
另行验证。native SDK 的合并全量快照 writer、atomic replace、flush/close barrier
和账号 namespace 边界保持原有职责。

## 存储限制

普通 quota 使用容器定义的逻辑算法：规范 JSON UTF8 payload 每值最多 1,048,576 字节，
每条按 `[key,payload]` 的字节数计总量，合计最多 10,485,760 字节；undefined 以 `null`
的四字节 charge 加独立类型标记保存。数字按 ECMAScript NumberToString 计费；
`currentSize` 对总字节向上取整为 KiB，`limitSize` 为 10240。这不是经微信参考环境
实测确认的字节算法，不等于持久化 JSON 文件大小。

Rust JSON 解码启用 `float_roundtrip`，保留 JSON 规范化后 JavaScript Number 的精确
IEEE754 位值。原近似解析会把部分有限小数解到相邻值，既改变读取结果，也可能让 native
重新计费多一字节，错误拒绝 JS 已接受的 1 MiB payload；本批同时覆盖数值位和 quota
临界值。该修复保证本容器两端的一致性，不把逻辑算法升级为微信实测算法。

key 沿用 native 的 Unicode White_Space 空白规则，保留原 key 字节，不自动 trim。
JS 不再直接使用与 Rust 规则不同的 ECMAScript trim：纯 U+0085 key 在发布前拒绝，
U+FEFF key 可读取旧快照并继续写入。这样不会先在 JS 成功，再在 core 提交时因空白
规则不一致失败；这是一项跨层兼容规则，不是新取得的微信边界行为证据。

新写入另有深度 128、节点数 1,000,000、每 batch 最多 100,000 条、未 ACK 事务最多
4096 条/64 MiB 的显式限制。legacy native 快照使用迭代中性复制，不把新写入深度限制
直接套到已有数据；这不承诺绕过整个 JSON bridge、磁盘解码或 engine 的其他预算。
JS 的 lone UTF16 surrogate 无法通过当前 Rust JSON Value 无损传递，现明确在发布前
拒绝，合法 surrogate pair 可通过。不能把该拒绝称为完整 JavaScript 字符串支持。

`wx.setStorage`、`wx.getStorage` 的 `encrypt:true` 明确失败，不写入伪加密的明文；
AES128、set/get 配对标记、加密 0.7 MB/7.1 MB quota、密钥生命周期与版本化密文 envelope
尚未实现，两项保持 partial。`wx.setStorageSync` 和两个 batch setter 也因上述完整
JSON/UTF16 与有限参数范围、字节算法确认缺口保持 partial，不凭注册或 quota 常量晋级。

`wx.batchGetStorage`、`wx.batchGetStorageSync` 仍 missing。尤其异步 batchGet 的结果字段
与缺 key 行为还需参考实现锁定，不能从 GeneralCallbackResult 猜测。Web KV 的冷启动
恢复/保存不是本批实现；OPFS 文件服务和 whole-Session Worker 也不提供该证明。其余七项
已有 storage API 沿用原清点范围，本批不将三个已确认的旧高估泛化成新的整组下修。

## 生命周期的接收者与收尾

前后台 listener 与 App hook 分开归属。on 去重注册，off 按函数 identity 移除，未传参
移除全部，均返回 undefined。派发读取 listener 快照，当前回调增删不会改写本次遍历；
普通 listener 异常报告后继续后面的回调。Session 通过 bootstrap 保留的 native dispatcher
发送通知，公开兼容别名不能替换 dispatcher。App hook 普通异常仍派发同一 transition
的 options，重复 show/hide 状态不重发。

路由销毁前按私有 receiver incarnation 找到实际 Page，before 暴露同一对象；hook 的
receiver 也从保留的 live-page 查找取得，避免 before 回调修改公共 page map、ID 或 route
后把 onUnload 发给伪造对象。用户 Page hook 本身仍属于应用对象；此处保留的是实际实例
身份，不是把应用方法冻结。after 只有在匹配实例已退休、routeEventId/path 一致时派发，
且不再包含 page。同步当前页面投影后，after 看不到已销毁页面。

同一次多页面 back/reLaunch 使用同一个路由事件 ID；cached tab 仅隐藏时不误报销毁。
直接 page.push/page.replace 先校验 path、query、data，再触发旧页面 hook 或修改 stack。
空白 path、非对象 query/data 等无效请求不退休当前实例，也不发 before/after 通知；
不能先销毁旧页面，再依靠新页面入栈失败恢复。
Page.onUnload 普通异常仍完成 observer、EventChannel、component 与 receiver 收尾，保留
原 hook 错误，避免清理覆盖原错误。after 回调可以触发新路由，旧实例不会重复通知。
终止 app unload 即使 hook 抛错，也清空 listener、待完成 departure 与 route 状态。
普通路由卸载通知和终止 app 的通知资源释放分别处理，不把终止清理伪装成新的路由事件。

原生 timeout/interruption 仍终止当前执行，不能重试已部分派发的回调，也不能假设有机会
执行 guest finally 来清理。`wx.onError`/`wx.offError` 的完整 unhandled-error 与 offError
无参清除、`wx.onPageNotFound`/`wx.offPageNotFound` 的真实缺页派发、`wx.nextTick` 与 UI
render transaction 完成的绑定仍有缺口，保持 partial。

V8 的 native installer、通知派发与私有 receiver capture 在 TryCatch 仍持有异常时读取
真实终止状态，保留 `Interrupted` 类型并记录到 adapter，后续纯 Rust 控制也拒绝继续。
空闲 isolate 的待处理中断请求本身不是已发生的执行故障；回归分别验证公共 interrupt
入口和执行循环中实际触发的 native 终止，不为策略设置方法加入 guest 执行探针。

## 验证与未验收边界

行为回归分别位于 core `storage.rs`、双引擎共享 `fixtures/storage-engine.rs`、runtime
`tests/storage_transactions.rs`、`tests/lifecycle_notifications.rs`，以及 SDK
`storage_stamp_tests`/既有 persistence 测试。覆盖拒绝不留前缀、嵌套 codec 写入、私有
authority、ACK/suffix、quota、depth、public conversion 失败后的宿主顺序、同 revision
替换、Number 精确往返与 1 MiB 临界值、Unicode key、无效直接导航、真实 Page 身份、
终止退休、listener/hook 异常和重入。Node source inventory 测试
验证证据链断开后不继续计数，不能替代这些真实 engine 行为测试。

开发期的编译、depth 与预算失败保留，后续通过不覆盖早期失败记录。最终 test 数量、
ignored、源码 hash 和精确提交由本批冻结证据记录；本范围文档不预先宣布全套门禁通过，
不将 Node VM、native engine、Session fixture、Skia CPU raster 统称为设备测试。

本批尚无七端公开 SDK、实际浏览器、物理设备、商户交易或新 native archive 安装验收。
旧 `2428f6c` 的 Web direct/Worker release CanvasKit 归档及新目录字节安装绑定旧源码，
不包含本批修改，也不能充当本批公开 SDK 执行。七个 SDK gitlink 未变化不表示旧 runtime
archive 已更新；如制作新归档，须绑定新产品提交、固定 sourceSha256、版本/坐标、license、
archive/manifest hash，并在新目录按固定 manifest hash 安装核对。构建、归档安装、实际
启动、公开 SDK、设备和交易分别记账，未执行的层级明确为 not-run，accepted 保持 0。

历史记录中的 sourceDirty 状态保持原值，不因文档整理宣称对应执行源已干净或完全可复现。
本文不作为 SDK 发行凭据；发行状态应以版本化 manifest 和对应验收记录为准。
旧 consent 浏览器 proposed 报告不能作为当前实现的正式 accepted 结果。
