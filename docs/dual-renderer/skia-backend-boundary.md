<a id="skia-page-backend-and-passive-host-observation-boundary"></a>
# Skia 页面后端与被动宿主观察边界

**简体中文** · [English](skia-backend-boundary.en.md)


`container-runtime::render_backend` 在 owner thread 内管理 Skia 页面准备和接受。
Session 负责 AppService/View 求值、页面与资源授权、滚动状态协调、输入 provenance、
呈现权限、ready 和 effects；后端不接收 `&mut Session` 回调，不执行 JS，也不拥有窗口。
公开 bridge、ViewDocument schema、宿主 ABI 和各渲染模式的呈现语义保持原有边界。

<a id="preparation-and-acceptance"></a>
## 准备与接受

1. Session 验证 manifest、目标、模板和资源，捕获页面输入快照。
2. `SkiaPageBackend::preflight` 解析原有原生 WXSS 级联；失败发生在该次 render 的 View/组件 hooks 前。
   `SkiaStylePreflight` 绑定 frame、template、逻辑 viewport 与不可变资源 Arc。
3. Session 完成一次 View/组件求值，将结果投影为 `ViewDocument`，返回 `PreparedViewDocument`，
   再按原顺序读取页面滚动配置。求值后的 AST 不跨过页面后端边界。
4. 后端检查 preflight 身份，只遍历 `ViewDocument` 生成原生节点，执行样式、图片、变换和布局准备，
   产出 `PreparedSkiaFrame`。图片的词法来源绑定同一 document 的 occurrence，重复 public id 不混用资源。
   图片 decode cache 是候选副本；资源字节与已解码像素继续通过 Arc 共享。
5. Session 在候选帧上协调滚动。后端 `accept` 调用原有 renderer commit，只有成功后
   才发布该候选的 decode cache，返回 `AcceptedSkiaFrame` 及可供 Session 发布的 manifest 元数据。
6. Session 发布对应的 document、verified resource store 与 clone-time input proof，
   再进入原有 Raster 或 external/native 呈现流程。接受帧不等于外部 surface 已呈现。

后端准备、滚动协调或 commit 失败不发布新 cache/document/输入证明；已经执行的 JS hooks
不回滚。下层 SkiaRenderer 的既有 commit 事务仍是帧与像素失败原子性的前提。
Session 继续决定最终 ACK、重复 ACK、页面切换、输入 lifetime 和 ready/effects，后端不授予这些权限。

显式 RenderFrame 也走 typed accept，但没有 manifest 候选，不替换 decode cache 或授权新的
manifest 资源。开发预览在 detached Session 接受自己的候选，不能发布 live 页面输入证明。
manifest 更换时后端清空可复用 decode cache；旧 accepted frame 的 Arc 像素仍有效。

<a id="actual-frame-preparation-by-renderer"></a>
## Renderer 的实际画面准备

`SkiaRenderer::prepare_page_frame` 独占借用当前 renderer，在返回候选前完成帧、图片和目标校验，以及 Raster 的实际绘制与像素读回。`PreparedPageFrame::accept` 只移动已经准备的页面字段和更新标记；返回的 `AcceptedPageFrame` 持有被替换的旧帧、像素、图片和 surface。共同发布的调用方须将 receipt 保留到 Web store 解锁后再释放，不能在发布锁内销毁旧页面资源。Canvas、字体和 GPU context 始终属于原 renderer；真实绘制产生的独立字体缓存增长不回滚。

普通 `Renderer::commit` 复用这一准备／接受路径并立即释放 receipt。`PageFrameTargetPolicy::Legacy` 保留原有后端行为，包括无 Skia 软件 Raster 的 4097×1 页面；`Development { scale }` 才显式启用开发态尺寸、像素预算与倍率能力校验。revision 耗尽明确拒绝，不复用饱和值。ExternalFrame／NativeGpu 候选不进行整页 CPU 光栅化或读回，接受候选也不构成真实 GPU 呈现证据。

此接口仅完成 renderer 层；上层 `PreparedSkiaFrame`、有应用 hook 的逻辑 resize、Web reservation 和倍率专用候选的资源释放尚未合并成共同事务。不能把 renderer 候选的失败原子性推广为 JS 状态回滚或完整 resize 验收。

<a id="dom-and-subsequent-work"></a>
## DOM 与后续工作

DOM 的 raw stylesheet graph、浏览器布局、geometry、permit 与最终 ACK 路径保持独立，
不调用 Skia preflight/materialize/Taffy。此片没有把 DOM 转成 RenderFrame，也没有统一两者的布局结果。

当前 Skia 路径已拆分准备、惰性页面对象与只读宿主观察，以下边界与后续缺口仍需分别管理：

- `PreparedViewDocument` 只携带不含 AST 的 `ViewRenderInputs` 和 `ViewDocument`；原 AST 转换器仅保留在 `cfg(test)` 中作回归对照。slot owner 投影仍未补全。
- 只读宿主 frame/snapshot/status/target 查询已迁移为 typed facade：`accepted_page_observation` 一次 passive peek 借用已接受帧与现有像素；`page_render_status` 与 Metal context 查询不分配资源。目标 validation/staging 也有窄接口，首次绘制前只保存配置。concrete getter 继续兼容显式 legacy 初始化与 mutation，逻辑 resize 的恢复和 font 安装边界尚未统一。
- SkiaRenderer 继续通过显式 `ensure/ensure_mut` 按需创建，没有隐式 `Deref` 初始化。普通 DOM、被动状态读取、空截图、detach/reset 与独立 Canvas 不创建页面对象；模式和 feature 支持仍在加载前校验。CanvasService 在首次页面初始化时整体移动到 renderer，保留同一 history/snapshot/font/cache/lock；之后当前 renderer 是唯一所有者。整体替换 renderer 后不得复活退休 store。这是对象与能力边界的改进，不据此宣称性能收益。
- backend-neutral receipt/coordinator、全宿主 WebView 适配、GPU/真机与性能门禁不由该代码重构证明。

<a id="accepted-frames-are-not-presentation-authorization"></a>
## 已接受帧不是呈现授权

`AcceptedPageObservation` 只描述同一个 renderer 的已接受 revision、frame、
提交 target 和可选缓存 snapshot；旧帧可以属于上一个路由。整体替换 renderer 时
观察自然跟随替换对象自带的 frame/revision/pin，不额外清空，也不保留第二份 Session pin。
`render_target_for_revision` 拒绝零和过期 revision；应用 frameId 与 DOM revision 不能代用。
target 只在提交成功时发布，staging、失败、Canvas 与 diagnostic capture 均不改变它。
它不是测得的 framebuffer、ready、input 或 browser presentation 证据；现有 Session
按页面、document、profile、consumed-input、permit 与 ACK 的授权检查仍独立执行。

无约束的 `renderer_mut` 会退休 Session 的 scene 关联、consumed-input、外部呈现回执、
pending ready 与 observer geometry 授权，避免替换对象复用相同数字 revision 时继承旧凭据。
替换对象的被动 frame/target 观察仍有效；Raster 保留既有同步语义，外部呈现须由正常提交重新授权。

<a id="development-mode-scaling-transactions"></a>
## 开发态倍率事务

`validate_skia_render_target` 与 `stage_skia_render_target` 不创建页面对象，不改变已接受 target，
也不撤销 DOM permit。`repaint_current_skia_page` 只重绘 Session 所属的当前 Skia scene，
按已接受的物理 target 判断是否需要更新；已 stage 的数值倍率不能吞掉尚未接受的像素变化。

Web remote 的同逻辑尺寸更新使用 `Simulator::apply_web_density`：

1. 独占借用当前 scene，保留该帧实际消费的 input proof；不重新求值 View 或调用生命周期。
2. 在候选中完成物理图层预算校验、原生 Raster 绘制与读回。External/NativeGpu 不生成整页像素。
3. 准备完整 Web 响应、资源、缓存记账和 SSE，取得最终 store 锁后才接受候选。
4. 以已准备字段的移动共同发布 runtime 画面与 Web 配置/响应；发布后没有旧帧 rollback 入口。

准备失败或丢弃候选保持旧画面、target、revision 和 Web 配置；独立字体 lookup cache 可以增长，
Canvas、字体、GPU context 与计数器不被回滚。无当前 scene 时只共同提交设置和下一帧目标，
不发布上个路由的旧图。相同物理尺寸可复用已接受画面，但新的配置 generation 仍须正确发布。

该事务仅覆盖倍率/FPS 等不改变逻辑几何的设置。完整[宿主环境镜像](host-environment.md)已提供进入应用代码前的可信修复；逻辑 resize 的回调导航失效、Provider 几何恢复与画面共同接受仍待联合接线。Raster 的精确回执已有[显式运行时 API](dev-raster-presentation.md)，Web owner／binary／RAF 接线尚未启用；不能从这个边界推导完整回滚或 GPU 验收。

<a id="verification-entry"></a>
## 验证入口

本 checkpoint 的 `9354c828` 通过格式、严格 Clippy 及完整 workspace（2173 通过、0 失败、11 忽略，75 项必选全通过），三组独立源码绑定的浏览器回归通过。Skia 完成两次 context 恢复；40 项检查按 liveContextIds 筛选的 context 及 activeContext，其 finish/readPixels/整页 RGBA 上传均为 0，完整生命周期另记录 19 次退役 finish、0 readPixels、0 整页 RGBA 上传。两者不能混为全生命周期零同步。原始命令、忽略项、失败及清理记录见[本次证据](../archived-evidence.md)。驱动为 SwiftShader；逻辑 resize 补偿、font mutation、硬件/性能及其他宿主验收仍待完成。

`ff22b577` 的原生及浏览器回归与 `4f753cab` 的历史浏览器结果分别保留原始绑定，
不能替代本 checkpoint 的源码验证，也不能被后续结果改写。

新增 backend 单测验证候选不提前接受、commit 失败保留 frame/revision/cache、Arc 重用、
显式帧与 manifest cache 分离、manifest cache 重置及 preflight 身份拒绝。
`session_render_resources` 新增双引擎样式预检失败不运行组件 hooks，以及求值后图片失败
保留旧 frame/document/input proof 并保留已经执行的 hooks。
样式用例在导航时隐藏组件，仅通过显式 render data 显示，并用有效样式的独立正向对照确认 hooks 会执行；不会把静态组件已在 `page.push` 创建误判为 render 预检失败。

执行结果须绑定实际受测 commit；隔离分支预检和主仓整合验证分别记录，不能将格式解析或源码审查记作通过。
既有 browser_presentation、external_frame_input/recovery、image_render、presentation_reload、
触摸/滚动/observer/slot 与宿主测试继续保留；浏览器、GPU、设备与性能证据须另行绑定实际执行源码。
