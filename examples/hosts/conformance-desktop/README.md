<a id="native-desktop-conformance-host"></a>
# 原生桌面兼容宿主

**简体中文** · [English](README.en.md)


这个独立示例拥有一个真实的 winit 窗口和一个 `HostSession`。
macOS 拥有 AppKit 窗口和 CAMetalLayer；Linux 拥有一个原生软件窗口及其软缓冲呈现器。它不使用无头模拟器或 C++ 桌面 SDK。
macOS 使用 Metal 配置文件。Linux 使用显式选择的软缓冲软件窗口，具有运行时拥有的绘制回执和精确的帧票据。
Windows/移动设备对需要各自实际的目标驱动程序。

主线程加载经过验证的可移植包，明确选择 QuickJS 或 V8，执行 `app.init`/launch/`page.push`，提交基于清单的帧，并通过选定的原生拥有者进行呈现。macOS 直接将内容渲染到 Metal 绘制表面；Linux 将光栅像素提交到其软件窗口。每次成功的提交都在同一运行时版本中得到确认。查询和输入需要当前页面已验收、已呈现的帧；保留旧路由帧不具有任何权限。启动快照是明确捕获的 CPU 诊断信息，与原生呈现完成分离。Linux 的软件证据是非 GPU 类型，无法满足独立 GPU 绘制表面的验证要求。

JSONL 输入操作为 `reLaunch`、`checkpoint`、`tap`、`inspect` 和 `close`，每个操作都有一个 `id`。检查点提供一个 ID 和有序选择器；其返回的文本/计数来自 `RenderFrame.query`。`tap` 精确解析一个显示的节点，检查其可击中的几何形状是否被接受，并通过 `event.batch` 提交坐标。这是宿主运行时的坐标输入适配器，而不是操作系统自动化工具。它从不直接调用客体处理器。

问题1058 节点驱动重复了上游的两次reLaunch操作、五个检查点和三次成功点击。预期文本仅限于断言；共享的被动收集器对实际返回的观测结果进行了归一化处理。其原始IPC和完整的原生桥接日志均被保留。

分别构建两个引擎，使用一个序列化的 Cargo 通道。示例的锁定文件解决了依赖关系；从 Cargo 的 JSON 输出中选择的二进制文件会被复制到一个独立文件并进行哈希处理。生产者在编译前后都会检查其完整的 Rust/原生示例源代码范围。脏构建会被明确标记为 `diagnostic`；正式的 `run` 导出会拒绝它们。当上游的固定版本 Metal 归档不可用时，必须显式提供本地 Skia 源代码/缓存前提条件；任何备用方案都不会被标记为 GPU。

默认仍为原生 aarch64 macOS/Metal。

```sh
mkdir -p artifacts/conformance-desktop
node examples/hosts/conformance-desktop/build.mjs \
  --engine quickjs --out artifacts/conformance-desktop/quickjs-build --diagnostic
node examples/hosts/conformance-desktop/build.mjs \
  --engine v8 --out artifacts/conformance-desktop/v8-build --diagnostic
```

在真实的 Linux GNU 宿主（x64 或 arm64）上，构造和诊断都必须明确选择 `--host linux --presenter software`。为每个引擎使用独立的输出目录进行构建；锁定构建会添加 `conformance-observation` 并验证原生 ELF 架构。这些命令必须在该 Linux 宿主上运行，并生成与源码绑定的全新二进制文件；旧的 ELF 无法为后续源码变更提供认证。

```sh
node examples/hosts/conformance-desktop/build.mjs \
  --host linux --presenter software --engine quickjs \
  --out artifacts/conformance-desktop/linux-quickjs-build --diagnostic
node examples/hosts/conformance-desktop/build.mjs \
  --host linux --presenter software --engine v8 \
  --out artifacts/conformance-desktop/linux-v8-build --diagnostic
```

以下命令**创建并关闭原生窗口**。仅在任务分配的原生 UI 通道中，且源内容创作完成后运行：

```sh
node examples/hosts/conformance-desktop/diagnose.mjs \
  --engine quickjs --build artifacts/conformance-desktop/quickjs-build/build.json \
  --out artifacts/conformance-desktop/quickjs-observation
node examples/hosts/conformance-desktop/diagnose.mjs \
  --engine v8 --build artifacts/conformance-desktop/v8-build/build.json \
  --out artifacts/conformance-desktop/v8-observation
```

Linux 观察使用相同的回放和被动采集器：

```sh
node examples/hosts/conformance-desktop/diagnose.mjs \
  --host linux --presenter software --engine quickjs \
  --build artifacts/conformance-desktop/linux-quickjs-build/build.json \
  --out artifacts/conformance-desktop/linux-quickjs-observation
node examples/hosts/conformance-desktop/diagnose.mjs \
  --host linux --presenter software --engine v8 \
  --build artifacts/conformance-desktop/linux-v8-build/build.json \
  --out artifacts/conformance-desktop/linux-v8-observation
```

对于直接的二进制调用，Linux 还需要 `--presenter software`，并配合 `--pack`、`--engine` 和 `--session`。它会报告 `software-fallback`、`softbuffer-raster`、`gpuSurface=false`、`containerSurfaceAttached=false` 和 `presentationCompletion=buffer-submitted`。成功的销毁必须报告 `softwarePresenterRetired`、会话卸载和原生窗口所有者的释放。它不会报告 Metal 解离或 GPU 完成。

诊断输出具有 `diagnosticOnly=true`，`formalMatrixAdmitted=false` 和
执行状态为 `unknown`。它无法提升正式索引或通过矩阵门控。正式的干净构建会通过 `WEAPP_CONFORMANCE_MACOS_QUICKJS_BUILD` 或 `WEAPP_CONFORMANCE_MACOS_V8_BUILD` 提供其 `build.json`。
Linux 正式构建使用 `WEAPP_CONFORMANCE_LINUX_QUICKJS_BUILD` 或 `WEAPP_CONFORMANCE_LINUX_V8_BUILD`。使用 `driver-registry.mjs` 生成精确完整的驱动闭包；默认注册表仅支持 macOS，明确的 `--host` 标志会选择特定请求的宿主：

```sh
node examples/hosts/conformance-desktop/driver-registry.mjs \
  --host macos --host linux --out artifacts/conformance-desktop/drivers.json
```

macOS 模块是 `driver.mjs`；Linux 使用 `linux-driver.mjs`，它将通用实现绑定到软件上。共享回放/收集器语义和归一化观测保持不变。
现有的矩阵运行器在调用任一对时，仍需一个被承认的官方预言机和干净源码验证。

正常的 `close`、EOF、宿主信号、超时和受控事件循环错误
跨越脱离/卸载/窗口丢失屏障。事件循环返回后，当窗口所有者被删除时，会发出终端清理记录。Node 适配器仅发出其自身脱离的子进程组信号，并需要原生清理记录；它从不使用全局进程/窗口关闭。

纯源码检查和单元测试不会创建窗口：

```sh
node --test examples/hosts/conformance-desktop/build.test.mjs examples/hosts/conformance-desktop/driver.test.mjs examples/hosts/conformance-desktop/host-profile.test.mjs
rtk cargo test --manifest-path examples/hosts/conformance-desktop/Cargo.toml \
  --features quickjs-native --locked --target-dir target
rtk cargo check --manifest-path examples/hosts/conformance-desktop/Cargo.toml \
  --no-default-features --features v8-native --locked --target-dir target
```
