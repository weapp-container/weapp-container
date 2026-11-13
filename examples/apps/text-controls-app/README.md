<a id="dom-text-editing-development-example"></a>
# DOM 文本编辑开发示例

**简体中文** · [English](README.en.md)


这个普通 `weapp-vite` 项目通过真实 `input` 和 `textarea` 演示文本编辑、
`input/focus/blur/confirm` 事件、光标/选择区观测、disabled、maxlength、密码遮罩，
以及 AppService 主动替换 value。无新增依赖，原始微信产物仍可由官方工具打开。
容器专用 renderer 只在 `container.config.json` 声明为 `webview`。

在仓库根目录运行：

```sh
pnpm simulator:dev -- --project examples/apps/text-controls-app \
  --surface web --renderer webview --web-runtime remote
```

该入口由本机 QuickJS 执行 AppService/View，浏览器的隔离 DOM 文档负责文本编辑。
V8 使用方式与其他开发示例相同：启用 `v8-native` feature 并传入 `--engine v8`。

建议依次检查：

1. 编辑单行文本，检查输入事件数、回显的 cursor/selection 与日志；按 Enter 检查 confirm。
2. 编辑多行文本并按 Enter，检查原生换行和 AppService 中的多行 value。
3. 用方向键和 Shift 选择文本，再继续编辑；观察更新后的光标与选择区。
4. 点击 Disable editors，确认两个编辑器不能再编辑；重新启用后继续输入。
5. 点击 Replace values from AppService，检查声明 value 的变化会替换两个字段。
6. 密码字段只演示原生遮罩，不向应用事件日志回传值；不要输入真实凭据。

事件记录在 Page 的有界私有日志，最多保留 24 条。focus/blur 与 input/confirm
均会调用真实 `setData` 并更新计数，专门暴露焦点恢复不应重新触发应用 focus 的边界。
控件内部恢复造成的焦点不能累加计数或触发无限呈现循环。
组件传来的普通事件事实没有浏览器 handler、传播路径或 owner 授权；它们继续由
共享运行时按当前已呈现文档中的声明解析。

<a id="standalone-build"></a>
## 单独构建

```sh
TEXT_CONTROLS_REPO="$PWD"
cd examples/apps/text-controls-app
node "$TEXT_CONTROLS_REPO/vendor/weapp-vite/packages/weapp-vite/bin/weapp-vite.js" \
  build . -p weapp --outDir "$TEXT_CONTROLS_REPO/artifacts/text-controls-app/raw"
node "$TEXT_CONTROLS_REPO/tools/container-manifest/bin/container-pack.mjs" \
  "$TEXT_CONTROLS_REPO/artifacts/text-controls-app/raw" \
  --out "$TEXT_CONTROLS_REPO/artifacts/text-controls-app/pack" \
  --project "$PWD" \
  --compiler-commit 0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e
```

编译器在项目工作目录生成受管 TypeScript 配置；该位置已有精确忽略规则。
不要从主仓根目录或固定 submodule 的工作目录运行项目初始化。

<a id="current-boundary"></a>
## 当前边界

本例用于新 DOM 文本控件适配的开发与验证；示例源码存在不等于浏览器专项通过。
实际 compiler、portable pack、QuickJS/V8 和浏览器结果须由绑定具体源码的报告记录。

当前 presenter 的跨文档更新仍会更换原生 iframe/控件；完整的中文输入法组合输入
在更新期间不中断，需要后续稳定原生编辑面和编辑生命周期协议。已有 `isComposing`
确认键保护、中文文本输入或 selection 测试不能替代这项验收。
本例也不授予真实移动键盘、原生 WebView、Skia 文本编辑、官方微信等价性、硬件或
性能门禁通过。
