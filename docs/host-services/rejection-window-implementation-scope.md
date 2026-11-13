<a id="scope-of-implementation-for-unhandled-rejections-and-window-notifications"></a>
# 未处理拒绝与窗口通知的实现范围

**简体中文** · [English](rejection-window-implementation-scope.en.md)


源码冻结为 `42d85060adc8c82543e5a0c9a5cbd975babd1660`，直接父提交为 `ff1037636018403aa0cef99ca39f4ed44f9660a0`。本批真实实现四项运行时通知接口；只将 `offUnhandledRejection`、`offWindowResize` 的七端共14格由 Missing 升为 Available。两个 `on` 接口的七端共14格由 Missing 转为 Partial。生成矩阵为 available1504（16.98%）、partial1021、requiresHostService86、missing6244，固定分母8855，距7084仍差5580；accepted0、platformNotApplicable87。前批35个Available清理单元保留，其他8827个完整单元对象不变，全部验收状态与coverage不变。

解除接口按函数身份保留私有listener，分别检查自身准入权限；支持指定listener解除和无参数全部解除，不借用对应producer的授权。通知期间使用已捕获的listener快照；普通增删遵循下一轮，可信能力撤回和生命周期退休使当前尾部失效。监听为App级，可跨Page hide/pop和卸载保留；callback使用null/global scheduler owner，Session退休时永久清空。公开别名替换、跨接口注入、retained native transport和App hook均在本批边界内验证。

未处理拒绝保留原Promise与reason身份、真实App hook和有限pending预算；QuickJS使用弱owner捕获，V8在Drop时关闭callback并移除isolate slot。native flush失败沿Session健康与中断链路传播。但微信checkpoint精确时机、固定声明中的reason语义和预算溢出政策仍有差异，因此onUnhandledRejection保持Partial。

窗口通知在真实geometry提交后分发，每个listener得到新的精确size envelope；分发后重新检查Session健康和开发导航候选事务门禁，阻止旧候选继续发布。窗口callback时序、容器窗口策略和固定版本完整参数语义尚未对齐，因此onWindowResize保持Partial。当前实现与有限测试不等于浏览器、公开SDK或设备验收。

本批还修复DelegatingProvider的能力与调用边界：原先capabilities可接受真实宿主geometry，call却在Sandbox/不支持fallback分支先拒绝。现在该分支投影已接受geometry，并统一走observed_result；已注册异步处理、现有快照和真实fallback的优先级保留。三个直接回归、两个native geometry契约和开发导航门禁覆盖这一修复，未通过放宽Sandbox能力或fixture伪造尺寸绕过问题。

源码和accounting共八层真实应用，冻结提交精确23个路径；历史prefix4/5/8三份全量映射均标明派生，另保留实际v4/v6与后续accounting捕获。v5引擎原始结果块合计648通过/2忽略；v6全runtime为55块合计1203通过/3忽略，其中runtime库676通过/2忽略。workspace check、all-target/all-feature Clippy -D warnings和完整测试通过，测试129个原始结果块合计2878通过/10忽略。最终Node另覆盖事件153、inventory453；scheduler为80项内部断言，matrix IO为8项单元测试。这些分组有重叠，不合计唯一测试数；早期native回执不扩张为最终inventory脚本执行。

五份发布前失败报告原样保留：focused-v1、native-v2、native-remaining-v3、native-v4和final-node-v1。final-node-v1因vendor typings缺失在generator Node执行前失败；后继隔离catalog检查使用固定官方typings包、18个声明输入和TypeScript编译器字节，原generator与隔离副本、生成catalog均逐字节核对。它不声称generator支持不存在的--check选项。

实际独立Web producer验证466份Web源码输入；jobs1全新target的direct/Worker release、严格归档、全新目录安装和独立archive/install字节核验全部通过。实际run为 `42d85060adc8-20261104T131734Z-2d5bd0d33a`。direct归档257个regular文件、安装258；Worker归档258、安装259。两归档和lock manifest按原字节另行保留，证据包不复制二进制正文、SDK仓库或Cargo cache。借用的旧fixture和依赖只保留路径与hash范围引用，不声称本包自包含复现原411批次。

Web完成后，矩阵单测仍把前批已完成的offPageNotFound列为Partial。只修改 `scripts/host-api-matrix.test.mjs` 的陈旧预期，并增加当前四接口的七端source/state/gap断言。首轮矩阵报告保持外层失败：生成和--check通过，单测18/19；后继--check与20/20单测通过。该测试文件不在466个Web输入内；root另核对全部466输入和其余1727个非文档源码字节/模式未变。这是冻结42d之后的一个测试差异，不把它追溯计入已完成Web/native回执，也不声称最终交付所有1728个源码字节都等于42d。

SDK源码与七个gitlink未改。本批没有浏览器、公开SDK、物理设备、微信oracle或商户验收，没有生产发布；preview.6.0保持未发布。原908个untracked只核对路径继续存在，不声称已记录其内容hash或属于committed source。证据见 [本批原始记录](../archived-evidence.md)。阶段目标仍未完成，父全量goal保持paused且未完成。
