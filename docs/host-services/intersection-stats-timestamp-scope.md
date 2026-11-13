<a id="intersection-cleanup-and-stats-timestamp-implementation-scope"></a>
# Intersection 清理与 Stats 时间戳的实现范围

**简体中文** · [English](intersection-stats-timestamp-scope.en.md)


固定基线为微信 3.17.3、`miniprogram-api-typings@5.2.3`，1265 项 API × 七平台 = 8855 单元。本批补齐真实 Session Intersection 私有订阅与同步清理，以及 statSync/fstatSync 共用的真实文件时间戳快照。

<a id="private-subscription-lifecycle-of-intersection"></a>
## Intersection 的私有订阅生命周期

Session 使用共享 facade 的私有 Page/Component incarnation、observer/subscription ID 和完整 desired-state revision。两个引擎在 guest 执行前保存 capture/dispatch transport，公开 effect queue、兼容表和同名全局函数不再拥有订阅或回调权限。native 先依据完整快照移除已撤销项，再准入新项；owner token、page token 和真实 scope 在准入和通知时复核。

`disconnect()` 同步返回 void，先在本地不可逆撤销回调，再由后续 native 边界清理 registry；重复调用仍为 void。queued、同一批后续通知、能力撤销、组件卸载、页面 incarnation 替换和 Session 终止均不能恢复回调权限。有效订阅的状态只在 private delivery 成功后提交，后续公共诊断失败不重放已发布结果。非法 selector/root 的拒绝经 retained transport 消费该订阅；拒绝传输失败保留 retry debt，修复后无关效果可以继续。Intersection 与 MediaQuery 两个独立清理族先各自执行，再传播错误，避免一族准入失败阻止另一族收尾。margin Proxy 的重入不能绕过 nativeMode 单 relative root 约束。

这里只将零参数清理成员 `object:IntersectionObserver.disconnect` 在六个 native 平台计为 available，新增 6 单元，验收仍 pendingAcceptance。公开 native SDK 默认 Session 只准入 Skia/SkylineCompat，清理自身不需要 OS provider。Web 聚合单元继续 partial：Software/ExternalFrame/CanvasKit Skia 路径有共享清理，正式 WebView/DOM 路径仍明确禁用观察器，缺真实 DOM observer adapter。constructor、observe、relativeTo、relativeToViewport 的完整 selector、geometry/变换祖先裁剪、参数、payload、重用和固定版本语义继续 partial；factory 和 manifest capability 仍为 Partial。

<a id="true-timestamp-snapshot-of-stats"></a>
## Stats 的真实时间戳快照

statSync 与 fstatSync 分别取得实际路径 Metadata、实际已打开 File Metadata，再进入同一个 fallible StatsSnapshot。size、mode、两个时间戳和 predicates 来自同一份 Metadata；任一必需时间 accessor 出错即使整个 producer 失败，避免返回伪造的成功 0。

固定类型将 lastAccessedTime/lastModifiedTime 定义为 POSIX st_atime/st_mtime Number。转换以 i128 做有符号整秒计算；epoch−0.25 秒为 −1、epoch−1.25 秒为 −2。普通值保留 serde i64/u64 JSON 整数表示，超出这些表示的有界 SystemTime 秒数转为有限 f64，JavaScript 统一接收普通 Number；不引入 safe-integer 拒绝或 BigInt。快照不随文件时间修改、路径替换、fd close 或 owner 退役而改变。

两个独立时间戳字段在六个 native 平台新增 12 个 available；这是已修复 producer 与返回字段的实现，不是既有谓词的漏计纠正。公开 native managed_files_root 的同步安装链被明确绑定；producer 的完整路径/recursive/encoding/配额、缺失的异步 producer、mode/size 和 Web 持久化仍保留原缺口，不能由字段晋级反推。非 Unix mode 仍有原有合成值，不借时间戳修复晋级。Harmony 验证执行的是本机 Rust managed-files 委托，不声称 ArkTS 或设备执行。

<a id="verified-and-delivered-boundary"></a>
## 已验证与交付边界

两个候选分别在独立 no-local checkout 和独立 Cargo target 执行。Intersection 原生最终 90 次成功执行、82 个不同测试；新 8 个与 geometry 15 个明确遍历真实 QJS/V8。原始三个 fixture 表示断言失败、零测试 filter 和 runner 路径失败均保留，产品实现未因 fixture 修复变化。Stats 原生 25 次成功执行、24 个不同测试，另有 Node 94；真实 FileTimes、独立 Unix stat 值、实际 QJS/V8 Number/快照保留、Harmony Rust 委托和相邻 fd 生命周期通过；没有实现修补或失败。原候选与最终测试补充的身份分别保留。

选定工作区合并后另执行生产 bootstrap 的 Intersection 38 项、owner 52 项和组合格式检查。原生证据仅覆盖本机 macOS software/headless runtime；未执行 Windows/其他 OS、浏览器、设备、公开 SDK 消费端、微信 oracle 或商户验收。Windows 的通用 SystemTime/POSIX 源码路径与测试定义不等于 Windows 执行证据。

本批精确台账增量为 18 个 partial→available：Intersection 清理 6、Stats 时间戳字段 12。当前 available 1430（16.15%）/partial 983/requiresHostService 86/missing 6356，accepted 0、N/A 87，距目标 7084 仍差 5654。阶段 目标仍未完成，父全量验收 goal 保持 paused 且未完成。最终组合冻结和 Web 产物需由后续精确提交回执绑定，本段不将候选验证重标为提交后执行。
