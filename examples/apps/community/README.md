# 开源小程序示例

**简体中文** · [English](README.en.md)

这里是从上游开源仓库整理出的可运行快照，供容器构建、打包和模拟器示例使用。它们保留上游 MIT 许可证，并在 [`SOURCES.json`](SOURCES.json) 中固定来源提交、原始目录与调整说明。

| 示例 | 来源 | 展示内容 |
| --- | --- | --- |
| `miniprogram-demo-text` | 上游 `miniprogram-demo` 快照 | 文本列表、滚动视图和添加/移除交互 |
| `ant-design-button` | Ant Design Mini `3.4.3` | 按钮类型、禁用/加载状态和容器组件 |
| `taro-blended` | Taro `examples/blended-basic` | Taro 混合项目中的小程序页面与自定义组件 |

从仓库根目录执行以下命令构建和运行单个示例。`<name>` 可替换为表格中的目录名。

```sh
pnpm --dir vendor/weapp-vite exec wv build \
  "$PWD/examples/apps/community/<name>" -p weapp \
  --outDir "$PWD/artifacts/community/<name>/raw"
pnpm container:pack -- "artifacts/community/<name>/raw" \
  --out "artifacts/community/<name>/pack" \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
cp "examples/apps/community/<name>/LICENSE.upstream" \
  "artifacts/community/<name>/pack/LICENSE.upstream"
cargo run -p container-simulator --features quickjs-native -- \
  dev --project "examples/apps/community/<name>" --surface web
```

交互运行命令会保持模拟器开发服务器开启，并输出本地 Web 地址。构建产物与 portable pack 写入被忽略的 `artifacts/` 目录。需要检查构建、WXSS 热更新、JS 重启、错误诊断和恢复链路时，运行 `pnpm simulator:dev:smoke -- --project "examples/apps/community/<name>"`。模拟器与 headless 浏览器检查只验证此软件运行链路，不代表微信开发者工具、GPU 或设备兼容性结论。

Taro 样例基于上游 blended-basic 的小程序侧文件，去除了指向未包含 Taro 输出目录的分包导航，并使用本仓库固定的 `weapp-vite` 构建。Ant Design Mini 样例从 `antd-mini@3.4.3` 发布包复制按钮组件所需的本地依赖闭包，组件目录名已调整为小写本地路径，将 CSS 自定义属性回退值展开为字面量，并移除了远程图标字体和未使用的 Alipay 字形，以适配当前容器支持的 WXSS 子集。文本样例保留上游组件示例的列表与滚动交互，并去除了原演示导航和外部资源依赖。
