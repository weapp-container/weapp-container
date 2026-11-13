<a id="packaged-images"></a>
# 包装的图像

**简体中文** · [English](images.en.md)


`image` 在已提交的 `RenderFrame` 中使用共享的解码资源表。
运行时会将 `src` 对应到声明的 WXML 文档，包括自定义组件和投影插槽。根路径从可移植应用根目录开始。它只读取清单中声明的资产和经过 SHA-256 验证的二进制数据；图片不会导致渲染器读取宿主文件系统或获取 URL。

静态 PNG、JPEG 和 WebP 由固定的 Rust `image` 依赖项解码。
重复使用相同的编码 SHA 会共享一个 `Arc<ImageResource>`，包括帧克隆。生成的帧直接传递给渲染器，无需经过 JSON 序列化/反序列化往返操作。资源授权仍属于当前清单和会话；开发清单替换需要重新验证资源。

帧的网络格式增加了可选的 `images` 映射。每个值为 `{width, height, pixels}`，其中像素是紧密打包的、连续的 RGBA8 字节。`RenderNode.image` 为 `{resource, mode}`；资源名称指定确切的映射键名。manifest 生成的键为 `sha256:<encoded asset hash>`。原始帧生产者需自行负责像素来源：仅凭资源名称并不能证明编码资产的真实性。旧版帧（无 images）保留其之前的网络格式。

所有 14 种模式字符串均被识别：`scaleToFill`、`aspectFit`、`aspectFill`、`widthFix`、`heightFix`、`top`、`bottom`、`center`、`left`、`right`、`top left`、`top right`、`bottom left` 和 `bottom right`。比例模式保持源图像的比例，裁剪模式对齐原始像素，宽度/高度固定模式通过布局求解器保持固有比例。图像的默认内容框为 300 × 225 逻辑像素。显式尺寸、百分比、弹性约束、边框和内边距使用与选择器和输入相同的几何信息。

软件、原生 Skia 和 CanvasKit 使用最近邻采样，并在内容框和节点的外圆角边界处裁剪图像内容。变换、祖先溢出和滚动操作适用于图像。图像在其绘制子树中保持其固有的 RGBA 透明度；节点及其祖先的 `opacity` 值会作用于它们的完整组，且在背景、边框、图像、文本和后代元素组合完成后才生效。它们不会独立地乘以每个图像或原始图形。嵌套组的组合及其资源预算在 [透明度协议](compositing.md) 中有详细说明。此采样选择是确定性的本地行为；官方插值质量和 DevTools 中的像素精度尚未验证。

一个编码资产的大小限制为 8 MiB，每个维度限制为 8,192，每张解码图像的最大像素数为 16,777,216（即 64 MiB RGBA）。一帧最多可接受 1,024 个资源和 128 MiB 的图像字节总量。无效的维度、长度、资源 ID 或引用将在替换已接受帧之前被拒绝。运行时解码缓存有上限且为会话本地。被拒绝的候选帧会保留之前的像素、选择器几何形状和资源授权信息。

这些限制约束了编码输入和已接受的解码数据负载。编解码器暂存内存和显式原始帧的JSON解析是独立的分配；这并不是峰值内存或进程RSS的测量限制。

这是打包的静态图像边界。远程/数据/文件/提供者 URL、动画 PNG/WebP/GIF、SVG、异步 `load`/`error` 事件、懒加载和图像菜单仍需实现和官方确认。通过 `wx.canIUse` 进行组件和图像子属性发现尚未注册；未知特性字符串仍返回 false。对这些行为的请求会明确失败，而不是被视为成功的图像加载。空 `src` 会保留空的图像框。损坏的打包图像或缺失声明的 blob 会导致渲染错误；超出此边界的提供者/格式/事件能力将返回 `ERR_UNSUPPORTED_CAPABILITY`。

按照[模拟器指南](simulator.md)中的说明准备固定编译器后，运行开发固定件：

```bash
pnpm simulator:dev -- --project examples/apps/image-contract-app --surface web
```

该组件保持了原始 `weapp-vite` 输出能够被官方 DevTools 加载。
容器负责可移植打包、资源校验和渲染。
未增加任何 chunk、子包或上游编译器的变更。

对于原生双引擎验证，构建模拟器并运行：

```bash
cargo build -p container-simulator --features v8-native --locked --jobs 2
pnpm runtime:image:smoke -- \
  --simulator-bin target/debug/weapp-simulator \
  --compiler-root <verified-pinned-compiler> \
  --compiler-dist-hashes <compiler-dist-sha256.json> \
  --out artifacts/images.json
```

烟雾生成实际的实体，验证编译器/输出字节未发生变化，
在 QuickJS 和 V8 中执行相同的页面处理程序，比较所有模式的几何体和像素样本，并检查源交换、被拒绝的远程源、保留帧和恢复情况。资源传输仍保持每帧一个表；未增加任何节点的 Rust/JS 桥接。性能预算需要单独测量。这些本地检查不会改变官方案例、GPU 或设备的验收状态。

库存案例 `view-image-static-001` 映射到此烟雾测试和
`crates/container-runtime/tests/image_render.rs`；其本地证据无法证明 `view.wxml-wxss` 组的部分支持状态。
