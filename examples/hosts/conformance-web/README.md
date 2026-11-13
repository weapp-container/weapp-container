<a id="web-conformance-diagnostics"></a>
# 网页兼容性诊断

**简体中文** · [English](README.en.md)


此内部示例为可选启用的示例，观察了一个实际的 QuickJS Worker 和 CanvasKit 会话。它需要 `enabled: true`，一个单独构建的宿主/客体 WASM 运行时，一个精确的可移植包索引和已验证的渲染器资源。它不注册正式的矩阵驱动程序，也不颁发合规回执。

`web-controller.mjs` 中的 `createWebQuickjsCandidate` 创建真正的会话。
`replay1058({ request })` 执行已审核的 Node 操作和断言。桥接只将操作地址传递给 `controller.request(op, payload)`；预期结果保留在 Node 断言中。始终等待 `controller.close()` 并保留其实际回执，再释放所拥有的浏览器/服务器资源。

`frame-observer.mjs` 在查询或坐标点击之前，需要实际的范围帧回复、当前观察、已接受的呈现以及真实的输入回执。负向输入回执仍可被观察到，但不能授权输入。生成的 WASM 是一个纯 Rust 选择器投影器，与应用引擎分离。它编译共享桌面的 `observation.rs`；其加载器会检查精确的字节。

固定基线是 DevTools 2.02.2609250、SDK 3.17.3 和编译器 0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e。一个保留的实时浏览器诊断匹配了全部十个 1058 事件和两个断言，仅忽略了事件顶层的 `atNs`。它使用了存档的候选字节和宿主构建，记录在 `artifacts/conformance-web/actual-1058-r7-webdiag-v1` 中；重定位和后续的投影器重建不会将该观察结果重新绑定到新源。正式对偶保持为零。硬件 GPU 使用情况和中间渲染像素均未验证。

从仓库根目录运行合成边界和真实投影仪测试：

```sh
node --test examples/hosts/conformance-web/frame-observer.test.mjs examples/hosts/conformance-web/projection-wasm.test.mjs examples/hosts/conformance-web/transition-contract.test.mjs
```

仅使用 `build-projection.mjs --cargo <absolute>
--rustc <absolute> --wasm-bindgen <absolute>` 重建纯投影器，使用支持 WASM 目标和 wasm-bindgen 0.2.129 的 Rust。构建记录完整源码、工具和输出哈希信息于 `projection-build.json`。其报告和合成测试并非运行时证据。Web/V8 不可用且被明确拒绝。
