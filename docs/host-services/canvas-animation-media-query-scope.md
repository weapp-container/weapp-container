# Canvas、Animation 与 MediaQueryObserver 实现范围

本批沿用微信基础库 3.17.3、`miniprogram-api-typings@5.2.3`、1265 API × 七端
共 8855 单元的固定口径。源码实现、有限引擎测试、安装产物、公开 SDK 链路、设备和
商户验收分别记账。本文不将尚有完整参数或生命周期缺口的 API 晋级为 available。

## Canvas

QuickJS/V8 从同一 `container-core/src/canvas.js` 安装命令 facade。命令参数在入队前
复制为有限的原始值/数组；循环、accessor、非有限数字和不支持的对象明确拒绝，
不会沿用通用 clone 的原对象 fallback。每个 context 最多 16384 条待提交命令、
估计 4 MiB 参数载荷；单命令限制为 65536 个值和 8 层数组。载荷估算不代表 JS 引擎
总内存上限。成功入队后消费本次命令前缀；同步入队失败保留前缀供显式重试；
`reserve` 只保留 renderer 历史，不重复提交旧命令。入队期间拒绝嵌套 draw，
新记录的尾部命令留给下一次 draw。绘制失败不触发成功回调。

同一 OffscreenCanvas 的 `getContext('2d')` 复用一个对象与命令队列。它仍是现有
batched CanvasFrame 的有限接口，不具有标准立即绘制或完整 OffscreenCanvas 语义。

原生 Skia 对 `setLineDash` 使用真实 PathEffect，strokeRect/path 显式检查过滤结果，
复杂度拒绝不会静默变成实线；带 dash 的 strokeText 明确拒绝，普通 strokeText
与其他 stroke 共用配置。文字对齐使用实际字体 advance 和 metrics，并参与 save/restore。
完整 batch 先预验证，再分配 native surface、访问字体并执行。interval、周期和
native 数量溢出明确拒绝，执行失败不发布新历史或像素。软件 dash 按画布内像素
投影和周期边界二分处理，不再按可能极多的间隔枚举；每条线段的工作量受画布尺寸约束。
已知 compound 限制在分配 surface/访问字体前预检；字体安装只在 native 绘制及
readback 成功、即将发布时锁定，首次被拒的绘制保持可安装，既有成功 owner 不会解锁。

以下缺口仍阻止整项 available：Canvas page/component owner namespace 与退休，
`createCanvasContext` 的 component 参数，resize 清空像素和绘图状态，完整绘图属性、
图像/渐变/阴影/裁剪，Path2D 及 Canvas 工厂、混合变换 path 语义、完整字体塑形。
Skia 的 hanging/ideographic 使用 ascent/descent 惯例近似，未实现字体 BASE 表；
软件文字仍有限，native 执行不代表七端物理呈现验收。

## Animation

双引擎共用 `animation.js`。补齐可选 translate 参数默认值；step 先完成 options
读取和验证，再提交动作，getter 抛错不丢队列；读取 options 期间拒绝重入修改。
export 交出独立队列并清除未 step 的残留。参数只接受固定类型允许的原始值，
设置 16384 个 operation、4096 个 step 的显式资源上限，export 后释放配额。

runtime/renderer 尚未消费 animation 属性并按真实 frame clock 播放。全部 Animation
方法与 `wx.createAnimation` 继续 partial，不把可导出的动作队列当作可见动画。

## MediaQueryObserver

Session 的 observer/callback 和完整 desired state 位于共享私有 registry，绑定真实
Page/Component incarnation 与 pageToken。双引擎从 bootstrap 保留的 receiver transport
抓取单调 revision 和完整订阅快照，native 完成全量验证后原子替换；公开 api.call、
observer alias、通知函数和 effect queue 不能注册、撤销或投递这些私有订阅。
普通 Session 与受信导航镜像各自维护私有 current-page 数组，便携全局 factory
读取实际当前 Page，不依赖可改写的 getCurrentPages/公开数组。

固定 catalog 只有 `object:MediaQueryObserver.observe` 与 `disconnect`，不包含便携
`wx.createMediaQueryObserver`；本批不增加分母。descriptor 只读取 width、height、
minWidth、maxWidth、minHeight、maxHeight、orientation 七个字段，各通过捕获的
Reflect.get 读取一次，支持继承和 getter。未知字段、循环与 toJSON 不进入快照；
读取完成后再次验证 owner/disconnect，拒绝同一 observer 的 descriptor 重入。
当前数值策略接受有限非负数，orientation 为 portrait/landscape；min/max 含等值。

`disconnect` 的固定签名无参数、返回 void。它同步停用 observer 并清除私有 callback，
重复调用幂等；每个待派发 callback 都复核 active、owner/page token 和订阅身份。
因此前一个 callback 中 disconnect、getter 中 disconnect、dispose、terminal app unload
及失败后 poll 重试均不能恢复已撤销的回调。native 下次抓取完成资源回收，停止语义
不等待 native ACK。只将这一个方法的七端核心实现晋级 available，公开 SDK 验收仍为 pending。

`observe` 继续 partial：官方固定类型没有给六个 number 字段的非负限制，当前拒绝负值
不能声称完整数值域兼容；重复 observe 当前保留独立订阅，disconnect 后禁止再次 observe，
但固定版本替换/复用语义仍缺依据。隐藏或缓存 owner 当前保留到 disposal，正方形尺寸
按 portrait 处理；这些实现策略的固定版本通知时机和方向依据仍待补齐。
首次与 match 变化由真实宿主页面逻辑尺寸异步触发，不把当前策略测试当官方 oracle。

私有投递复用 retained lifecycle dispatcher；每个 callback 获得独立 `{matches}`，
普通 callback 错误进入既有诊断通道且不阻断其他 observer。notify 在可失败抓取前记录
重试债务，成功 media 状态先于后续 intersection 投递提交，避免暂时失败丢通知或重放
已成功的 media callback。1024 个已观察 observer、4096 个订阅和 u64 序列有显式上限。
独立引擎保留历史公开诊断路径，该路径不作为 Session owner 完整性的证据。

## 产物与验收

本批新增共享 JS 由生产 AppService bootstrap 内嵌到 QuickJS/V8 runtime。旧 SDK
归档、preview 锁和历史浏览器证据不自动包含这些修改，必须保留原 source 绑定。
本批的安装产物、公开 SDK、物理设备与商户验收状态见对应冻结证据；没有新证据的
范围继续 pending，accepted 不因源码测试通过而变化。

后续产品 `c058896f43e346f0c300bcbc6f6ab92ceea33466` 已实现 Canvas owner/stroke/页面重绘事务，四属性新增28partial、available增量0；最终47阶段及真实macOS Metal结果和Web构建边界见[新范围](canvas-owned-stroke-scope.md)与[证据](../archived-evidence.md)。早期“未执行/未接入”说明属于对应批次状态，不覆盖后续精确产品结论。
