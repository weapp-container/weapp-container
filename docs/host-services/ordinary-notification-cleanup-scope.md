<a id="private-cleanup-of-application-and-device-notifications-twenty-at-a-time"></a>
# 二十组应用与设备通知的私有清理

**简体中文** · [English](ordinary-notification-cleanup-scope.en.md)


产品提交 `5760beb9b2f231e1cbe420858735c5cda4da374c`，父提交 `0ac6bac792ab32282aace7afdde623de8b9bfa3b`。固定依据为微信基础库 3.17.3、miniprogram-api-typings@5.2.3；声明文件 SHA256 `25e9e6fdab1b4282ee5231d8f8de7a31a177d2edc690ec834e0da479cc166245`。

覆盖 ApiCategoryChange、AudioInterruptionBegin/End、KeyboardHeightChange、LocalServiceDiscoveryStop/Found/Lost/ResolveFail、MemoryWarning、ScreenRecordingStateChanged、ThemeChange、VoIPChatInterrupted/MembersChanged/SpeakersChanged/StateChanged、VoIPVideoMembersChanged、BatteryInfoChange、BLEPeripheralConnectionStateChanged、DeviceMotionChange、NetworkWeakChange 二十组。每个 on 要求原函数 listener；每个 off 接受可选原函数，省略或 undefined 清空该组，全部返回 undefined。没有加入 GeneratePoster、UserCaptureScreen、KeyDown、KeyUp 或 WindowStateChange。

共享 lexical owner 现在同时持有原十组和新二十组的实际回调；off 同步撤销投递身份、清空函数引用，只保留预留取消节点。Session 沿订阅创建调用取消真实 NativeSubscription，完成取消后才确认指定前缀；同 turn 中已删除的排队 on 不会复活。不可复用 u64 身份、4096 活跃加未确认取消预算、受信快照、Session/account/object/event/sequence/size 栅栏、错误结算后继续扫过其余资源、fallible 公共 effect 转换前后协调及终态退休均沿原实现。

新二十组 on 保留既有注册宿主的 Full/Partial、缺省能力和 provider 协商；只有原十组保持独立 Partial ceiling。新 on 在分配身份、保存函数或消耗预算前必须具有实际 producer descriptor。新二十个 off 加入 runtime_owned，on 仍可由可选宿主注册；没有增加默认授权。公开能力表、方法、诊断数组、descriptor 或 foreign counterpart 不能成为第二个有效回调所有者。on 撤权和终态清理独立于 off 的公开授权。

off 只取消对应订阅创建者，不调用 legacy off，也不停止共享传感器、关闭 BLE server、断开其 peer、关闭 VoIP 会话或替换其他 battery/network producer。BatteryInfoChange 的低功耗模式、BLE 的 connected/deviceId/serverId、DeviceMotion 的 alpha/beta/gamma 与独立 start/stop、NetworkWeakChange 的 networkType/weakNet 均保留各自范围。DeviceMotion on/off 的插件声明不同，LocalServiceResolveFail 与 DeviceMotion off 的固定 callback alias 也分别保留；清理按函数身份比较，不调用 off callback。每侧 permission、since、plugin 元数据和已有 87 项 N/A 不变。宿主授予 Full 不等于该 on 已达到完整实现或平台验收；二十组 on 的实际 producer、固定 payload、时序和插件缺口继续显式记录为 Partial。

集成验证记录包括已通过的新旧 Node composition 106/106、相关通知 287/287 外层测试、真实 QuickJS/V8 native integration 原 7 个和新 9 个函数（函数内部循环 enabled engines/各组）、清点/矩阵/IO 913/913、fmt、workspace all-targets locked check、全部 features 严格 Clippy、runtime all-features lib 758 passed/2 ignored，以及完整四线程 workspace：134 个结果块、3056 passed/0 failed/10 ignored。上述命令有重叠，不累加为独立覆盖。无 native feature 的 check exit0 并保留 35 条 warning，不宣称 warning-free 或已证明它们预先存在。生产 WASM `wasm,quickjs-native` check 通过；仅为编译检查。

首轮 WASM check exit101 原样保留：PATH 中 Homebrew Rust 1.99.0 没有对应 WASM std，虽然独立 rustup 工具链已安装该 target；首命令也没有选择 production QuickJS feature。后继按仓库 build-web-wasm 的选择方式显式使用 rustup cargo/RUSTC/RUSTDOC 与 LLVM、`wasm,quickjs-native` 后通过，没有改变全局 PATH 或产品源码。首轮源码快照逐文件 Git 读取因 51491 tracked 路径过慢而在集成前停止，后继使用单次 batch；矩阵差异数据与运行回执同名覆盖也已保留原回执、另存数据并重算。后继 280 项完整差异与独立审查逐对象一致；后续工具包装改为完成命令后独占创建回执，避免覆盖子命令写出的文件。首次封存又因重复引用同两条旧源码版本被计为多条alias而在发布前停止；后继逐引用验证、只去重完全相同的固定映射，仍限定恰好两个旧版本。失败脚本、partial载荷与事件记录保留。这些是工具/证据事件，不改写成产品门禁成功。作者清点候选的早期失败和后继仍保存在原封存包中；作者没有运行 native 或平台代码。

完整 8855 个 cell 只有 280 个完整对象变化：140 个 off Missing→Available，140 个 on Missing→Partial，其余 8575 个相同。全部验收、coverage、责任、限制、合同与空 ledger 不变。当前 Available1714（19.36%）/Partial1308/RequiresHostService86/Missing5747，accepted0、N/A87，距7084仍差5370，目标仍未完成。新增140个 Available 属于本批私有清理实现，不是既有功能漏计纠正。

产品限定 8 个路径：2 项共享实现、2 项新测试、2 项清点与2项矩阵。1776 个非文档源码与产品 Git blob 逐字节绑定，52 个额外 SDK 清点输入另核验；7 个 gitlink、913 历史文件和默认 checkout 本地 main 保留。没有新 release 归档、空目录安装、实际浏览器、已安装公开 SDK consumer、物理设备或固定微信 oracle 验收；workspace 内 SDK Rust 单测保持其实际有限范围。没有单独创建或借用浏览器、Worker 或预览服务器；测试进程已结束，其内部临时 fixtures 按测试范围记录。旧 affine 严格浏览器失败保持 failed。完整回执、原始日志、作者失败、源码/合同与独立审查见[本批证据](../archived-evidence.md)。
