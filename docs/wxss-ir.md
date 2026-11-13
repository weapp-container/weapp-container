<a id="wxss-ir-and-conditional-cascade"></a>
# WXSS IR 和条件级联

**简体中文** · [English](wxss-ir.en.md)


Weapp 容器以标准 UTF-8 JSON 块的形式存储 WXSS。`wxssIr` 引用其 SHA-256 内容地址；封装的清单模式仍保持版本 1。新的打包器和 Rust 解析器输出使用 WXSS IR 版本 2。Rust 解码和验证也支持旧版版本 1。

<a id="version-2-source-structure"></a>
## 版本 2 源代码结构

形状保持 `version`、`imports` 和 `rules`。版本 2 要求 `imports` 数组为空。每个导入在其原始源位置处是一个规则：

```json
{
  "version": 2,
  "imports": [],
  "rules": [{
    "selectors": [],
    "declarations": [],
    "nested": [],
    "atRule": "@import './theme.wxss' (min-width: 240px)"
  }]
}
```

嵌套组保留自己的规则列表；它们的导入操作永远不会被提升。
导入不能携带声明或嵌套的子元素。关键字匹配将 `@imported` 视为一个独立的未知 at-规则。非导入分号at-规则也会被保留。像 `@font-face` 这样的声明体保留描述符，而媒体、支持和关键帧体保留嵌套规则。在两个解析器中，引号字符串外的注释都会归一化为一个分隔空格。

共享的 [解析器固定测试用例](../tools/container-manifest/test/fixtures/wxss-v2.json)
检查有序/嵌套导入、仅导入组、描述符、关键帧和关键字边界，与两个实现的规范 JSON 进行对比。

<a id="runtime-evaluation"></a>
## 运行时评估

所选的 App/page/component 样式图定义了有序的根列表。
运行时会验证 blobs，解析本地引用或 `url(...)` 导入，并在选择器匹配前评估条件组。支持相对路径和包根路径。重复导入会在每个位置展开，并保持级联效果。条件分支为假时，不会遍历其子节点或加载其导入。新的渲染提交会重新评估其逻辑视口的条件。展开操作受限于 128 个导入/组层级、16,384 个样式表访问、32 MiB 的累积序列化 IR 以及 65,536 个规则/选择器/声明/导入。每次重复导入都会再次加载其源文件，包括未激活的主体；超出预算将返回 `ERR_RENDER`，在帧发布前终止。

支持的媒体查询使用 `all`/`screen`、宽度、高度、方向和长宽比特性。可移植子集包括最小/最大形式、数值范围比较、布尔组合和查询列表。宽度/高度长度支持 `px`、`rpx`、`rem`、`vw`、`vh` 以及无单位的零值；`rem` 使用 16 像素作为基准。方向特性将正方形视口视为纵向。查询使用三值 MQ4 逻辑：未知或无效特性在经过 `not` 操作后仍保持未知，并在查询边界处变为不匹配；其他有效的查询列表成员仍可能匹配。无效的视口尺寸和资源限制违规将返回 `ERR_RENDER`。

只有顶层的导入在运行时可执行。活跃的延迟或嵌套导入会返回 `ERR_UNSUPPORTED_CAPABILITY`，因为官方的放置语义尚未确立。活跃的 `@supports`、导入层/支持限定符和其他不支持的 at-规则也会明确失败。字体面和关键帧元数据在解析后仍存在，但被排除在普通级联之外；字体加载和动画执行由此路径未实现。无上下文的 IR 级联会跳过所有未解析的 at-规则子树，从而防止错误的媒体分支或动画选择器泄露到元素样式中。

导入循环、缺失资源、远程/逃逸路径和错误的导入语法会返回 `ERR_RENDER`，在帧发布之前。渲染失败将保留前一已提交的帧。本地 `.wxss` 和 `.css` 样式资源 ID 可被接受，与打包器的样式输入相匹配。无关的样式记录不会仅仅因为共享了清单文件而进入选定的样式层级。

<a id="legacy-and-remaining-boundaries"></a>
## 传统和剩余的边界

版本 1 在一个单独的列表中记录导入项。其解码器保留该版本以及这些字节的含义：导入项在宿主的本地规则之前被展开。该格式丢失了原始的导入位置和包含条件，因此无论是解析器还是运行时都无法重建这些信息。使用 v2 重新打包源代码以保留这些数据；旧的证据和内容哈希保持不变。

源解析器将仅声明和规则列表体分开。不支持混合体，例如将 `@page` 描述符与嵌套的 margin at-规则结合使用。解析并保留未知构造本身并不表示其布局、字体、动画或其他宿主行为能够正常工作。本地标准/基准和运行时测试确立了这一有限的契约；官方 DevTools、GPU/设备一致性及性能验收需要各自提供证据。

<a id="reproduce-the-native-sample"></a>
## 重现原生示例

开发模拟器可以加载实际的 App/Page 示例：

```bash
cargo run -p container-simulator -- dev \
  --project examples/apps/style-conditions-app --surface web
```

为实现确定性的视口过渡，需构建两个原生引擎，并运行绑定源码的烟雾测试，使用与子模块版本锁定匹配且具有独立分发哈希回执的隔离编译检查点：

```bash
cargo build -p container-simulator --features v8-native --locked
pnpm runtime:wxss:smoke \
  --simulator-bin target/debug/weapp-simulator \
  --compiler-root /path/to/pinned/compiler \
  --compiler-dist-hashes /path/to/compiler-dist-sha256.json \
  --out /path/to/wxss-report.json
```

使用每个运行的全新输出路径；烟测试保留了先前的证据。

fixture 的实际 tap 事件处理器通过 `wx.createSelectorQuery` 更新页面数据和查询几何信息。窄、宽、正方形和更窄的帧必须在改变几何形状和 RGBA 像素时保持生命周期和计数器。报告会检查引擎结果，并保留轨迹、快照、编译来源以及内容寻址的包字节。它使用原生软件渲染；不涉及 GPU 或官方微信验收。条件解析保留在现有的批处理 `render.commit` 边界内，且不增加节点级别的 JS/Rust 调用。该通道记录正确性，不声称有任何性能分析或加速预算。
