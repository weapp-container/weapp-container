# 私有运行时清理方法的实现范围

源码提交 `a11b94a8b8e1cd1d806e9a574416d1d4271cc79d` 修复了宿主通用安装器可覆盖运行时方法、生产者的 Partial 等级连带压低清理方法，以及 PageNotFound 监听依赖公开诊断表的问题。27 个源码和测试文件共同建立私有所有权、可信准入、撤权和终止清理边界；没有增加默认能力授权。

| 方法 | 本批完成范围 | 保留的边界 |
| --- | --- | --- |
| `wx.offAppRoute` | 同步 void；原函数身份移除、缺省移除全部、快照期间变更、可信撤权和终止清理 | 保留路由对的布尔准入；自己的 manifest/host/provider 等级不再受 Partial 生产者压低 |
| `wx.offBeforeAppRoute` | 与实际 before 监听集合共享同一私有所有者和清理规则 | 事件、rewrite、恢复和宿主呈现语义继续单独登记 |
| `wx.cancelIdleCallback` | 独立准入和等级；取消真实私有 idle 任务；撤权阻断已借出的函数 | `requestIdleCallback` 仍为 Partial；请求撤权会清理任务，取消撤权独立处理 |
| `wx.offPageNotFound` | 移除实际私有监听；精确函数或全部移除；兼容 dispatch、重入和终止退役共享所有者 | `onPageNotFound` 仍缺 missing-route producer、固定事件载荷与 App 恢复语义 |

通用宿主注册和 counterpart 补全均避开这些运行时方法。公开监听表只作诊断投影；可信准入状态先更新，再触发可能重入的公开属性操作。终止退役永久清空所有者，重新安装能力不能恢复已经退役的监听权。

固定微信 3.17.3、miniprogram-api-typings@5.2.3、1265 API × 七端 = 8855 格。完整矩阵比较只有四个清理方法 × 七端的 **28 格 Partial → Available**。九个 API 的 owner 元数据改为 runtime，63 个完整 cell 对象发生变化：包含所有权分类和私有边界的来源说明；其余 8792 个完整对象不变。生产者保持 Partial，PerformanceObserver.disconnect 的七格整行不变，全部 SDK 验收状态和 coverage 不变。

当前 available **1490（16.83%）**、partial **1007**、requiresHostService **86**、missing **6272**；accepted **0**、platformNotApplicable **87**。相对最初 available1292 净增198，距离7084仍差 **5594**，阶段 goal 继续 active。

root 的源码回归 Node509/509、最终清点及矩阵 Node367/367、格式、workspace check、全特性严格 Clippy 和 workspace 测试通过。workspace 原始127个结果块合计2859 passed/10 ignored，不宣称这是去重后的测试数量。实际 QuickJS 库309 passed/1 ignored、V8库294 passed/1 ignored及其集成测试通过；此前的 native runtime 库671 passed/2 ignored和各实际集成结果保留原执行范围。workspace 与双引擎门禁之后，只有两份清点脚本更新；派生的完整历史映射明确标注 derived，未冒充当时实际捕获的快照。

首轮格式失败、旧路由夹具全部 Partial 的预期失败、QuickJS 旧全局导出夹具误含私有 helper 的失败均保留。两引擎对应夹具随后修复；修复分别限于格式及测试夹具，私有 helper 没有被导出。矩阵首轮还发现 catalog owner 变化使旧摘要失效：只更新 acceptance-contracts/ledger 顶层 catalogSha256，15份合同及其 profiles、空 reports 和其他字段保持一致。摘要辅助脚本返回值检查错误和来源比较条件误设的两次失败也保留原日志，后继校验明确检查 accepted Map 和生产者新增的 protectedBoundary 来源。

该精确源码已在独立克隆中核对462份 Web 源码，使用新建空 Cargo target、jobs1生成 direct/Worker 两套 release CanvasKit 产物。包下载及工具链缓存可复用，不声称全环境冷构建。严格归档、两个空目录安装及独立逐字节比较全部通过：direct归档257个普通文件、安装258个；Worker归档258个、安装259个，多出的文件是安装回执。

构建 fixture 保留原 nextTick 诊断来源，不作为本批清理 API 验收。没有新增浏览器、公开 SDK、物理设备、其他 OS 原生归档或商户交易证据，没有生产发布；七个 gitlink不变，原908个未跟踪证据文件保留。原始命令、失败、源码映射、归档hash和安装结果见[本批证据](../archived-evidence.md)。
