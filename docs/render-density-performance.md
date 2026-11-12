# 渲染密度、帧传输与诊断

本次修复将逻辑布局、实际物理目标和 CPU 像素获取分开维护：

- Web、browser dev owner 和远程模拟器的自动密度原先最高 2×。现在采用实际显示 DPR，保留 0 < DPR ≤ 4 和物理像素预算；预算不足明确失败，不静默降低清晰度。
- 软件渲染原先不能提交高密度目标。现在按接受目标的物理尺寸栅格化，几何及裁剪只转换一次，逻辑布局、命中和输入坐标不变。尺寸未变的密度更新保留有效快照及 ACK 身份。
- SDK 常规 CPU 帧获取原先返回整帧克隆。现在按 revision 和接受目标尺寸缓存 `Arc<RenderSnapshot>`，C ABI 帧句柄持有不可变共享像素。旧句柄在 resize、下一帧和 close 后仍有效；显式兼容 snapshot API 仍返回独立拷贝。
- Web 外部帧的图片原先经过 RGBA JSON 数组，再逐索引检查属性并复制为字节。新 WASM 导出使用 WCF1（魔数、元数据长度、布局 JSON、连续 RGBA），Worker 验证资源数量、尺寸、范围、总预算，再传输独立字节缓冲。旧 JSON API 保留兼容，GPU 常规呈现不读取整帧像素。
- CanvasKit 的已排版文字原先逐字形调用 `getGlyphIDs` 和 `drawGlyphs`，每次绘制都跨越 JS/WASM 边界。现在每个文字节点一次映射和提交，沿用排版后的绝对坐标；小数原点与重叠字形通过真实 CanvasKit CPU 像素对照。`Uint8Array` 的整数与范围由类型保证，不再每帧逐字节重复检查；旧 JSON 数组仍检查所有元素及空洞。

`renderDiagnostics` SDK 命令返回最多 120 帧的实际 backend、mode、GPU attachment 状态、逻辑及物理尺寸、DPR、prepare/snapshot 耗时和确切 generation/revision 的 ACK 等待。重复或不匹配的 ACK 不增加样本。ACK 间隔不是显示刷新时钟，报告明确保留 `scrollFps:null`、`droppedFrameRate:null`。Web 新协议另记录 prepare/export 时间和 `binary-rgba` 或 `json-rgba` 传输方式，Showcase 性能报告保存原始样本。

验证入口包括共享 renderer 的 DPR/像素边缘回归、runtime 的初始和动态密度测试、SDK 的共享像素与旧帧生命周期测试、WCF1 损坏范围测试、Worker 实际 MessagePort 传输及呈现事务测试。软件、协议测试不证明真实设备 GPU 帧率；发布证据必须分别记录平台、实际 backend、首帧、滚动和内存结果。

后续 profile 定位到普通帧 metadata 的无效对象分配，以及图片缓存逐字节比较。转换器现在仅在子值变化时创建替换对象；对齐 RGBA 按 32 位比较全部像素，非对齐及旧数组仍逐字节比较。真实 Worker 客户端验证后签发模块私有的单次 ownership receipt，session 可消费已有帧；其他来源、第二个消费者及过期响应仍复制。

Worker 的 event/frame/ACK 队列原先经由嵌套零延时 timer，受浏览器最小延迟限制。支持时改用 `scheduler.postTask`，保留真实 task 边界、队列顺序、关闭和 timer 公平性；不可用或提交失败均回退 timer，令牌保证至多执行一次。采样量、稳定两 RAF 和性能阈值没有变化。

原 Noto Sans SC 可变字体的默认 wght 为 100，Web 默认实例因此呈现 Thin 字形。`scripts/prepare-renderer-font.py` 固定使用 fonttools 4.60.1 生成 wght 400 的 Container Sans SC Regular，保留全部 30,890 个字符及 OFL。输出 10,595,952 字节，比原字体减少 40.4%；两次生成哈希一致，SHA-256 为 `916bd5146cd1099aff18931fd0c85f4f3fd1ff7b2c966cb3cc22a4e5a6216983`。历史 restricted native SDK 仍包含原字体，保留旧哈希及安装边界；本次 Web 字体替换不代表历史原生包已经重建。

Showcase 历史生产输入 p95 1116.7ms、frame RPC p95 736.5ms 的样本见子模块 `showcase/docs/showcase-performance.md`。新版本的现场结果以发布保留报告为准，不能用本次源码优化直接推断已通过性能门禁。

`showcase/` 为 website 仓库的 submodule，使用 `git submodule update --init showcase` 获取锁定提交；发行工具位于核心仓库的 `tools/runtime-artifacts/`。在父 pnpm workspace 内安装 Showcase 时执行 `pnpm --ignore-workspace install --frozen-lockfile`。运行库需从干净的已提交源码重新构建，发布锁定确切源提交、产物哈希与许可收据；生产部署前先完成 staging 验收并封存回滚版本。


原生核心产物可以通过 `node scripts/dev-player-runtime-archives.mjs --runtime-root <inputs> --platform <platform> --runtime-only --out <fresh-output>` 独立打包。该路径仍校验完整架构集合、同一干净源码提交、原生库和 ABI header 的原始哈希、许可、离线解包与所有文件；不要求未改动的 wrapper 先重新构建，也不会生成 wrapper 已通过的记录。没有 `--runtime-only` 时保留原 SDK 分发与消费者检查。

2026-11-10 本机 Chrome 157.0.8103.39 的旧生产对照（36 次输入、14 次热切换）记录输入到稳定帧 p95 1516.4ms、frame RPC p95 943.4ms、事件批处理往返 p95 21.2ms。该次流程在关闭时未等待浏览器 Worker close 通知而失败，原始失败证据保留。初始新二进制通道只取得 15 次输入：frame RPC p95 116.6ms、导出 p95 6.3ms；旧 pack 缺少当前网站的场景协议，未通过完整验收，不是发布通过证据。重新打包当前 miniapp 后，packRoot 为 `91005c9eb32255f1b6f337c48fd7a4404e55e10cb2b3d67587604f44a4b0e98a`，policy 为 `1c4aa7886f2aed8f4c9fc955c6378cf8c76e76cc8b7bb50fa500e9ca7363f02a`。

candidate17 的 staging 完整性能门禁通过：37 次输入 p50/p95/p99 分别为 77.7/82.5/98.8ms，14 次热切换 p95 为 222.9ms。采样下限、100/200ms 输入阈值、1500ms 热切换阈值和稳定两 RAF 条件均未放宽。8 次冷启动的 p95 达 127579.3ms，包含网络长尾，不能据此声称首帧加载已经达标；先前的资源下载超时和测试竞争失败也保留在子模块 evidence 中。

同一 Chrome 157、Apple M4 Max Metal、DPR 2、逻辑 951×669 / 物理 1902×1338 的滚动场景，旧生产 RAF 为 42.54 次/秒、估计错过刷新比例 29.139%、10 次 long task；新 staging 为 60.058 次/秒、估计错过刷新比例 0、0 次 long task，并收到 180 个不同 revision 的 ACK。RAF 采样和 ACK 不是 scanout 帧率；ACK 速率单独保留为 16.454 次/秒。DPR 3 手机视口 402×874 对应 1206×2622 像素，180 次 wheel 对应 180 个不同 ACK、RAF 59.992 次/秒、0 次 long task。DPR 3 折叠屏超过 16MiB 目标预算的失败也保留，未通过降密度绕开。

原生完整 CI run `42819228603` 在启动前因 GitHub 账户付款/用量限制被拒绝。本次原生发行输入固定为 `a6b04bd6c6a3881348e3a1a2babff8651df9d445`：该提交与 Web producer `ffd1e47ade9c3b3cccf45b897a5f54af7d46b818` 的 `crates/`、`sdk/contract` 完全相同。使用 run `42808278782` 的成功目标及该确切提交的干净本地补建；失败目标的空产物不参与打包。第三方 Skia 静态库输入按目标、锁定 crate、文件 SHA-256 及源码 inventory 记录，Rust/QuickJS/绑定重新构建。原生构建与离线安装不代表各宿主滚动性能已经通过；未测平台的 FPS、丢帧和内存数据保持缺失。

生产 Showcase 已部署至 `https://container.weapp.dev`，version 为 `66285215-06b4-4159-b08b-3b7296769e44`，回滚 version 为 `52505815-3011-42ad-b759-44189e3e4a67`。线上 37 次输入 p95/p99 为 90.7/98.8ms，14 次热切换 p95 为 696ms，43 项设备轮换检查及 HTTP 探针通过。冷启动 p95 为 121021.4ms，生产独立滚动探针两次因字体下载期间的 RPC 超时失败，没有把 staging 的滚动结果标成生产结果。完整成功、失败报告和快照保留在 Showcase 私有 candidate17 release。

九个原生 runtime 归档已追加至 `runtime-artifacts` 的 `runtime-v0.1.0-preview.6.0`，没有覆盖历史资产或 tag。独立 contract 下载器对九目标的全新安装、缓存复验及错误哈希拒绝全部通过，网络请求数为零；九归档及五份清单/收据的 GitHub 服务端摘要与本地完全一致。Android wrapper/AAR/APK 的原生库字节一致性检查通过；现有 L2 真机仅支持 32 位 ABI，安装失败并清理。ARM64 API 30 模拟器首次初始化期限失败；构建完成后相同 APK 复测 7 项 GLES attach、恢复和 close/reopen 检查通过，4 次注入恢复对应 4 条日志，失败与通过报告均保留。测试包已卸载，只读模拟器已关闭。这不代表各平台真机 FPS 已验证。
