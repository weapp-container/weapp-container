<a id="modern-synchronous-view-example"></a>
# 现代同步 View 示例

**简体中文** · [English](README.en.md)


从仓库根目录运行：

```sh
cargo run -p container-simulator --features quickjs-native -- \
  dev --project examples/apps/modern-view-app --surface web
```

对于桌面窗口，启用 `quickjs-native,desktop-window` 并传递 `--surface desktop`。对于 V8，启用 `v8-native` 并传递 `--engine v8`。

该页面通过 `container.config.json` 启用标准同步 ES2022。
其 TypeScript 视图使用可选链、解构、扩展运算符、私有类字段、Map/Set、生成器、枚举和将 BigInt 转换为文本。两个视图别名共享一个 ESM 依赖项。子组件仍为传统 WXS 组件；其构造函数观察使用 WXS 兼容路径。

编辑 `view/format.view.ts` 以执行只读视图重建。如果编译失败，模拟器将保留上次运行的版本。成功编译后，可重新启动会话。异步工作和宿主 API 应属于 AppService。

类型检查与运行时编译是分开的：

```sh
pnpm install --frozen-lockfile
pnpm modern:view:typecheck
```

查看导入使用相对路径（JS/TS 扩展名可省略）或 npm 包入口点。运行时编译不会继承 `tsconfig.json` 的路径别名、`baseUrl` 或项目引用，包括生成的 `.weapp-vite` 配置文件。`tsconfig.view.json` 控制独立的类型检查。

原始 `wv build` 输出保持其原始的所有权和格式。现代别名由容器打包器添加；直接在微信开发者工具中打开该原始输出不会提供此容器扩展。本示例并非官方 WXS、设备/图形处理器或近似验收证据。
