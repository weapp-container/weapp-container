<a id="renderer-profiles-and-layout-independent-view-documents"></a>
# 渲染器配置文件和与布局无关的视图文档

**简体中文** · [English](renderer-profiles.en.md)


渲染器选择与 JavaScript 引擎以及传统 WXS 与现代 View 语言配置Profile无关。支持的配置名称为 `skia`、`webview` 和 `skyline-compat`。`skyline-compat` 表示容器的兼容路径；它并不声明已包含官方 Skyline 实现，或其符合性门控已通过。

打包工具将输出的 app/page JSON 中的 `renderer: "webview"` 映射为 `webview`，将 `renderer: "skyline"` 映射为 `skyline-compat`。缺少声明的保持容器原有的 `skia` 默认值。源 JSON 和所有 `wv` 输出字节保持不变。源项目可 在 `container.config.json` 中覆盖选择：

```json
{
  "renderer": {
    "default": "skia",
    "pages": {
      "pages/home/index": "webview"
    }
  }
}
```

键值是路由路径，不包含 `.wxml` 或 `.json` 扩展名。优先级配置为：页面、源页面、配置默认值、源应用，然后是 `skia`。未知的路由、配置文件名、源渲染器值以及配置字段在打包时会报错 `ERR_RENDERER_CONFIG`。配置文件即使没有配置现代 View 模块，也会参与开发模式下的文件监控依赖。

任何显式选择都会发出 schema v3，包含 `rendering.version: "1.0"`、`default` 以及解析后的 `pages` 映射。schema v3 也可以包含 `modernView`。未配置的旧版包仍保留其原有的 v1/v2 表示形式。完整性根节点涵盖呈现器选择，更改它需要会话重启。较旧的运行时会拒绝 v3；当前宿主在初始化页面前必须协商呈现器配置版本和所需配置文件。v3 schema 位于 `schemas/container-manifest-v3.schema.json`。

`container-ir::ViewDocument` 描述了布局前评估的内容。它保留了稳定的出现 ID、组件/事件/插槽的所有权、类型属性、事件捕获/拦截策略、有序的 WXSS 根节点和原始规则 IR，以及基于内容的资源引用。`typedAttrs` 条目优先于旧的 `attrs` 字符串投影；二者均不是再次求值表达式的指令。几何字段被文档 wire type 拒绝。一个样式表源可以通过重复其源 ID 并使用不同的 `scopeId` 值应用到多个组件实例上；所有作用域副本必须保持相同的 IR。`slotOwner` 是可选的：生产者在已知时必须保留声明的所有权，且不得从物理渲染祖先关系中推断所有权。

运行时投影消耗已评估的组件图。解析后的组件文档和监听器声明文档与词法导入/包含来源分开保存，包括其透明宿主被移除的组件。组件样式表导入继承来源实例作用域。原始条件导入被保留；未声明的非活动引用不会被生成为加载的样式表。已声明的二进制数据会被验证。该文档不保证浏览器样式隔离，也不保证所有条件导入均被执行。源样式表目前在每个实例作用域下重复，且受显式计数/字节限制；未来的渲染器可以独立于作用域应用，对源IR进行内联。

Skia 和 Skyline 兼容性配置文件将 Rust 作为布局权威。WebView 使用浏览器。仅凭 ViewDocument 无法证明成功的呈现或浏览器/图形处理器（GPU）能力：这些需要匹配的呈现器回执以及独立的运行时合规性证据。任何后端在缺少所需 WebView 配置文件时均不得静默地替换 Skia。
