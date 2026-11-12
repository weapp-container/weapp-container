<a id="implementation-scope-of-routing-transactions-and-private-capability-policies"></a>
# 路由事务与私有能力策略的实现范围

**简体中文** · [English](route-transactions-stats-scope.en.md)


固定口径为微信基础库3.17.3、miniprogram-api-typings@5.2.3、1265 API×七端=8855单元。产品基线为0469bbec，前批交付元数据为7ea21463。本批组合源码已完成有限原生补验，完整冻结、精确提交绑定和新Web产物仍待完成。源码测试不作为公开SDK或设备验收。

本轮实现wx.onBeforeAppRoute、wx.offBeforeAppRoute、wx.onAppRoute、wx.offAppRoute、wx.rewriteRoute的有限共享运行时链路。listeners与rewrite权限在共享lexical环境中持有；QuickJS/V8在guest执行前保留dispatcher和native rewrite callback，公开全局alias、diagnostic能力表和effect queue不拥有此权限。before回调只在native独占RAII lease内允许同步rewrite；Promise continuation、after、success/fail/complete和错误上报不能复用lease。

Session在页面副作用前准备路由意图，原URL和rewrite共用真实路由解析及准入；允许notFound before尝试恢复未知目标，已知Tab类型错误提前拒绝。最终目标和query先于host chrome/geometry测量确定；deferred remeasure复用已准备事务，不重新发before。公开wx导航与历史私有PAGE_*保留不同origin，避免改变私有literal path/query、单页pop和根页clear合同。before/after及相关unload共用routeEventId；失败后仍live页面的pending unload通过私有cancel清理，以便后续retry取得新ID。

五方法的独立engine默认和Session上限均为Partial，manifest Full也不能宣称Full。on/off按容器admission pair求交集：任一Unsupported使整对Unsupported。此策略防止可登记而不可解除的订阅，是容器当前有限能力策略，没有宣称与官方独立开关组合相同。可信capability publication会更新私有policy，清除撤销的list并更换generation；恢复不会复活旧handler和旧emission snapshot。仅篡改公开map不授予实际调用或native投递权限。

Session没有新增公开动态route policy setter。JS列表清理依赖实际可信publication，不能把私有config测试宣称为任意后台provider变化都会即时清理。native before/after仍复核effective pair gate，rewrite也有独立native准入。Unsupported方法物理存在但调用拒绝，不能把方法存在或guest自改canIUse当能力可用。

以下缺口继续保留：官方rewrite后再次before及链式重写/循环终止、SDK在guest前拒绝未知初始路径、原子初始导航缺fresh host geometry permit、官方renderer/pipMode/初始live webviewId、plugin ownership、no-op导航的固定官方事件语义、presentation/animation完成ACK。on/offAppRouteDone和Worklet wx.router没有实现，不从基础route通知推断。当前有限实现应记Partial，available与accepted均不由此增加。

Node验证使用真实production bootstrap组合，但native callback为显式test double。隔离路由原生候选通过core lease1、policy/retry3、route integration10、相邻生命周期55，以及no-default编译和长期Node16项复验；部分函数内部遍历两引擎，不能把函数数乘二。16项Node已包含在原106项静态组合中，不合计为不同功能。所有原始fixture编译/断言失败和修复保留。

Stats补验的实际组合源码仍以7ea21463为HEAD、未提交源码验证，不能重标为0469已冻结执行。root的runtime stats16 passed/2 ignored、Harmony stat2 passed、route Node16 passed均通过，886项相关输入前后相同。16项runtime包含历史timestamp/predicate回归，不是16项新增测试；超大sparse两个明确ignored，不称实际大文件通过。没有新增设备、微信oracle、商户或生产发布凭据。


<a id="existing-statssize-and-unix-mode-contract-verification"></a>
## 已有 Stats.size 和 Unix mode 的合同补验

本批没有修改size/Unix mode生产转换。statSync/fstatSync原本从单份真实Metadata取得size: u64和Unix完整mode: u32，JSON保持整数wire，JS获得可写的普通Number快照。两属性与producer的递归/路径/编码、异步fstat、symlink政策分开判断；赋值只修改返回对象，不truncate/chmod，也不创建host outbox。

实际macOS QuickJS/V8测试覆盖0/1/4097真实长度、目录OS字段、statSync与打开fd、实际chmod、旧快照与新metadata、路径替换后fd仍指向原inode、close/owner retirement及普通字段可写。Harmony验证是本机Rust的真实异步stat委托，不是OHOS/ArkTS设备执行。converter的完整u64整数wire与真实目录/symlink metadata另有测试；真实public managed symlink路径仍拒绝，不能据此宣称增加symlink producer支持。2^53以上按正常JavaScript Number精度舍入，没有新增safe-integer拒绝或BigInt；两个真实超大sparse测试因所需FS支持明确ignored，wire测试不能替代它们。

固定5.2.3属性签名均为可写number，对应st_size/st_mode。独立合同和实际证据复核支持纠正size六native、mode五Unix native共11格已有漏计。这是返回属性的漏计纠正，不是新增11项平台实现。Windows mode仍依据isDirectory返回固定040700/100600，缺完整真实类型/权限快照，继续Partial；Web没有原生持久同步安装，不由此晋级。其他OS/公开SDK/物理设备的验收仍pending。

<a id="composite-counting-and-final-freeze"></a>
## 组合清点与最终冻结

与7ea21463的固定8855单元比较，恰35格missing→partial（五route方法×七端），11格partial→available（Stats已有属性），其他实现分类不变。138个完整cell对象改变，8717个完整对象不变；旧navigation/EventChannel/unload真实经过route事务的provenance也增加，不能把source-only变更称新增功能。全部status/coverage不变，accepted0、N/A87。当前available1441（16.27%）/partial1007/requiresHostService86/missing6321，距7084差5643。相对初始1292净增149；本批available净增11全属已有漏计纠正。

组合清点、矩阵和IO回归159项通过；格式检查通过。最终产品`6f9b66e3`的完整41阶段及前后绑定、新Web producer/direct与Worker release/严格归档/空目录安装及独立字节校验均通过。完整[冻结证据](../archived-evidence.md)保留`ad266b0a`首轮失败、稳定V8回调所有权和fixture/golden修复及最终真实执行；1191个gzip载荷复制后raw/gzip哈希复核通过。没有浏览器、公开SDK或设备验收。SDK源码/gitlink本批未改。独立80%目标仍未完成，父全量验收goal保持paused且未完成。
