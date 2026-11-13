<a id="canvas-affine-matrix-and-current-path-clipping"></a>
# Canvas 仿射矩阵与当前路径裁剪

**简体中文** · [English](canvas-affine-clip-scope.en.md)


固定基线为微信基础库 3.17.3、`miniprogram-api-typings@5.2.3`，仍使用 1265 API × 七平台 = 8855 单元。产品提交 `ba98455f1fb53c8de1a6d3b1f5af5de4ec4e2126` 实现 legacy `CanvasContext.setTransform`、`transform`、`clip`，三项七端均登记为 Partial，Available 与 accepted 增量均为 0。当前为 available1504 / partial1091 / requiresHostService86 / missing6174，距离 7084 Available 仍差 5580；platformNotApplicable87 不从分母扣除。

<a id="implementation-boundary"></a>
## 实现边界

两种矩阵方法接受六个有限 native scalar 并返回 void，`clip` 为零参数 void 方法。关联真实 Canvas 节点的上下文经私有 owner 通路提交；既有无 owner 和 offscreen 上下文保留独立事件通路，各通路的批次均经过完整 typed batch 预检后才绘制。`setTransform` 替换 guest CTM；`transform` 按 current × incoming 组合。参数使用 `(a,b,c,d,e,f)`，点映射为 `x'=a*x+c*y+e`、`y'=b*x+d*y+f`。已构造的路径保留构造时的坐标，后继 CTM 不会重新变换旧路径。奇异矩阵可被接受，但预检拒绝不再有限的累计矩阵和几何。

`clip()` 使用完整当前路径、nonzero winding 和隐式闭合，与已有裁剪相交。portable replay 使用不可变 packed mask，save/restore 共享并恢复 mask，draw 边界的 ResetState 清除 CTM、路径、裁剪和 save stack。fill、stroke、clear、文字等现有像素消费路径均执行裁剪。native Skia 在调用方的基准矩阵下建立 clip，仅还原矩阵而保留 clip；退出时恢复调用方状态与 guard。

共享预检在像素分配或发布前检查完整命令流，包括最多 16MiB 的瞬时 clip-mask payload、256Mi 几何 work units 及现有 Canvas 上限。迟到的预算或几何拒绝不能覆盖已接受图像。`draw(true)` 保留已有像素和历史命令，但本次新命令仍从默认绘制状态开始；Promise 返回是容器扩展。

<a id="remaining-range-per-item"></a>
## 每项剩余范围

| 成员 | 已实现范围 | 保留的缺口 |
| --- | --- | --- |
| `setTransform` | 六参数 CTM 替换、调用方基准矩阵保护 | 输入与准备值受有限 f32 的范围和精度限制，未覆盖完整 JavaScript number 域 |
| `transform` | 六参数 current × incoming 组合 | 同上；有限输入序列的 f32 组合溢出会拒绝整个 draw，即便后继 setTransform 可恢复 |
| `clip` | 零参数当前路径裁剪、相交、save/restore 和 reset | portable 为单比特像素中心覆盖，native Skia 为抗锯齿边缘；两者与固定 3.17.3 的边缘覆盖尚未核实 |

固定声明的矩阵方法均为六个必选 number 参数并返回 void；`clip():void` 没有 evenodd 或 Path2D overload。本地 DevTools 缓存中 manifest 标记为 3.17.3 的包，其静态源码支持矩阵参数顺序与组合方向；未独立核验该缓存的下载链或包签名，也没有建立运行时像素、非法参数、错误行为 oracle 或固定版本 clip 实现证据。不得把本地负例的容器错误策略当作微信错误契约，或声称已证明固定版本的抗锯齿不一致。

清点只为这三项增加独立的源码、参数和剩余范围检查。factory、draw、已有 Canvas 成员及 offscreen 的原有缺口均保留；没有新增 SDK 验收合同。8855 格完整比较只改变这三项的 21 格，其余 8834 格完整对象不变，全部 status、coverage、implementation 责任以及合同、ledger 字节不变。

<a id="verification-and-product-scope"></a>
## 验证与产物范围

Node Canvas 74/74、根工作区清点/矩阵/IO 568/568、生成及 `--check` 已通过。实际 QuickJS 与 V8 的 Canvas filter 各通过 27 项，包含 24 项 Canvas 和 3 项 nextTick Canvas；两组命令不能累计为独立覆盖数。portable 和 Skia 仿射测试各 13 项、native 调用方保护 3 项通过。owned-page 13 项及 browser-permit 1 项属于周边回归，不单独证明新成员执行。

fmt、workspace all-targets locked check、全 features 严格 Clippy 均通过。all-features runtime lib 为 757 passed / 0 failed / 2 ignored；四线程 workspace 为 132 个结果块、3022 passed / 0 failed / 10 ignored。这些命令有重叠，不累计为独立测试数。两项清点脚本在 Cargo 执行期间另行应用；497 个构建输入始终保持冻结字节，1766 个非文档输入的前后比较只允许这两项脚本变化。

第一次 native 测试编译因测试中的整数 scale literal 不符合 f32 类型而失败，原日志保留；后继只修正测试 literal 并补充曲线、空 clip、剪切 stroke 和拒绝原子性断言。隔离清点第一次全套发现一个旧 source-count 断言，539 passed / 1 failed；其 stdout 被后继覆盖，仅保留明确标注来源的观察回执，不能称为原始 raw log。修正后的隔离 540/540 与根工作区 568/568 分属不同命令范围。

direct/Worker release CanvasKit 构建、严格归档、空目录官方安装与独立 2119 项输入字节核验通过，497 项构建输入绑定私有快照 dab7c69e6fc0d3dd97a7ad656c76f6b8c522f9da；复用既有 Cargo target。该快照不是父仓库产品提交。

浏览器 v1、v2、v3 目前均为失败，不能由画面完成推断门禁通过。v1 两通路五阶段完成后，严格网络门禁记录三次 ERR_ABORTED；v2 direct 五阶段通过，Worker 在 ready=0 时因夹具异步等待提前返回而失败；v3 改为显式 await 实际 guest 状态后，direct 五阶段通过，但字体请求在初始化期间、owner 关闭之前报告 ERR_ABORTED。完整字节读取和 SHA 校验成功不能消除该网络失败；其原因仍在调查。v4 增加原始 CDP、服务器响应及 Chrome netlog 观测后仍失败：direct 五阶段通过，字体 18 次 CDP dataReceived 与网络服务 275 次 filtered-byte read 均累计 17,772,300 字节；网络服务的请求结束和服务器 finish/close 无错误，CDP 却报告 canceled=true / ERR_ABORTED。该结果将调查缩小到完整传输后的 renderer loader / DevTools 生命周期，尚未确定原因，也不建立取消豁免。各次 page/context/browser/server、当次已创建 Worker 和诊断 CDP session 均已关闭，没有保留页面。

源码测试、私有构建快照和有限 synthetic 浏览器执行均不替代七端公开 SDK、设备、固定版本 runtime oracle 或商户验收；preview.6.0 未生产发布。

Response 强引用对照两组均失败，未支持修改 Response 所有权。reader 对照中基线与强保留 reader 后立即释放组通过，延后释放组仍在原生 releaseLock 前报告取消；相关行为具有不稳定性，不能据此归因 GC 或提出生产修复。所有对照均标记 diagnosticOnly、finalSelectionEligible=false；native arrayBuffer 消费对照仅封存草稿，未执行，且明确缺少增量读取预算，不能作为产品实现。

本批总验证 `FINAL-VALIDATION.status=failed`：源码、Node/Rust、构建、归档和安装门禁通过，严格安装产物浏览器门禁失败。字体加载源码与提交前字节相同，并位于 14 项产品 diff 之外；这不证明失败与本批行为无关，也不证明是 Chrome 缺陷。三项实现依据具体测试保持 Partial，不挑选偶然成功对照晋升，不创建通过的 final-browser-selection。完整失败、诊断、源码绑定与封存计划见[本批证据](../archived-evidence.md)。
