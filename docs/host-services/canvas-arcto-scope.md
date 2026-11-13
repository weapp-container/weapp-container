<a id="canvascontextarcto-implementation-scope"></a>
# CanvasContext.arcTo 实现范围

**简体中文** · [English](canvas-arcto-scope.en.md)


产品提交 `2b36a3d1374f2f35147177bf2804d7b3f8b0d281` 在既有 Canvas 事务边界内实现 legacy `CanvasContext.arcTo(x1, y1, x2, y2, radius)`。固定声明要求五个必填 number，返回 void。JS 将参数复制进有界命令队列；完整批次预检先完成解码、几何和工作预算校验，再允许任一渲染后端发布像素。

预检按构造时 CTM 恢复当前路径端点，在 f64 中计算两个切点，并一次性转换为三个已变换点和正权重的有理二次曲线。便携后端使用有界齐次细分，原生 Skia 使用同一曲线的 conic_to；两条路径不会分别重算圆心或切线。大半径不截断到控制线段，终点为第二切点，不自动连接第二控制点。空路径、零半径、重合点和共线情况按已记录分支降级为 moveTo 或 lineTo。closePath、连续 arcTo、变换、clip、draw 重置和 reserve 回放沿用现有状态边界。

本项七端均保持 **Partial**。输入和存储仍受 finite-f32 范围及精度限制，极小正半径可能下溢；需要逆变换的分支拒绝奇异 CTM；曲线权重必须为可表示的正数，细分深度和现有几何、绘制、字节等预算限制参数范围。负半径拒绝是明确容器策略，尚无固定微信 3.17.3 错误行为或完整栅格一致性证明。现有 clip 边缘差异也没有在本批解决。

集成验证已执行并通过：Node Canvas 68/68，便携 arcTo 11/11，启用 Skia 的 arcTo 13/13（含两个本机调用者矩阵、clip 和 save 深度保护测试），QuickJS/V8 Canvas 过滤各 31/31，fmt、workspace all-targets locked check、全部 features 严格 Clippy，以及清点/矩阵/IO 576/576。过滤集合存在重叠，不累计为独立覆盖数。清点首轮 575/576 的失败来自第二处遗漏的 source count 断言；原始日志保留，修正为 130 后完整复验通过。作者侧旧 Node 失败及隔离环境缺少 Acorn、SDK 输入和 matrix 的三次失败也保留。

完整 8855 单元比较仅有 arcTo 的七格 Missing→Partial，其余 8848 个完整单元对象、全部验收和 coverage 不变；acceptance contracts/ledger 字节不变。当前 Available1504 / Partial1098 / RequiresHostService86 / Missing6167，accepted0，N/A87；目标7084，差额5580。1770 个非文档 Git blob 与最终源码逐字节绑定，另核对13个 SDK 清点读取输入；七个 gitlink、913个历史文件及默认 checkout 的本地 main 均保持原身份。

本批没有重跑完整 workspace 测试，没有新建 Web/native 发布归档，也没有浏览器、公开 SDK、设备或微信 oracle 执行。先前 affine 批次的严格浏览器失败仍保留原状态，本批源码测试不替代该失败或扩大旧产物范围。原始命令、失败、候选补丁、源码绑定、矩阵比较与独立复核见[证据副本](../archived-evidence.md)。80% 目标仍未完成。
