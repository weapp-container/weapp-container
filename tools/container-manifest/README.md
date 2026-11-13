# `container-manifest`

**简体中文** · [English](README.en.md)


`container-manifest` 将 `wv build -p weapp` 目录转换为 Weapp Container 运行时使用的版本化便携式清单。它不会重写原始的微信输出，因此输入目录仍可被官方 DevTools 所导入。

使用 Node 24.22.2。源码采用 repoctl 的 tsdown CLI / 库模板；构建生成 `dist` 与类型声明，npm 包仅分发构建产物。安装后使用 `container-pack` 命令，程序接口从 `@sonofmagic/container-manifest` 及其子路径导入。

## CLI

```bash
pnpm install --frozen-lockfile
pnpm --dir tools/container-manifest build
node tools/container-manifest/dist/cli.mjs \
  ./path/to/weapp-dist \
  --out ./artifacts/reference \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
```

输出目录包含：

- `manifest.json`：标准 UTF-8 JSON，版本 v1，现代 View v2，或显式渲染器配置 v3；
- `blobs/sha256/<digest>`：基于内容的原始模块，归一化的 WXML/WXSS 中间表示（IR），分别编译的 WXS/WXML 可执行文件和资源；
- `capability-matrix.json`：宿主/引擎支持记录，用于 `wx.canIUse`；
- `diagnostics.json`：输入扫描的稳定警告/错误信息。

manifest 完整性根是其规范形式的 SHA-256 散列值，其中 `integrity.root` 设置为空字符串。规范的 JSON 按 UTF-8 字节对对象键进行排序，并按语义顺序输出数组（路由保持 `app.json` 的顺序；扫描的资源按归一化的 POSIX 路径排序）。

<a id="library-api"></a>
## 库 API

```js
import { buildManifest, packContainer } from '@sonofmagic/container-manifest';

const result = await buildManifest('./dist');
await packContainer('./dist', './artifacts/reference');
```

`buildManifest` 无副作用且返回 `{ manifest, blobs,
diagnostics }`。`packContainer` 在任一诊断的严重性为 `error` 时拒绝写入输出，并报告结构化的 `ERR_INVALID_MANIFEST` 错误。

扫描器识别 `.js/.mjs/.cjs/.json`、`.wxml`、`.wxss/.css`，并将其他所有文件作为资源保留。WXML 和 WXSS 源代码会被解析为版本化的、规范化的 JSON 块，然后进行哈希处理。WXML 块包含元素节点、文本节点和注释节点，排序后的属性、mustache 绑定以及与 Rust 的 `WxmlDirectives` 匹配的结构化控制流/事件指令。原始属性保持无损。Rust 解码器还对早期 v1 打包器生成的仅属性源块进行归一化处理；明确的指令和已评估的键/绑定元数据仍具权威性，因此不会重建重复项。WXSS 块使用 IR v2，包含选择器、声明（包括 `!important`）以及嵌套的 at-规则。每个导入都作为空体 at-规则存在于有序的 `rules` 数组中；旧版的 `imports` 数组保持为空。导入源位置和包含的组信息被保留，包括运行时在激活时会明确拒绝的放置位置。如 `@font-face` 等声明体仍与嵌套规则列表分离。解析 at-规则并不表示其执行或渲染被支持。清单模式仍保持 v1 以兼容旧版打包包；Rust 解码器继续读取旧版 WXSS IR v1。有关兼容性边界，请参见 [WXSS 合约](../../docs/wxss-ir.md)。`wxmlAst`/`wxssIr` 清单字段指向包含 `sha256:<digest>` 指针的这些块。来自应用/页面/组件配置的 `usingComponents` 条目将被输出为确定性关系记录。缺少可选的 `app.js` 会发出警告，而缺少或无效的 `app.json`、WXML 或 WXSS 则会报错。CommonJS 的 `require("./module")` 和 ESM 的 `import`/`export ... from` 引用将按词法扫描，并作为可选的 `modules[].dependencies` 数组输出，其中包含 `module:<path>` ID。相对路径、根路径相对路径以及生成的 `miniprogram_npm`/`node_modules` 路径将使用打包器使用的相同扩展名和 `index` 降级规则进行解析。无法解析到已生成模块的静态引用将产生 `ERR_UNDECLARED_MODULE_DEPENDENCY` 错误，并阻止打包操作；在依赖项提取之前生成的清单仍然有效，因为规范 JSON 中不会包含空的依赖项字段。

WXS 使用一个独立的、感知语法的依赖传递，其使用的 Acorn 版本与 `pnpm-lock.yaml` 中完全一致。它通过 ECMAScript 2020 解析脚本语法，不执行或重写输入字节。除法和正则表达式字面量由解析器区分；形如 require 的字符串、注释和正则表达式无法生成虚幻的模块边。转义的标识符和字符串字面量在解析直接 `require("./dependency.wxs")` 调用前会被解码。内联和外部源使用相同的传递过程。依赖项会被去重、排序，并限制为标准的、声明的相对 `.wxs` 文件。

动态/别名词法 `require`，加载器遮蔽以及动态代码形式（如 `eval`、`Function`、`with` 和导入）被明确拒绝。解析器的接受并不证明官方 WXS 语法方言。此阶段并非 JavaScript 容器或对抗任意反射的证明；原生视图在加载模块时仍会强制执行声明的依赖白名单。AppService 的模块阶段仍保持上述描述的独立词法分析器。
例如，工厂的 `arguments[2]` 可以在没有词法 `require` 引用的情况下获取加载器。图阶段不会发现该边；原生视图在未预先声明的情况下会拒绝加载。一个共享的 QuickJS/V8 回归测试会检查被拒绝和已声明的情况，包括词法箭头捕获。

承认的 WXS 语法与图形提取分开进行，同时与 WXML 表达式一起进行。可选的 `viewCompilation` 记录编译器 `weapp-container-wxs` 版本 `1.0.0` 和辅助 ABI `1.0`：

```ts
{
  compiler: "weapp-container-wxs", version: "1.0.0", abi: "1.0",
  modules: [{ id, sourceSha256, executableSha256, helper }],
  documents: [{ documentId, wxmlAst,
    expressions: [{ source, shorthand, executableSha256, helper }] }]
}
```

可执行的 blob 具有独立的 SHA-256 标识，编译器/ABI 元数据参与了清单完整性根和运行时重新加载身份。宿主必须复制、验证并预先加载整个闭包，包括模块源代码/可执行文件和 WXML 表达式可执行文件。缺失或损坏的字节无法实现成功初始化。

编译属性读取暴露了八个标准的字符串值 WXS 构造函数名称，而不会修改原生原型构造函数。一个干净的词法辅助程序保留了自身/继承的重写、getter、方法接收者和参数顺序、严格写入、复合/更新/删除操作以及 `for-in` 写入。原生数组方法保持其原生行为。未经编译的视图 API 源码保持 ECMAScript 语法；该包格式不会默默地重写该公共边界。

不支持的语法会返回 `ERR_UNSUPPORTED_WXS_SYNTAX` 并阻止发布包：词法 `eval`/`Function`、`with`、导入、可选操作、异步/生成器、标记模板、类、解构、展开/剩余和 `for-of`。验收是实现子集，不是对完整官方 WXS 语法的证明，也不是反射沙箱的证明。裸 `wx:key` 仅是字面属性元数据，因此像 `class` 或 `first-name` 这样的名称不会被解析为代码。`*this` 保留其项值含义；现有的点号循环作用域表达式扩展仍会被编译，并明确地与官方规范不一致。

运行 `pnpm runtime:wxs-graph:smoke` 以进行原始 fixture → 可移植包 → 本地的转换检查。该检查验证了未更改的 WXS 源代码块和渲染数据集。它不提供官方 DevTools 证据。
`pnpm runtime:wxs-dialect:smoke` 也验证了独立的源代码/可执行文件哈希，以及在两个本地引擎上实际的构造函数、数组方法、内联/外部 WXS 和 WXML 数据集结果。版本锁定的官方构造函数基准仍为 `unknown`；这些本地检查并未确立宿主/GPU/设备或性能验收。

Rust `container-ir` 库提供了匹配的 `parse_wxml`/`parse_wxss` 和 `decode_wxml`/`decode_wxss` 函数。这使得每个宿主可以在将树传递给 View/Renderer 之前验证 blob 格式，而无需在运行时重新解析源标记语言。

<a id="container-only-modern-view"></a>
## 仅容器的现代视图

传递 `--project <source-project>` 参数以启用 `container.config.json`：

```json
{
  "view": {
    "documents": {
      "pages/home/index.wxml": {
        "mode": "modern",
        "modules": { "fmt": "./view/format.view.ts" }
      }
    }
  }
}
```

文档键标识发出的 WXML 路径。条目标识项目相对路径下的 `.view.ts`/`.view.js` 文件。现代 WXML 直接调用这些命名空间，例如 `{{fmt.label(user?.name ?? 'guest')}}`，而无需 `<wxs>` 声明。旧版文档仍使用现有的 WXS 语法。导入/包含边不能跨越语言边界。

```bash
node tools/container-manifest/bin/container-pack.mjs ./app/dist \
  --out ./artifacts/modern --project ./app
```

固定的公共 Rolldown API 删除 TypeScript，并将静态 ESM、同步 CommonJS 和 JSON 依赖项合并为单个 ES2022 可执行文件，每个连接的 WXML 图谱一个。该图谱中的别名和导入模板共享 ESM 的实时绑定和循环。当所有链接依赖项满足相同策略时，支持同步 npm 包；其源身份包括包名和版本。类、解构、扩展、可选/空值操作、生成器和原生 ECMAScript 构造函数行为保持标准 ECMAScript，不进行 WXS 构造函数降级。

这些包明确使用 `schemaVersion: 2` 和 `modernView` 编译/ABI 元数据。可执行代码、带有原始 `sourcesContent` 的源映射、原始源码和配置字节是独立的基于内容的块，由完整性根覆盖。路径和哈希值在开发快照之间可重现。原始 `wv build` 输出保持不变。缺少配置将保持精确的 v1 包；现代视图是容器扩展，不会在官方微信开发者工具中使现代语法可运行。

视图执行是同步的。异步函数、`await`、承诺、动态导入、定时器、网络/存储/浏览器/Node/AppService 全局变量、原生插件以及 `.wxs` 依赖在打包发布前都会失败。在 WXML 表达式中加载模块也会被拒绝；请使用配置的别名。此静态策略并不能替代运行时隔离，也无法证明能抵御任意反射攻击。类型擦除不会执行类型检查；请单独运行项目的独立 TypeScript 检查作为额外防线。

开发工具在打包不可变源快照时，可以传递 `--resolve-root <original-project>` 以从该项目解析已安装的 npm 依赖项。`--config <path>` 选择一个相对于项目的配置文件；`--diagnostic-json <file>` 会将结构化的故障诊断信息（包括源 `path` 和解析器位置在 `details` 中）保存到文件中。无效输入永远不会发布快照。`buildManifest(input, {project, configFile, resolveRoot})` 通过库 API 提供相同的行为。

`--watch-dependencies-json <file>` 显式地写入一个开发侧边文件
`{schemaVersion:1,sources:[{path,sha256}]}`，包含已解析的绝对源路径，
包括链接的 npm 文件。此报告位于manifest/runtime ABI 之外；
发布可移植包时，不要包含此机器特定的监控报告。

<a id="capability-overrides"></a>
## 能力覆盖

传递一个紧凑的映射或矩阵 JSON 文件：

```json
{ "wx.request": "full", "wx.requestPayment": "unsupported" }
```

每个状态都是 `full`、`partial` 或 `unsupported` 之一。不支持的 API 必须由运行时以 `ERR_UNSUPPORTED_CAPABILITY` 的形式暴露出来；该打包器不会默默地创建宿主实现。

