<a id="api-responsibilities-and-acceptance-ledger"></a>
# API 责任和验收记录

**简体中文** · [English](ACCEPTANCE.en.md)


固定输入保持 WeChat 基础库 3.17.3 和所有 1265 个目录名称。
`owner` 和 `kind` 保留其传输/安全含义。单独的 `responsibility` 字段标识运行时、设备适配器、宿主业务服务或生态系统工作；它从不授予注册权限，也不证明支持。

<a id="implementation-and-acceptance-are-separate"></a>
## 实现和验收是分开的

`implementationState` 记录 `missing`、`partial`、`available` 或 `requiresHostService`。源引用区分 `runtimeImplementation`、`runtimeBridge`、`jsFacade`、`protectedBoundary` 和 `platformProvider`。例如，`getDeviceInfo` 拥有一个同步的核心快照桥。`StrictHostProvider` 接受调用方提供的快照；它不会测量设备。没有安装原生数据源的核心桥是 `partial`。确定性 SandboxProvider 无法填补这一空缺。

公共的验收状态仍为 `implementedAndAccepted`、`pendingAcceptance` 和 `platformNotApplicable`。一个限制需要有现有的官方来源记录，并且不得与具体实现冲突。缺少凭证、硬件或代码会使单元保持待定状态。

<a id="files"></a>
## 文件

- `api-responsibilities.json` 包含每个确切名称一次，并将其有序名称摘要和基础库绑定到锁定目录。
- `acceptance-contracts.json` 定义了已审核的有限 API/宿主范围。一个 `completeApplicableScope` 合同只有在每个声明的 SDK/引擎链都有密封报告后才能推广一个 API；`partialScope` 记录证据但不会推广整个 API。
- `acceptance-ledger.json` 仅通过路径和 SHA-256 引用已密封的真实 SDK-链报告；历史构建、模拟器和源代码证据绝不会自动导入。
- `scripts/host-api-matrix.mjs` 验证报告和构建单元，但不执行报告内容。

<a id="contract-scopes"></a>
## 合同范围

一份审核后的合同确定了一个 API 和宿主。该宿主所需的每个公共 SDK 链路必须出现在至少一个有限的配置文件中：

| 宿主 | 所需链路 |
| --- | --- |
| Android | native, Flutter, React Native |
| iOS | SwiftPM, CocoaPods, Flutter, React Native |
| Harmony | native |
| 网页 | 直接, 工作线程 |
| macOS, Windows, Linux | native, Flutter |

每个配置文件均说明参数、平台条件、SDKs、适用的实际引擎（`quickjs` 或 `v8`）、语义/生命周期检查、源代码闭包以及任何必需的物理硬件或商户交易。审核必须明确列出该功能的拒绝、撤销、取消、清理、多账户和延迟结果情况。仅有一条成功路径并不能确立所有参数或生命周期行为。相应的运行时验收工作必须涵盖两种引擎的语义；平台配置文件必须使用实际由平台支持的引擎。

每个合同明确记录 `baselineCoverage: completeApplicableScope`
或 `partialScope`。审查的子集可以接受其各自的配置链，但整个 API 仍待定。审查者必须在覆盖锁定声明中的每个适用参数和条件后，才能声称完整范围；任何排除平台范围的官方限制都必须有充分理由。

该矩阵包含每个配置文件和 SDK/引擎链。缺少任一合同或任何链都会导致验收待定。验收状态仅适用于明确记录的参数和平台条件。

<a id="report-sealing-and-provenance"></a>
## 报告封存和来源追溯

一份报告的 `kind: real-sdk-chain`，声称有一个 API/宿主/配置/SDK/引擎。
它记录了确切的配置参数和平台范围；命名了操作系统和版本；浏览器及其版本（Web环境）；实际命令、零退出状态和基于摘要的原始输出；成功执行的公共 SDK、原生传输、真实 JS 以及完成/事件到 JS 的检查，加上所有配置特定的检查。

源记录使用相对于仓库的路径。源记录绑定仓库、提交和SHA-256；验证检查提交是可达的，并且Git对象和当前源都包含这些字节。配置文件声明了已审查的源闭包，包括核心和SDK/适配器/传输输入。一个无关的文档提交无需使证据无效；任何更改的源输入都会导致无效。子模块源绑定相应的SDK仓库提交。

运行时和 SDK 工具包每个都绑定文件摘要、源代码仓库/提交版本、预览版本、宿主、架构、功能集和能力协议。一个绑定摘要的构建回执必须匹配这些字段，并声明来自干净源代码的发布版构建。SDK 工具包还绑定公共 SDK 链。此新账本不会取代历史 ORIGIN 或归档证据。

清理回执列出了已创建和借入的资源。创建的资源必须关闭。借入的资源仍需保持保留，并需有记录的原因。缺少或失败的清理将导致报告无效。硬件或商户要求无法由模拟器/测试套件报告替代。

生成器只有在所有引用和作用域检查通过后才会计算验收；调用方无法直接设置已验收状态。现有的构建、有限测试、模拟器、硬件和商户证据仍属于不同类别。

<a id="current-baseline"></a>
## 当前基线

正式账本目前在直接/Worker QuickJS 链中推广了两个 Web 编码器 API 函数（`wx.arrayBufferToBase64` 和 `wx.base64ToArrayBuffer`）。它还为 `wx.canIUse`、`wx.getWindowInfo`、`wx.getSystemSetting`、`wx.getAppBaseInfo`、`wx.getDeviceInfo` 和 `wx.getAppAuthorizeSetting` 记录了有限的作用域；这些 API 仍待完成所有声明参数和条件后才可验收。`wx.getNetworkType` 有一个独立的 Web `partialScope` 合同，涵盖有限的在线/网络信息映射及其直接/Worker 回调链；该 API 在此范围之外仍待处理。其他所有函数仍处于待处理或平台受限状态，具体取决于生成的矩阵。源代码清单和验证器回归套件建立了账务完整性；它们不声称平台验收。
