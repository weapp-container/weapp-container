<a id="dual-rendering-development-example"></a>
# 双渲染开发示例

**简体中文** · [English](README.en.md)


这个普通 `weapp-vite` 项目包含三个页面：DOM 首页 → Skia 页面 → 新 DOM 页面。
两种呈现方式共享一个 AppService。它用于开发和交互检查，不表示官方微信、
GPU 性能、原生 WebView 或七宿主门禁已经通过。

在仓库根目录运行，先按
[资源准备说明](../../../crates/container-simulator/README.md#local-gpu-scene-presentation)
准备固定版本的 CanvasKit 和字体资源：

```sh
pnpm simulator:dev -- --project examples/apps/dual-renderer-app \
  --surface web --renderer auto --web-runtime remote \
  --renderer-assets artifacts/dual-renderer-dev-assets
```

`auto` 保留逐页选择，不能用全局 `--renderer webview|skia` 代替。此入口使用本机
QuickJS 与浏览器 DOM/CanvasKit；当前浏览器独立开发入口不接受 `auto`，原生
桌面 WebView 也尚未接入。V8 可用时，启用 `v8-native` feature 并传入 `--engine v8`。

建议按以下顺序检查：

1. 首页点击两次计数，记下页面实例、`ready` 次数、会话和 timer ID。
2. 打开 Skia 页并点击计数。页面计数从零开始，共享点击继续累加。
3. 返回首页：原计数和实例保留，`ready` 不重复，显示次数增加。
4. 再次打开 Skia 页，选择“替换为新的 DOM 页面”。该页使用新实例；返回后
   最初的首页仍保留。会话、App 启动次数及 timer ID 应保持。
5. 等待后点击“刷新共享存储与时钟”，确认同一个 App 时钟继续增长。

时钟每秒只更新 App 逻辑状态，显示在页面出现或手动刷新时采样，避免为演示
持续触发无关绘制。共享点击保存在 `dual-renderer-app:taps`，当前会话标识保存在
`dual-renderer-app:session`。同一 session 内的页面与 renderer 切换，以及安全的
原地 reload，会保留 storage 和 App 时钟；仍在页面栈中的页面数据也会保留。

默认开发沙箱的 storage 存放在内存中。完整 JS session 重启（包括脚本热更新）
或模拟器进程重启会清空该沙箱；页面计数、共享点击和 App 时钟重新开始。
跨启动持久化需要宿主另外提供持久存储 Provider，本示例未接入该能力。

<a id="building-and-renderer-configuration"></a>
## 构建与 renderer 配置

复用固定 submodule 的标准 CLI 和现有 packer，不另加插件或修改上游：

```sh
pnpm --dir vendor/weapp-vite exec wv build \
  "$PWD/examples/apps/dual-renderer-app" -p weapp \
  --outDir "$PWD/artifacts/dual-renderer-app/raw"
pnpm container:pack -- artifacts/dual-renderer-app/raw \
  --out artifacts/dual-renderer-app/pack \
  --project examples/apps/dual-renderer-app \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
```

`container.config.json` 按**产出 route path** 映射 `webview → skia → webview`。
packer 必须收到 `--project` 才会加载该配置，并生成 schema 3 的
`manifest.rendering`。开发监督器已经负责传入源项目；无需额外配置。
原始 `app.json` 与页面 JSON 不写入容器专用 renderer 值；直接用官方工具运行
原始产物时不会启用这里的 Skia 路径，也不等同于官方 Skyline 验收。

三个页面复用 `shared-page.js`，无额外 npm 依赖、分包或自定义 chunk 策略。
原始产物的模块与 chunk 仍由 Vite/Rolldown 拥有，portable pack 只转换既有输出。
状态由页面的可见字段展示，不依赖编译器保留小程序入口的额外模块导出。

<a id="current-validation-scope"></a>
## 当前验证范围

2026-10-26 已使用固定上游 SHA
`0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e` 实际执行微信目标的 `wv build`，
再用现有 packer 生成 portable pack；两步通过，三条路由的 schema 3 renderer
映射正确，packer diagnostics 为空。产物与日志保存在独立构建目录。

本轮未在浏览器运行这个新应用，也未运行 DevTools、原生宿主或性能验收。
已有手写 static fixture 的浏览器通过记录不能转移为本应用的交互通过记录。
