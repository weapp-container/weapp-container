<a id="dev-player-preview5-layout-navigation-and-fault-recovery"></a>
# Dev Player preview.5：布局、导航与故障恢复

**简体中文** · [English](p0-preview5.en.md)


本轮修复多分辨率、平板与折叠屏验收中暴露的共享边界问题。**本阶段尚未验收通过**。App17 `0.1.0-preview.5.7+17` 与匹配原生归档、Android APK、iOS Simulator ZIP 已实际构建；当前进展见下节。下文按版本保留实施与失败记录；后续结果不覆盖旧证据，也不给旧二进制重新绑定源码。

<a id="2026-11-02-stage-state"></a>
## 2026-11-02 阶段状态

App17 的原生生产者为 `6385949a3a48b22fa852b9d4e3cd4da1853c8e01`，设备构建服务使用后续 `ff07872db78050bb78147f5cc34487ca29c4da30` 的 watch 入口修正；服务源码不重新绑定原生二进制。[阶段证据入口](../archived-evidence.md)分别记录源码、SDK、安装包和测试方法身份。

| 设备 | 已完成的选定用例 | 当前限制 |
| --- | --- | --- |
| Android 小屏、大屏、平板 | 每类完成十轮完整批次（301 项检查）、C012 合计十轮、C018 十轮 | 平板使用独立的自然方向测试方法；不是硬件 GPU、性能或完整 Android 验收 |
| iPhone SE、Pro Max、iPad Simulator | 每类完成 C013、生命周期、C012、C018 各十轮 | iPad C018 使用独立 watch3 批次；Pro Max 的一份末帧呈现证明不足仍保留，不能推定实际屏幕 scanout |
| 通用折叠屏、Pixel Fold | 已采集真实铰链状态与独立窗口几何，修正测试方法并完成纯测试 | 通用折叠屏原 M4 失败保留；两类设备仍待 M5 十轮实际验收，诊断不能算 E2E 通过 |

本地默认 Rust workspace **2,405 passed / 9 ignored**、双引擎原生 workspace **2,706 passed / 11 ignored**、严格 Clippy、格式和 Player **240/240** 的原始源码绑定见[既有本地记录](../archived-evidence.md)，不把后续文档或测试方法提交追溯绑定为原生产者。View 默认预算仍为 **50 ms**。

preview.5.7 **尚未发布**，实际独立授权下载与六 SDK 默认锁晋级尚未完成；默认锁仍为 preview.5.3。十份新归档的本地离线审查及独立消费者结果不代替远端分发验收。硬件 GPU、性能、Windows／Linux 实际窗口、七宿主双渲染和微信 near-parity 门禁继续独立保留。本次阶段提交不关闭 P0 goal。

以下为 App16 失败与 App17 构建前的历史记录，保留当时状态及原始结论。

<a id="app16-failure-and-app17-fault-instance-exit-repair"></a>
## App16 失败与 App17 故障实例退出修复

App16 Android 小屏完成十轮普通／自定义导航与旋转，累计通过 301 项断言，在 C012 恢复截图阶段发现诊断入口后停止。新实例的 durable attempt 已 accepted，随后恢复了实际呈现与输入；与此同时，旧 poisoned View 在 unload 时再次请求 guest scope release，清理错误进入同一 controller 队列，随后被 Player 当作当前错误采用。新实例健康不能豁免真实的界面故障，原 full 保持 failed。其余 App16 Android 形态及 iOS 没有本版本的通过证据。详见[保留的 App16 失败](../archived-evidence.md)。

App17 将终态 session 退出与普通页面销毁分开：已 poisoned 的 View 直接释放原生 realm、scope 和缓存所有权，保留原始故障与指标；健康 View 仍要求完整 release ACK，AppService 的 detached、onUnload、取消与持久化规则继续执行。SDK 的退出错误携带旧 session 与 accepted identity；Player 只在严格证明来源是更早的已退出实例时记录独立历史，不清除当前错误、不恢复输入。未绑定、当前实例或不合法的来源继续按真实错误处理。

运行库与受影响 SDK 的当前源码版本为 `0.1.0-preview.5.7`，Player 为 `0.1.0-preview.5.7+17`，C ABI 保持 1。默认 View 预算仍为 50 ms。默认 Rust workspace **2,405 passed / 9 ignored**、双引擎原生 workspace **2,706 passed / 11 ignored**、两组严格 Clippy、Player **240/240**、相关 Node 与 SDK 检查已通过；[本地验证记录](../archived-evidence.md)绑定实际源码字节。这不代表新二进制、设备、授权下载或性能验收，App17 尚须构建后重放原失败与多形态十轮门禁。旧 preview.4/5/5.x 产物、默认下载锁与失败证据不改写。

<a id="app15-actual-results-and-post-mortem-diagnosis"></a>
## App15 实际结果与后续诊断

以下记录保留各版本实施时的状态，最新状态见上节。

<a id="preview56--app16-source-code-preparation"></a>
### preview.5.6 / App16 源码准备

后续运行库与六份 SDK 的当前源码版本为 `0.1.0-preview.5.6`，Player 为 `0.1.0-preview.5.6+16`；新原生库和安装包尚未完成构建，不能用 App15 字节代替。SDK 的默认下载锁继续保留原 preview.5.3，历史 `ORIGIN.json` 不改写；新候选锁仅在新归档构建、校验与授权下载后生成并显式使用。

运行时把第一次 View 撤权的操作、该操作的完整阶段指标及实际 provider batch 绑定到 `executionHealth.viewFault.details` 的版本化 witness。它只在首次 healthy→poison 时捕获，后续定时器或读取不覆盖；`monotonicElapsedNs` 仅相对该 View 实例，不能与设备绝对时钟混算。Inspector 只接受匹配 session、确需 restart 的封闭字段结构，保留原有传输大小、深度与节点限制，不导出任意 error details。

Player 另保留当前实际采用的失败及最近 16 份历史。SDK 的可选 `onFailure` 提供原生 View 操作归属，未设置时仍使用原 `onError`；退休 View 的诊断不能污染当前预览。错误 getter 或诊断 sink 自身抛错不应掩盖原故障。

Android 显式故障重启测试现在仅在身份一致的 `pending/prepared/restart` 收据下，使用原 15 秒期限等待新页面；普通空页面、失败收据、错误 owner/root/attempt 仍立即失败。该测试修正不将 App15 大屏原批次改为通过。现有单 watcher 可通过绝对路径环境变量 `WEAPP_CONTAINER_SIMULATOR_WATCH_DIAGNOSTICS` 启用有界入口诊断；它不增设 watcher、触发构建或改变发布期限，尚不能证明 C018 的唯一根因。

该批源码的默认 Rust、双引擎原生 workspace、严格 Clippy、Node、六 SDK 和 Flutter 门禁已通过，命令摘要、源码字节与保留的工具失败见[本地验证](../archived-evidence.md)。这尚不包含新二进制、设备、授权下载或性能验收。

App15 的 Player 源码是 `04892f3042bc38f5e2e1a7024f125ba3fc7e0653`，Flutter SDK 为 `b4729116883c05b7015fe8f50b59ed3a8b2d579a`。原生运行库继续使用 `b6a19b08946b059828895b293a3e71b6cbf5a9fc` 生产的 preview.5.5 原字节。默认 View 预算仍为 **50 ms**。

| 环境 | 已执行结果 | 保留的限制 |
| --- | --- | --- |
| iPhone SE、Pro Max、iPad Simulator | 每台完成 C013 十轮、生命周期十轮、C012 十轮；原 XCTest 与离线证据审查通过 | 不是 iOS 真机、GPU 性能或全部用例通过；生命周期等值不代表每轮写入不同值 |
| Android 小屏 | 首次新包回归在第 3 轮检测到诊断并停止；事后另观测到同实例 View 超时和正确撤权 | 初始诊断与约 173 秒后的超时不能合并为同一原因，保持 failed |
| Android 大屏 | 完成十轮导航/旋转、存储、工具覆盖、关闭重开和注入故障后的撤权，共 290 项断言 | 显式恢复采到 `prepared` 且尚无页面的收据，测试立即抛错，完整批次仍为 failed；稍后健康的新实例不能替代原失败 |
| Android 平板、通用折叠屏、Pixel Fold | 固定 AVD 已准备 | App15 尚未运行；先修正有身份约束的恢复等待，再执行后续矩阵 |
| C018 v3 / iPhone SE | 第 1、2 轮通过；第 3 轮失败候选验证通过，恢复发布等待失败 | 原 120 秒期限不变，没有自动重试；Pro Max、iPad 的本批 C018 未执行 |

C018 第 3 轮的健康源文件原子替换后，约 179.9 秒才生成对应编译输出；输出生成至 generation 17 发布约 0.28 秒。现有证据只能把主要空档定位到编译输出之前，不能证明唯一原因是文件系统通知、调度、GC 或 App Nap。显式清理确认了迟到的健康 generation；它不将原失败改为通过。

后续源码分别记录运行时首个 View 故障、Player 实际采用的错误及其操作身份，并为现有编译 watcher 增加可选入口诊断。它们不提高 deadline、不重复执行 View 调用，也不把历史健康采样当作故障反证。新源码须重新构建、绑定哈希和执行设备门禁。[App15 安全文本证据](../archived-evidence.md)保留原件哈希，并明确区分逐字节副本与派生摘要。

本任务的 Android 小屏、大屏及三台 iOS 模拟器已按准确归属关闭，保留设备数据与 Keychain。小米、既有 Web 服务及无关模拟器未操作。下面的 App14 及更早记录保持原结论。

<a id="app14-empirical-testing-and-app15-transaction-recovery-correction"></a>
## App14 实测与 App15 恢复事务修正

App14 绑定源码 `b6a19b08946b059828895b293a3e71b6cbf5a9fc`。iPhone SE 完成 C013 连续十轮和生命周期十轮；C012 前四轮通过，第五轮在显式重试后未能于原 25 秒内恢复可交互画面。新 session 的 attempt 已 accepted，AppService 定时器继续推进，108 份后续观测均健康但 `previewOccluded=true`，没有新 `onReady`。这是实际呈现恢复失败，不能当作又一次 View 超时，也不因前四轮通过而重试到绿色。

两个确定性 Player 反例另外证明：布局观察或 activation 尚未结束时，并发的 no-op flush 会提前消费输入恢复 lease。App15 在恢复入口增加事务所有权门禁，由原事务结束后的 flush 解除遮挡，保留故障、真实工具覆盖、前后台和几何授权检查。Player **220/220**、严格 analyze 与格式检查通过。模拟 cover 延迟的反例并未证明真实 iOS 命令乱序，activation 反例只证明提前解除遮挡；原设备失败的唯一交错仍未被日志证明，须以新包重放验收，不能宣称该失败已经关闭。

Android 小屏原首次运行因 ADB 连接丢失停止；随后一次受控重放在 93 项检查后因可访问性树只有四个 Android 包装节点、缺少胶囊而失败。原始稀疏样本保持有效，未增加等待胶囊或重复采集到成功的逻辑。新 persistent collector v3 已完成独立源码审查、离线测试和 helper APK 构建；尚未执行设备采集，不能算 Android E2E 通过。

App15 只修改 Player 协调层，运行库和 SDK 继续精确使用原 preview.5.5 生产者；build 15 不给其重新绑定源码。preview.5.5 已发布私有 prerelease，但本轮实际私有下载在 CDN body deadline 内未下载完整首个归档，线上独立安装为零。离线安装及服务端 digest 核对不能替代该失败；SDK 默认锁未因此前移。旧失败、源码哈希和本地检查见[本轮证据](../archived-evidence.md)。

<a id="app14-early-source-code-preparation-records"></a>
## App14 早期源码准备记录

以下保留设备执行前的准备状态，后续 App14 实际结果见上节。

App14 增加受限的 QuickJS 输出阶段诊断、明确的空操作 journal、iOS 布局取消原因，以及等待当前实际呈现输入的原生 SelectorQuery。后者暴露并修复了重复处理组件属性更新时再次撤销已消费 frame 的缺陷：消费资格来自实际渲染使用的私有 mutation 前缀，不能由 guest 消息、迟到 ACK 或纯重绘授予。原反例与修正测试分别保留。

`2dc41faf` 的默认 Rust workspace 为 **2,383 passed / 9 ignored**，双引擎原生 workspace 在 `browser_touch_retirement` 的 `app.init` 出现正常 View 准备超时后停止，记录为 **1,682 passed / 1 failed / 4 ignored**。严格 Clippy、Node、六 SDK 和 Flutter 的通过不能替代这项失败。一次保持 50 ms 的诊断重放未复现；原样本没有记录引擎或具体准备阶段，原因仍为 unknown，不能解释为已证明的 GC、冷启动或调度问题。

无 WXS、现代 View 或预编译声明的普通模板仍会在 `app.init` 创建 View realm 并加载空 registry，这是独立确认的重复工作。延迟该工作必须将 realm 构造、空 registry 初始化、文档注册、执行及结果验证全部纳入首次实际 render 的同一预算；旧 realm 的非空 registry 仍须清理。预编译及现代 View 保留启动时验证与注册。该优化不等于解释历史峰值，后续新源码必须重新执行本地及设备门禁。五种新 Android AVD 仅完成定义准备，尚未启动或安装 App14。

<a id="app12-current-device-result"></a>
## App12 当前设备结果

以下结果绑定 App 源码 `ed99d9b6ff7cf97557262d42573e8b2504f30669`、Flutter SDK `79da75144bd3f3b145c2e976049bf1f23a3edd1e`，原生运行库仍由 `012400d43cb20b4d91a73fbbde7e1cf11bd0bb6a` 生产。默认 View 预算保持 **50 ms**。

| 环境 | 已观测结果 | 本阶段状态 |
| --- | --- | --- |
| iPhone SE、Pro Max、iPad Simulator | 各完成 C013 十轮导航/旋转、生命周期、C012 超时撤权与恢复、C018 基线及失败候选，共 15 个阶段；三次实际 watcher 失败发布后均恢复并确认原生呈现与输入 | 选定用例 passed；不代表真机、性能或完整 iOS 验收 |
| Android 小屏 | 完成 276 项检查；正常 View 执行出现 `ERR_TIMEOUT`，该批 provider 墙钟约 133.7 ms。故障后输入与呈现授权已撤销，健康 AppService 继续运行 | failed；超时原因 unknown |
| Android 大屏原测试 | 完成十轮导航/旋转和 283 项检查，随后系统 `uiautomator dump` 返回退出码 0 但报告无法获得 idle，未生成新层级 | failed；采集基础设施失败不能算应用通过 |
| Android 大屏显式 no-idle 采集重跑 | 71 项检查通过；第二个 onLoad 不变量检查后，最后截图发现真实 `ERR_CANCELLED` 预览诊断，仅一轮完整截图闭环 | failed；不能从随后健康状态推断原始取消操作 |
| Android 平板、通用折叠屏、Pixel Fold | 专属 AVD 已准备，尚未执行新包矩阵 | not-run |

iOS 全文件严格安装检查的六项 executable 位变化仍保留为失败，另有仅允许这六条精确转换的资格说明；所有成员字节及主程序身份继续严格校验。iPad 的一个可变协调器出处文件后来追加恢复字段，旧引用哈希不匹配已披露，并以匹配原哈希的不可变快照保留原出处；后续两台直接绑定不可变快照。不能将这些说明改写为原严格检查通过。

已关闭本任务创建的三台 iOS 与 Android 小屏/大屏模拟器；原 Web 服务、无关模拟器及小米手机保持原状。安装包、逐阶段源码绑定、回执、截图清单及原始失败在受限本地证据中保留，[安全文本与派生摘要](../archived-evidence.md)单独归档。大屏重跑是在层级采集阶段检测到预览诊断后中止，不能解释为底层截图命令失败。

<a id="normal-timeout-and-post-error-boundary-correction"></a>
### 正常超时与后续修正边界

Android 小屏最后一个健康采样早于真实超时约 73 ms；后续同 session 的故障状态为 sticky，因此不存在用较早健康采样反证故障的依据。异常批次已命中程序缓存：准备约 13.5 µs、VM 输入解析约 22.7 ms、包含延迟编译的执行约 109.9 ms。此前正常批次约 1.6–2.4 ms。墙钟不足以区分 CPU、调度等待与宿主暂停，不将原因猜测为 GC 或模拟器负载。

同 pack 的 Android 空闲引擎重放 10,000 批未观测失败，但它不执行 AppService、导航或 GPU，也未包含失败批次的完整历史，不能用来关闭上述失败。已有表达式函数缓存；warm render 仍反复传输、解析和校验约 21 KiB 静态文档，是已确认的重复工作，但尚未证明它造成单次 136 ms 峰值。

后续原生诊断在显式 feature 下记录受限的 batch 序列、线程 CPU、monotonic/boottime 锚点与可选 Android ATrace；默认关闭，不记录 guest 数据。原预算起点、中断、取消和 poisoned realm 规则保持不变。新原生字节必须使用新的生产者和产物身份，不能改写 preview.5.3 原归档。

SDK 的独立确定性反例另证明：同一 controller 更换 View 后，旧 View 的迟到错误可能污染当前预览。修正以 View 租约和操作归属隔离退休回调，并保留活跃错误及退休清理失败；诊断 sink 自身失败也不能遮住原始错误或改变恢复控制流。这个已证明的缺陷不等于 Android 大屏历史取消的已确定原因，新包仍需实测。

<a id="implementation-checklist"></a>
## 实施清单

| 边界 | 本轮实现 | 仍需验收 |
| --- | --- | --- |
| View 超时后旧画面仍接收输入 | 独立 `executionHealth`，保留原始 typed code/stack；View 中断撤销命中、ACK、selector/observer 和 retained-frame 资格 | 新运行库下真实点击不再改变未呈现页面；显示原始故障及重启入口 |
| 健康 AppService 的独立运行 | 撤权只清理本地 authority/contact，不伪造 `onHide` 或 guest `touchcancel`；保留业务定时器和持久存储 | 真实定时器、宿主完成、覆盖/后台及资源释放交错 |
| C013 窗口与胶囊混用两次布局 | SDK 发出 owner/surface/observation 身份；Flutter 实测完整 `HostLayout`；同一 runtime 入口安装 viewport/display/menu 后再执行 resize hooks | 横竖屏、A→B→A、同尺寸 origin/DPR/safe-area 变化与迟到测量 |
| 首次加载/重试等待 native metrics | 候选预览保留在真实布局与 native window 中，禁用输入；关闭先取消测量归属；测量等待有限期限 | Android/iOS 冷启动、失败重试、加载中关闭，不出现未挂载等待环 |
| 导航目标布局 | 共享 runtime 排队规划导航；UI 按目标 chrome 测量后完成 ticket；等待期间无引擎长事务 | 默认/自定义导航、tab/back、嵌套导航、超时/取消；真实 `getCurrentPages` 与生命周期观测 |
| C018 pack 归属与 frame 变化混淆 | 独立 `{root,acceptedPackRevision,sessionId}`；SDK owner 范围内 attempt 与 CAS；64 份 terminal receipt 和单调高水位 | accepted 页面持续定时更新时候选启动失败；响应丢失、未知结果、receipt 淘汰及显式协调 |
| View 重复验证与编码 | 仅对完整 manifest 相等且 Arc 身份一致的不可变资源租约复用程序验证；源文档完全相等时复用验证/编码 | release 真机/模拟器分阶段耗时；不宣称已满足性能门槛 |

原失败分析保留在 [C013](../archived-evidence.md) 与 [C018](../archived-evidence.md)。这些文件仍是原版本的失败/建议证据，不改为本轮通过记录。

<a id="public-contract-and-compatibility-boundary"></a>
## 公共契约和兼容边界

[SDK preview.5 source 协议](https://github.com/weapp-container/sdk-contract/blob/main/PREVIEW5.md) 与 [TypeScript 声明](../../sdk/contract/types/weapp-container.d.ts) 定义完整 wire。C ABI 保持 **1**，现有 guest `weappContainer` 消息 API、Java namespace、包名和旧 SDK 方法继续保留。新 Player 必须协商 `chrome.atomicLayout` 与 `pack.devReload.attemptJournal`；旧二进制缺少所需能力时明确失败，不能静默回退成旧坐标/结果猜测。

完整布局通过 `hostLayout:{protocolVersion:"1.0",atomic:true}` 显式启用。atomic 模式拒绝分开的 `resize/windowMetrics/hostChrome` 绕过入口；未启用的 embedding 保留原路径。新身份以 canonical positive decimal u64 字符串传输，不能经过 JS Number。frame revision、pack acceptance revision、layout revision 和 surface generation 各有归属，互不替代。

原生观察不等于新环境已提交；新环境提交不等于 GPU 已呈现。等待测量、导航或故障时禁用不匹配画面的输入和呈现。提交后的生命周期/View 异常记录实际阶段与已提交状态，需要新 session 恢复，不能回放 hook 假装回滚。

View 默认执行预算仍为 **50 ms**，AppService/bridge 外层共享 deadline 只能缩短它。本轮未通过提高默认超时掩盖中断。不可变缓存只复用源验证和编码，不缓存有状态函数结果、不重排调用、不重置已中断 heap。`viewExecutionMetrics` 将准备、源文档验证/编码、provider、receipt 验证及释放分开记录；provider 内部未测量的 compile/transport 不虚构拆分。

<a id="current-verification-status"></a>
## 当前验证状态

<a id="preview5-real-failure-after-first-installation"></a>
### preview.5 首次安装后的真实失败

Android 小屏模拟器在未执行测试点击、未注入故障时，普通 250 ms 定时器刷新触发了 `ERR_TIMEOUT`。原生指标记录该 frontier 总计 53.016 ms，其中 document validation/encoding 为 49.054 ms、provider 为 3.501 ms；该批次的 document cache 未命中。View 已正确撤销输入和呈现权限，AppService 定时器继续运行，但这只证明故障隔离，不表示正常刷新通过。

已确认的缓存失效原因是 SDK 的普通 render 每帧重新提交全部 blob。运行时将其作为新输入重新校验并创建资源 Arc，导致无法命中 Session 已验证资源的身份缓存；模块准备又清除模板编码缓存。上述指标是墙钟阶段耗时，未单独量出调度等待，不能全部解释为 CPU 编码时间。修复让普通 render 使用 Session 当前已验证资源，manifest 替换或失败回滚后的首次提交仍重新验证对应资源；随后重放真实场景确认是否仍超时。资源授权只由 Session 维护，不增加 SDK 的第二份有效性标记，也不提高 50 ms 预算。

Android 的无障碍树缺少原生视图类，iOS 安装器清除了六个动态库的 executable 位，分别造成此前测试驱动拒绝继续。这些前置失败与上述运行时超时分别保留。新的驱动必须用原生层级、APK 混淆映射身份和独立尺寸观测验证 Android 几何；iOS 必须验证全部文件字节，只允许记录已观测到的六个精确路径权限转换，主 Runner 和其他成员继续严格校验。

- SDK-contract 的 Node 语法与 TypeScript 语义 fixture 已加入，覆盖大于 `2^53` 的字符串身份、完整布局、必须显式提交的 CAS，以及 `notRetained/notSeen` 查询分支。实际运行结果由本轮测试回执记录；独立 checkout 未安装可选 TypeScript 时，语义项明确 skipped。
- Runtime 新增 deterministic typed View timeout、原始错误保留、旧 ACK/recovery 撤权、DOM/raster contact 纯清理和 immutable cache 失效测试。真实 AppService timer 与 `onHide` 计数断言独立于 View 结果。preview.5 的冻结源码已完成 Rust/workspace、双引擎及严格 Clippy 回归；这些结果不自动覆盖后续 5.1 修复。
- Flutter 与 Android/iOS native wrapper 的候选布局、attempt reconciliation、close 和事件转发由对应本轮测试单独验收；声明或编译成功均不计作真实 UI/GPU 通过。
- preview.5 已生成七个目标的新原生库并发布私有 runtime 预览版，Android/iOS Player 安装包独立绑定原始 producer。Android 小屏安装运行后出现上述真实失败；iOS SE 完成安装字节校验后暂停，未据此宣称交互通过。5.1 已从冻结的 `747d0b02` 重新构建七个原生目标、AAR、XCFramework 与 macOS universal SDK，并生成十份归档。六 SDK 的新锁固定 manifest SHA-256 `bc2bf8a79ebb1ea1b7bcf2b5a4749271f2022c9b103773bd7be6ebc3b94271cd`；SDK pin 提交不替代归档内的原始 producer。5.1 Player 安装包与私有运行库分发已完成，完整设备回归尚未完成，首次交互结果见下文。小米已允许移除，本轮移动验证使用任务专属 Android 与 Apple 模拟器；不访问用户其他设备或其他任务模拟器。

<a id="preview51-distribution-and-first-interaction-results"></a>
### preview.5.1 分发与首次交互结果

`runtime-v0.1.0-preview.5.1` 已作为私有 prerelease 发布，13 个资产均与生产者字节及 API digest 一致。独立授权下载覆盖十份归档（275,076,726 字节），全新严格安装 10/10、归档重验 10/10、错误拒绝 3/3；旧 preview.2/3/4/5 的发布身份和资产保持不变。这是分发验收，不代表设备或性能验收。

绑定 `c6311792` 的 Android/iOS Player 安装包已完成打包。首次交互仍保留如下结果，不重新绑定到后续源码：

- Android 返回页的测试误要求 `navigateBack` 同时触发 `onHide/onUnload`，原记录为失败。微信公开生命周期文档只要求销毁时 `onUnload`；新的测试改为核对退出钩子的旧完整布局、目标 `onShow` 的新完整布局及跨页 journal，保留原失败，不增加固定版本官方 oracle 的通过项。
- Android 正常旋转另暴露真实 Player 诊断：多个原生 observation 推进时，异步布局提交收到 `ERR_CANCELLED`，Flutter 将其显示为预览故障。原运行库拒绝陈旧提交的保护继续保留；SDK 仅在原生完整身份能证明同一 owner 的更新 observation 或已提交的更高布局 revision 时协调旧操作，未知取消和执行故障仍报告错误。旧日志未保留被拒事务及精确原因，不能据此推定每次取消的具体 observation；新版增加允许列表中的原因和纯数字布局身份日志，需重新上机验证。
- iPhone SE 完成 10 轮旋转及普通/自定义导航、关闭重开、工具往返和 storage 保留。首次配对的系统打开链接确认未被处理，原失败保留；正常确认后的新配对单独记录。C012 已观测到 typed View 超时、输入撤权及健康 AppService，但测试随后尝试解析已从无障碍树隐藏的旧 platform view，未真正发出点击，保持失败。新测试使用故障前独立测量的屏幕点进行真实点击，仍要求业务数据不变、定时器推进及新实例恢复。

后续 SDK/Player 修正复用不可变 preview.5.1 原生归档，App 使用新的 build number 与源码/SDK SHA；不得给旧二进制改写生产者。必须以实际 App/SDK/native producer 提交、锁文件、安装产物 SHA-256 和运行环境记录新证据，再执行不同分辨率、平板、折叠姿态、点击/滚动/导航、旋转、安全区、语言切换、热更新、断网和退出清理。缺设备、驱动、签名或 runner 的项保持 blocked。

绑定 `224caca3` 的新一轮 Android 小屏测试在首次旋转时被外层监测器中止，未完成 10 轮。监测器将原生 `ERR_CANCELLED` 的原因识别为未知；停机后 Player 未显示或记录预览故障，SDK 健康且接受了更新的完整布局。这些后续观测不能代替取消发生时的身份，也不能将中断的用例改为通过。源码复核确认 C ABI 的错误消息带有 `ERR_CANCELLED: ` 前缀，而 Kotlin 安全日志仅匹配无前缀文本；后续诊断修正按错误码和完整文本精确匹配两种既有传输形式，未知原因继续拒绝。该修正不改变原生运行库、布局撤权规则或 View 预算。相同源码的 iOS 新应用仅完成安装校验，尚未开始行为用例。

iOS 交付是私有的 Simulator debug 应用；其 Flutter kernel 包含 Dart 源码文本和本机源码路径，不能称为无源码文本的分发包，也不能用于公开或真机发行。Android release 包和各原生运行库分别记录自身构建与内容审查结果。

绑定 `8177a05b` 的 build 8 在 Android 首轮旋转遇到新的 `ERR_INVALID_REQUEST`，且 Player 确实记录了预览故障；测试继续保持失败。原安全日志没有包含底层原因，Player 也仅保留泛化消息，不能把该条错误确定归因于某个 validation 分支。独立源码复核同时发现测量边界允许将旧 observation 的窗口尺寸与当前原生视图的 chrome 拼接；后续修正对该竞态增加确定性验证和测量一致性门禁，不改写旧 metrics、不强制创建 observation、不延长原测量或导航 deadline。该轮 iOS 仅完成绑定和健康首帧观测，尚未执行旋转、导航与故障用例。

build 9 的适配器在测量期间核对完整窗口观测、屏幕原点、密度及 SDK owner；旧请求取消只接受只读状态给出的严格身份进展。启动前的 `empty` 状态使用独立判定，遵循原生可选 session/page 字段的省略规则，不能用缺失 health 冒充健康执行实例。Player 的候选与导航准备同样拒绝迟到结果，取消证明无法确认时保留原错误，关闭时取消协调等待。新增边界回归后 Player 155/155、SDK Dart 69/69、Kotlin 26/26、Swift 33 组及相应编译检查通过；这些是注入边界和宿主测试，仍需新安装包的设备回归。

测量重试采用单次单调 10 秒 deadline，异步等待期间允许关闭或 detach；iOS 既有同步 `Session.state()` 调用本身无法被 MainActor 上的取消抢占。当前原生 state 是不执行 JS、无 I/O 的内存快照，但本轮不宣称可以抢占一个真正卡死的同步 FFI。

绑定 `f917aab3` 的 build 9 在 Android 小屏首次旋转之前出现真实 `ERR_NOT_READY`，外层监测器保留了原始仍为 running 的用例报告，另记录实际失败及中断；完成的 17 项前置检查不能当作旋转或故障恢复通过。原生日志记录 owner 2／surface 1／observation 2／layout revision 4，而停机后的已提交状态为同一 observation 的 revision 3、无 pending observation。完整被拒请求未被记录，因此该实测本身不证明具体哪个元数据字段产生了重复提交。原始启动日志含两条私有配对链接，只保留在本机受限文件中；归档使用经过检查的脱敏副本与原件哈希。iOS 同轮仅完成安装绑定及健康首帧观测，随后暂停，没有新增行为验收。

后续 build 10 修正按三层边界推进：Shell 将实际矩形与标题、导航栈等展示元数据分开；SDK 在等待原生 ready 后重新核对当前完整 observation，已消费的排队项不能提交、ACK 或解除遮挡；Player 只为真实布局变化请求一次新 observation，并分别等待真实事件和传输收据。原生 owner 以已验证的观察绑定，不能从 Flutter controller handle 推导。工具覆盖、导航及 surface 重建还需显式管理待测布局和旧等待的退休，不能通过吞掉错误或自动恢复故障画面解决。新 widget 回归已能在原版 Shell 上复现重复测量；这些注入测试不替代新安装包及多形态设备验收。

build 10 的输入恢复使用独立 lease；旧恢复的迟到成功或失败不能清除新 hold，关闭与新 barrier 会取消旧等待。活跃页面要求精确 session/page，普通几何变化先建立原生遮挡，再在同一次协调期限内请求观察。原版的三项恢复竞态反例及后续修正测试分别保留。当前前置回归为 Player **192/192**、Flutter SDK **88/88**，两侧静态分析和格式检查通过；这是绑定源码字节的本地验证，设备矩阵尚未因此通过，View 默认预算仍为 50 ms。

本轮不改冻结的 172 项 oracle、279 项双渲染和 46 项本轮场景范围，不通过缩减清单达成完成。五端客户端、七宿主双渲染与微信 near-parity 仍是各自独立的发布门禁。

<a id="build-10-actual-failure-and-build-11-fix"></a>
### build 10 实测失败与 build 11 修复

绑定 `5cd52d48`／Flutter SDK `1db45efa` 的 build 10 已完成新包校验并实际安装。Android 小屏首次自定义页横屏旋转后，测试报告配对连接断开，未完成后续轮次；事后同进程、同 session 自动恢复连接且健康，但事后状态不能替代断开当时的证据。源码发现 inactive 被当作真实后台断开连接，以及旧连接异步清理可能触及新连接。build 11 将 guest 前后台与开发连接状态分开，按连接 lease 管理回调、重试和清理；实际 Android 原失败原因仍需带新诊断重放确认。

同版 iPhone SE 的 C013 完成 10 轮，生命周期用例运行通过，但本次 storage 的旧值与写入值恰好相同，需要额外非碰撞检查。C012 已真实验证超时后点击不改变业务数据、健康定时器继续推进，旋转及工具往返没有清除故障；显式重试没有在原 25 秒验收期限内恢复可交互画面，保持失败。代码确认重启测量仍要求旧 View 健康，形成恢复等待环。

build 11 使用 `0.1.0-preview.5.2+11`，SDK 包装层增加受原生 journal 约束的 prepared-restart 测量，区分恢复与普通导航。仅测量不会恢复旧画面的输入。新增包装产物与锁必须重新构建、校验和分发；内部 Rust 仍保留 `747d0b02` 生产的 preview.5.1 原字节与原始收据。旧 preview.5.1 archive、build 10 安装包和失败证据不覆盖、不重新绑定。当前修复和单测不代表 build 11 的设备验收通过。

<a id="app11-local-and-pre-validation-at-the-wrapper-layer"></a>
### App11 本地与包装层前置验证

当前受控源码的 Player 回归 **212/212**、Flutter SDK **88/88**、Player 静态分析与 Dart 格式检查通过。Android/iOS 包装层源码检查通过；新分发版本为 **preview.5.2**，内部原生运行库仍为 **preview.5.1 / 747d0b02**。新十份实际归档的 manifest SHA-256 为 `10cf2f084601c9d0e2f06c54dcce4810527035beeee760f075b414651c67d829`。这些本地检查不替代 App11 模拟器交互。

iOS 重打包的严格全 XCFramework 字节比较仍记录为 **failed**：唯一差异为生成 `Info.plist` 的库数组顺序。独立 qualification 证明六个原生库、头文件与 modulemap 字节一致，plist 内容按 library identity 比较相同；不将该 qualification 改写为严格原字节门禁通过。原 App10 的 Android 旋转断连、iOS C012 重试失败及 storage 非碰撞补测需求继续保留。

<a id="app11-device-results-and-preview53-native-fix"></a>
### App11 设备结果与 preview.5.3 原生修正

私有 `runtime-v0.1.0-preview.5.2` 的十份归档已完成独立审查、授权实际下载、全新安装和重验（各 10/10）。原生字节仍绑定 preview.5.1 / `747d0b02`；App11 绑定 `c4e7f29f`，两者是不同生产者。iOS Simulator 使用 DEBUG 包，包含 Dart 源码及本地路径，只适合私有模拟器验证，不能当作无源码生产分发或真机 IPA。

App11 在 SE 上完成 C012 恢复、C013 连续十轮与同进程关闭重开的存储验证；prepared 短暂阶段未直接观测，不能宣称获得该阶段时延或真机持久化证据。Android 小屏十轮在首轮中断：部分测量取消没有落盘见证，且 fixture 缓存了旧方向按钮坐标，实际点击进入了错误的页面。原始报告仍保持 running/interrupted，补充诊断不将其改成通过。

随后双引擎确定性测试证明：窗口尺寸提交后，旧 Skia frame 的数字 revision 仍可能通过 ACK、selector 和 input 校验。这是实际运行时缺陷，不能仅修正测试坐标结案。新增独立的 Session 布局授权，与 consumed template input 及呈现收据分离；旋转、页面往返、失效 ACK、倍率与恢复都不能从旧像素重新授予布局。滚动及纯重绘只携带之前有效的布局授权，新帧仍需呈现回执。原生 SelectorQuery 显式 `.in(this)` 也改为真实 Page／Component 实例与 incarnation 验证，阻止旧实例回调借用当前页布局。

新 Rust／引擎字节要求独立的 `0.1.0-preview.5.3` 原生产物，Player 为 build 12；preview.5.2、App11 和旧失败材料保持不变。新构建、精确分发锁与多形态设备回归尚待完成，不能沿用旧包通过项。View 默认 50 ms 及外层 deadline 不变。

<a id="preview53-runtime-distribution-and-app12-preparation"></a>
### preview.5.3 运行库分发与 App12 准备

`runtime-v0.1.0-preview.5.3` 已发布为私有 prerelease。七个原生切片实际编译自 `012400d43cb20b4d91a73fbbde7e1cf11bd0bb6a`；Android、iOS、macOS SDK 的实际 producer 分别为 `e4fa84e784edc1a80d972655eea347537ca40774`、`159b7e2e66aa83e952e2af43edcd771344829379`、`ae67dde1a104587968e2db37a9636b8776328607`。归档与复验 envelope 为 `eff194421aa48ea7871b0989f9903f3636f6432e`，后续锁提交不改变这些生产者。manifest SHA-256 为 `ee393000b5726172755b24a31812f9b55051e710c2714edadb9b3ac287b95388`。

十份归档（275,129,421 字节）已完成独立逐成员、许可证和原生架构审查，离线安装 10/10、缓存复验 10/10、损坏拒绝 30/30。随后使用独立导出的 contract installer 和只读凭据实际下载十个目标，全新安装及缓存复验各 10/10；未认证的发布元数据访问返回 404。全部 13 个发布资产的大小和 API SHA-256 已核对，旧发布与 tag 保持不变。

桌面首次消费者验证因固定等待后未收到 geometry 而失败，原记录保留。独立重放在未消费呈现回执时观测到 `inputEnabled=false`，selector 正确返回 `ERR_RENDER: selector query awaits presentation`；已呈现重放可正常查询。消费者改为有界等待当前呈现授权后仅查询一次，新的实际 macOS Metal 消费者通过。此修正没有提高 View 预算，也没有重编译或重新绑定原生库。

当前六 SDK 锁一致，Node 合约检查 144/144、零 skip；Player 准备／构建／打包检查 25/25。上述结果仅完成源码与分发前置门禁，App12 安装包、Android／iOS 多形态交互与性能仍须另行记录，不能据此关闭 P0 goal 或增加官方 oracle 通过项。

<a id="preview54-static-document-registration-and-local-access-control"></a>
### preview.5.4 静态文档注册与本地门禁

在已验证资源缓存之外，View 现在按 realm/profile 注册完整静态文档并取得不可跨 realm 使用的句柄。后续批次只传当前任务，不再重复传输和解析静态 AST；模块变化、reset、dispose 及成功替换会撤销旧句柄。两种 profile 在任何有状态任务执行之前完成预检，注册、执行和结果验证共用原总 deadline。普通预检拒绝保留健康 registry；超时、取消或未知 VM/收据失败仍要求重建，不吞掉故障。

合并源码已完成默认 Rust workspace **2,343 passed / 9 ignored**、实际本机双引擎／Metal／诊断特性 **2,644 passed / 11 ignored**、两项严格 Clippy、格式，以及 **154 项**冻结清单和 source-binding 合约检查。精确源码、依赖、命令及日志哈希见[本地门禁归档](../archived-evidence.md)。该优化处理了已确认的重复静态传输；尚未证明已解释历史 136 ms 峰值，不能据此关闭正常场景超时或多形态设备门禁。新原生库与 App13 必须从新源码实际构建后另行验收。

<a id="app13-actual-build-and-retention-failure"></a>
### App13 实际构建与保留失败

iOS SE 的 C013 已实际完成十轮、二十组旋转回调对照；原 XCTest 通过，但两次 accepted 实例的 `hostLayout / ERR_CANCELLED` 仍未分类，前两份检查缺失诊断 journal。因此该结果不关闭本阶段 P0。版本、产物哈希、141 份终态来源及限制见 [SE 历史证据](../archived-evidence.md)。后续接口增强不追溯解释这些记录。

App13 已从应用源码 `b83f833f7c55074b2074a6d7d9c45bcc7a47d394`、原生 producer `69bcbaa8009b92ca76401f08565695ab5486b4f6` 实际构建。七个 native target、十个归档和独立离线安装审核已完成；这不是设备或私有下载鉴权验收。SDK 中 preview.5.3 的历史锁仍保留，新构建使用独立且明确的新 manifest。

Android 480×800 小屏在正常首页刷新中仍发生 View 超时。另一次新进程完整回归在第 7 轮从自定义导航返回首页后，因 fixture 选择器测量达到既定 250 ms／8 次边界而失败；189 项检查通过不能代替未完成的十轮门禁。该轮完整采样未观察到新的 View 故障，两类失败分别保留。详见[实际回归证据](../archived-evidence.md)。默认 View 预算保持 50 ms，不以显式重试或本机辅助回放的健康结果关闭故障。

Player 最近 16 条受控 View 操作诊断已接通只读 inspector，服务再次校验封闭字段并保留原生阶段指标；大响应仅裁诊断副本，不改变健康与授权。Player **216 项**、analyze/format 与实际合并服务的 **37 项** WSS/HTTP、inspector、dashboard、source-map 测试通过。同 binary/fixture 的隔离 macOS 重放分别完成 legacy、registered 各 10,000 批；warm wall p95 为 **1.318084 ms → 0.396042 ms**，输入字节 **51,727 → 30,491 B**。该辅助测试没有 Player、AppService、导航、GPU 或 Android，不替代实际设备循环和产品性能验收，历史故障仍未因此关闭。
