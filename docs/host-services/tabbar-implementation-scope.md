<a id="scope-of-implementation-for-dynamic-system-tabbar"></a>
# 动态系统 TabBar 的实现范围

**简体中文** · [English](tabbar-implementation-scope.en.md)


固定基线为微信基础库 3.17.3、`miniprogram-api-typings@5.2.3`，1265 项 API × 七端 = 8855 单元。本批实现五个操作的真实运行时事务与已安装消费链：`setTabBarBadge`、`removeTabBarBadge`、`showTabBarRedDot`、`hideTabBarRedDot`、`setTabBarStyle`。它们只在 Android、iOS、macOS、Windows、Linux 的具体 Player 链路记为 partial，共 25 个 missing→partial；没有新增 available 或 accepted。

<a id="state-and-call-boundary"></a>
## 状态与调用边界

两个引擎共用 TabBar facade。它只读取参数对象自己的原始数据字段，拒绝 accessor 和错误类型，不在 JSON 序列化中执行字段或 callback 的 `toJSON()`。原始 callback 以不可枚举属性进入既有异步结算链；失败保留 callback、complete 与 Promise 的结算路径。该修复局限于此 API 边界，不宣称通用 bridge 已支持任意 JavaScript 对象。

Session 持有经过验证的样式和指示器状态。原生处理在 mutation 前重新核对生命周期、有效 capability、内部传输 deadline/cancel、当前页面、非 custom 的已配置 tabBar 和真实索引。样式先整体校验再提交，颜色统一为六位 hex；徽标按 UTF-16 长度超过四时显示 `...`，NUL 文本明确拒绝。徽标与红点当前互斥，移除只清理对应指示器。这些 Unicode 和交互规则仍需固定微信版本的真实 oracle，不作为完整语义声明。

状态随正常 push/pop/switch 保留，在 Session 终止时清除。它投影到既有 chrome；SDK 独立检测 chrome metadata revision，因此不必伪造布局或 frame 更新。Player 接收新 metadata 后，Android/iOS/macOS 由 Flutter 绘制，Windows/Linux 经 Flutter native desktop registry、NativePreviewTexture 和已安装 Windows/Gtk overlay 消费。相同几何下的样式或指示器变化也会传到 native overlay。

<a id="default-denial-and-real-presenter"></a>
## 默认拒绝与真实 presenter

可信宿主配置 `systemTabBar` 默认 false，false 不写入旧 JSON 配置。只有已安装消费链的宿主才应传 true；事件转发或 SDK 配置字段本身不代表 presenter。Rust SDK、Android/iOS SDK、desktop 和 Flutter 的配对版本传递该字段，Player 明确 opt in。

默认 pack 请求五项 Partial，避免真实默认 CLI 产物在 SDK opt in 后仍因 manifest 缺项而被拒绝。manifest、host config、provider 仍取最小支持度，最终上限为 Partial；显式降低 manifest 继续有效。packer 的独立默认宿主诊断矩阵仍为 Unsupported，它不参与运行时 admission。

内建 Web/Harmony 入口没有 opt in，仍为 Unsupported/missing。可信低层 `SessionConfig.capabilities` 可以显式准入 Partial；没有按 HostKind 无条件拒绝所有显式配置的规则。`tabBar.custom:true` 的有效 capability 与实际调用均为 Unsupported。未配置 tabBar 的调用也拒绝，但 capability 表本身不充当 app 配置完整性 oracle。

`showTabBar`、`hideTabBar`、`setTabBarItem` 在全部七端继续 missing/Unsupported，即使 manifest/config 声称 Full 也不能启用。可见性、动画、远程或临时图标等未完成能力不借本批晋级。

<a id="verification-and-uncommitted-scope"></a>
## 验证与未闭合范围

最终产品 `61013a7db713e5dac46a89b57a67b53bdf16b4ba` 的38个冻结阶段及前后完整源码/工具绑定全部通过，完整[证据](../archived-evidence.md)保留原始命令、日志和失败。冻结验证执行真实 QuickJS/V8 的 6 个 unit、7 个 integration、3 个 SDK 用例，覆盖默认 CLI pack、false/true/custom admission、原始 callback、无 hook 执行、事务原子性、生命周期和内部取消/超时。内部传输字段不声明为公开 TabBar 参数。packer 全套 140、六文件 Node 351、公开 contract/真实 TypeScript 30、Player 全套 244、安装的 Flutter SDK 全套 132 均通过；Player analyzer、三个变更 Player Dart 文件格式、所改 Rust 格式与各仓库 whitespace 通过。workspace 2716 passed/9 ignored、native engines 557/2、runtime 640/0、boundaries 170/1、清点矩阵IO 117和14项host-services门禁通过；不同命令有重叠，不合计唯一测试总数。

便携 C++17 palette helper 和注入 registry 实际编译执行，Swift 6 对 Types 做语义检查、Session/plugin 做 parse。Windows/Gtk 绘制分支没有在本机编译或执行；便携 helper 不代表这些分支通过。Android/Kotlin 构建环境缺失；独立 iOS 缺少 native XCFramework，未完成全量链接。Flutter widget 测试不代表 OS 原生像素或设备执行。

首轮产品 `a82fc73e` 的 34 个冻结阶段只有 host-services 失败：已更新的 SDK wrapper/README 尚未同步既有 `SOURCE-INVENTORY.json`，严格归档守卫正确拒绝。四个现有清单已用原工具重新生成、验证并以独立提交先推 SDK 工作分支；contract 没有此清单，不新增旁路格式。历史 `ORIGIN.json` 与实现文件保持原字节。宿主服务验证现先汇总四个清单预检，任一失败即跳过后续编译；输入清单同时覆盖四个 SDK 的实际源码、清单和工具，运行中改动同样使结果失败。原始失败和修复后的新冻结分别保存。独立Web producer、全新target的direct/Worker release构建、严格归档及空目录安装和独立字节核验通过；已有reference portable fixture不代表新的默认TabBar包或浏览器验收，Worker产品资产仍关闭。2988个gzip证据载荷复制到仓库后再次逐项核对raw/gzip哈希通过。

五项仍缺完整锁定契约、全部公开 SDK presenter 链和平台实际执行/像素证据。callback/Promisify 返回、精确 Unicode/徽标红点交互、错误与视觉/accessibility parity、独立 native 和 mobile React Native 消费链仍待闭合；没有新增红点 accessibility 状态公告。Linux 范围为已安装 X11/Gtk 路径，保留 Wayland admission 限制。没有公开 SDK、设备、微信 oracle 或商户验收，也没有生产发布。

当前总数为 available 1412（15.95%）/partial 1001/requiresHostService 86/missing 6356；accepted 0、platformNotApplicable 87。80% 目标仍为 7084 available，差 5672；阶段 目标仍未完成，父全量验收 goal 保持 paused 且未完成。
