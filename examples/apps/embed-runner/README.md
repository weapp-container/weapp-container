<a id="app-embedding-example"></a>
# 应用嵌入示例

**简体中文** · [English](README.en.md)


`embed-runner` 是一个小型应用程序进程，它嵌入了Web、桌面和原生宿主适配器所使用的相同运行时边界。它从资产目录加载一个打包的迷你程序，启动应用，发送一个能力请求，并读取一个完整的RGBA快照。一个真正的Activity、视图控制器、ArkUI能力或浏览器工作者可以使用此流程，并配合其自身的绘制表面呈现器。

在构建参考应用包之后运行它：

```sh
cargo run --manifest-path examples/apps/embed-runner/Cargo.toml -- \
  artifacts/reference-app/pack artifacts/reference-app/embed-report.json
```

包脚本接受通常的 pnpm 分隔符：

```sh
pnpm embed:reference -- \
  artifacts/reference-app/pack artifacts/reference-app/embed-report.json
```

运行时忽略单独的 `--`，因此两种形式等价。

输出是一个诊断日志。它不声明原生 GPU、模拟器或
微信开发者工具的兼容性。平台宿主应将示例中的 `render_snapshot()` 读取操作替换为自己的单次 CanvasKit/Skia/Metal/ArkUI 上传，同时保持桥接批处理和资源所有权规则不变。
