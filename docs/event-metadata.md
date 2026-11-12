# Dataset 与事件 mark

WXML 的字符串 `attrs` 与绑定结果 `boundValues` 是两条不同的数据通道。
事件元数据优先读取已经求值的 `boundValues`，只有未绑定的属性才使用原始字符串。
同一个投影用于原生渲染树和组件事件树，`data-*` 进入 `dataset`，
`mark:*` / `mark-*` 进入 `mark`。键沿用既有的连字符转驼峰规则。

普通 JSON 的 number、boolean、string、array、object 和 null 逐值保留。
字面属性 `data-count="7"`、`data-enabled="false"`、`data-value="null"`
以及看似 JSON 的文本仍为字符串；不会通过 JSON.parse 猜测其类型。
混合文本绑定继续使用 WXML 已求值的字符串结果。

SelectorQuery 的 `fields({dataset:true, mark:true})`、IntersectionObserver 的
dataset、坐标事件的 `target.dataset` 和各传播阶段的 `currentTarget.dataset`
均读取已提交的树。事件 mark 按根到目标合并，较近节点覆盖同名键。
带 identifier 的触摸在 touchstart 捕获这条路由的元数据快照；后续 setData
和重新布局不会把该触摸重定向到新元数据。新触摸读取新提交的值。

`RenderNode.dataset` 和 `RenderNode.mark` 的 Rust 类型为
`BTreeMap<String, serde_json::Value>`。直接构造节点的 Rust 调用方需使用
JSON 值；旧 JSON frame 的字符串条目仍按字符串读取，省略字段仍为空 map。
新 frame 可以包含非字符串条目，因此旧版严格字符串消费者不能读取全部新输出。
这是一项有方向的输入兼容性，不是混用任意版本消费者的保证。
旧运行时对这种显式 frame 的反序列化错误会返回 `ERR_RENDER`；普通 JSON
转发器可能忽略这类元数据。CanvasKit 只绘制 frame，不负责验证 dataset 语义。

本次沿用 manifest schema 1、WXML IR 1 和 bridge 1.0，未增加 envelope 或操作。
现有 minor 协商与 API capabilities 不是事件字段的逐项功能门禁；不能据此声称
旧消费者支持这些值。调用方与消费方应固定为同一仓库版本。

现有 IR 把 missing / undefined 的结果规范化为 JSON null，尚不能证明其与
显式 null 在官方运行时中的 presence 行为相同。本次不引入哨兵或猜测省略规则。
对象身份、重复绑定之间的引用共享、大小写边缘规则和全部官方类型语义仍需固定
DevTools `2.02.2608080` / 基础库 `3.17.3` 的实际差分证据。

现有节点数和文本预算并不限制嵌套元数据 JSON 的字节数与深度；本次没有增加
独立的元数据配额，也不据此宣称大对象的内存或性能门槛已经通过。

局部验证通过真实 Page / Component 处理函数、selector 和触摸路由观察值，
并在 QuickJS、V8 中运行同一 fixture。这些验证约束容器内部的数据一致性；
API inventory 的事件和 selector 支持级别保持 `partial`，不提升宿主、GPU、
真机或官方 conformance 状态。

开发示例可直接启动：

```sh
pnpm simulator:dev -- --project examples/apps/dataset-values-app --viewport 320x480
```

双引擎回归使用已构建的模拟器和固定版本编译器：

```sh
pnpm runtime:dataset-values:smoke -- \
  --simulator-bin /absolute/path/weapp-simulator \
  --compiler-root /absolute/path/pinned-compiler \
  --compiler-dist-hashes /absolute/path/compiler-dist-sha256.json \
  --out artifacts/dataset-values.json
```

脚本检查编译器源文件与 submodule gitlink 一致，并校验先前生成的 dist 哈希清单。
它保存原始编译产物、独立重打包比对、HTTP/SSE、实际 JS 观察和完整 RGBA；
两个引擎完成收集和资源清理后才断言类型，失败报告也保留。
它复用既有批量桥接与开发监督器，不新增逐节点跨语言调用，也不修改编译分包或 chunk。
