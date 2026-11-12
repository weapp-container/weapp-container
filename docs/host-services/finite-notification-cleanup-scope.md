# 十组通知的私有回调与清理范围

产品提交 `3c1a7e04cf45be6ce02f843b8b1ad3eb680597f8` 为十组通知建立统一的私有回调所有者，并将真实 native 订阅的取消接回 Session 生命周期。固定依据为微信基础库 3.17.3、miniprogram-api-typings@5.2.3，声明文件 SHA256 为 `25e9e6fdab1b4282ee5231d8f8de7a31a177d2edc690ec834e0da479cc166245`。

覆盖 AfterPageLoad、AppRouteDone、BeforePageLoad、CopyUrl、EmbeddedMiniProgramHeightChange、LazyLoadError、MenuButtonBoundingClientRectWeightChange、ParallelStateChange、UserOffTranslation 和 UserTriggerTranslation。九个 off 接口按原函数身份选择删除，省略或 undefined 清空该组；`wx.offCopyUrl(): void` 无参数，无论传入什么参数都清空 CopyUrl。全部返回 undefined。生产 tracing facade 使用可变参数包装，Function.length 不作为声明合同。

on/off 从 bootstrap 起使用同一私有链表；宿主 descriptor 与公开诊断数组不能再持有第二份有效回调。off 同步撤销投递身份并清空函数引用，只保留预留的 native 取消节点。永不复用的 canonical ASCII u64 身份、4096 个活跃加未 ACK 取消节点上限及 Session 既有订阅预算保持有界。native 资源实际取消后才 ACK 指定前缀；后续取消不会被提前清除。

Session 在公开 effects 转换前后都读取受信私有快照，转换失败或 toJSON 重入也先协调清理。先 on 后 off 的排队订阅不再生成迟到孤儿资源；单个 pending resolver 抛错时，清理继续扫过其余资源，保留首错、推迟 ACK，并尝试协调已接受 storage。终态 retirement 与 trusted on 撤回清理真实所有者，独立于公开 off 权限。原有 session/account/object/event/sequence/size 栅栏继续保留。

只有十个 off 新增 Rust runtime_owned；on 仍允许实际可选宿主 producer 注册，保持 Partial 上限。不增加默认授权，也不把有限 fixture 的 native 事件当作实际平台 producer。实际生产源、固定版本 payload、时序和插件范围仍分别保留 `finiteNotificationActualProducer`、`finiteNotificationFixedPayloadParity`、`finiteNotificationFixedTimingAndPluginParity` 缺口。AppRouteDone 使用独立 finite owner，不接入 route transaction producer；ParallelStateChange 的 PC producer 适用范围未扩展。

父代理实际通过 Node 44/44、相关通知回归 225/225 外层测试、七个真实 QuickJS/V8 native integration 函数（循环十组）、fmt、workspace all-targets locked check、全部 features 严格 Clippy、runtime 全 features lib 758 passed/2 ignored，以及 完整四线程 workspace 后继测试（133 个结果块、3047 passed / 0 failed / 10 ignored）。命令有重叠，不能合计为独立测试数。无 native feature 的 check exit0，保留 finite 模块外 35 条 warning，不声称无警告或已证明这些警告预先存在。

首轮 Node 42/44 仅因错误的 Function.length 断言失败，修正测试后 44/44；首轮清点 643/645 失败为旧 Done blanket exclusion 及三处 BufferURL 完整 JS 字节 pin 遗漏。独立核验共享文件只增加 finite binder/install/retirement，原 BufferURL 逻辑未变后，精确更新 pin 与测试，完整清点/矩阵/IO 645/645、生成、检查及产品提交后检查通过。源码冻结首轮比较 git ls-files 与 ls-tree 格式失败，v2 只规范化 mode/type/hash/path 表示；原脚本和失败记录保留。

完整 workspace 首轮在 SDK 快照刷新夹具失败：观察到 Raster replacement 已为 Complete/ready，而测试仅等待 AwaitingPresentation。原始日志保留。独立源码诊断确认，重复 ACK 同一 cleanup 会在函数前后各推进一次状态；若 HTTP retirement 此时完成，可能在一次 ACK 内经过启动、AwaitingPresentation 和已呈现 Raster 的 Complete。原日志未记录实际 HTTP 排程，不把这一路径宣称为已动态复现。夹具改为同一 cleanup 只 ACK 一次，后续仅 pump；原中间状态及全部身份快照断言保留。共享 12 项通知源码字节未变。修正后默认 Raster 配置的 QuickJS 定向测试 1/1、全 features 配置的 QuickJS/V8 定向测试 2/2 通过；SDK all-targets/all-features Clippy -D warnings 与 fmt 再次通过；随后完整 workspace 后继结果见上。此前 workspace check/全 features Clippy/runtime-lib 门禁绑定 SDK 夹具改动之前的文件集，后继另编译、lint 并执行此测试，不声称重跑了全局 check/Clippy。

完整 8855 个 cell 比较只改变 140 个完整对象：70 个 off Missing→Available，70 个 on Missing→Partial；其余 8715 个完整对象相同。全部验收、coverage、责任、限制、合同和空 ledger 字节未变。当前 Available1574（17.78%）/ Partial1168 / RequiresHostService86 / Missing6027，accepted0、N/A87，距7084仍差5510，goal继续active。

产品只含 17 个明确路径：12 项通知实现/测试、1 项 SDK 测试夹具、2 项清点、2 项矩阵。1774 个非文档文件逐字节绑定产品 Git blob，52 个额外 SDK 清点输入另核验；七 gitlink、913 历史文件和默认 checkout 本地 main `0679f810821a55ef029817ed1e16b96acf0ad8a9` 保留。本批没有生成新 release 归档、空目录安装，也没有浏览器、已安装公开 SDK consumer、设备或微信 oracle 验收；SDK Rust 单测范围按上文单独记录。没有单独创建或借用浏览器、Worker 或预览服务器；测试进程已结束，其内部临时 fixtures 按测试范围记录。旧 affine 严格浏览器失败仍为 failed。完整原始失败、后继、源码和独立核验见[本批证据](../archived-evidence.md)。
