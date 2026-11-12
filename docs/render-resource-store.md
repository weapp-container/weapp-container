<a id="session-render-resources"></a>
# 会话渲染资源

**简体中文** · [English](render-resource-store.en.md)


宿主可以使用 `app.init` 一次性预加载基于内容的渲染字节，并在后续的清单帧中复用这些字节。这避免了每次显示时都序列化可移植包。资源存储属于单个运行时 `Session`；它是一个不可变的 Rust `Arc<BTreeMap<String, Vec<u8>>>`。选择它会克隆句柄，而不会克隆资源字节缓冲区，也不会再次穿过宿主桥接。

```json
{
  "op": "app.init",
  "payload": {
    "modules": [],
    "blobs": {"sha256:<digest>": [123, 125]}
  }
}
```

简短示例展示了信封的 `op` 和 `payload`；实际请求还包含通常的协议版本、会话 ID、请求 ID 和类型。每个 blob 键必须与其字节的 SHA-256 值匹配。在这些字节进入存储之前，也会运行正常的 View-资源验证。`modules` 使用现有的 AppService 模块合同，并且与渲染存储无关。

```json
{
  "op": "render.commit",
  "payload": {
    "templateId": "template:pages/index/index.wxml",
    "frameId": 2,
    "viewport": {"width": 390, "height": 844},
    "useSessionResources": true
  }
}
```

省略 `data` 会使得当前运行时页面数据失效。重用标志只改变渲染字节的来源；模板、样式、View-脚本、组件、布局和渲染器检查仍然生效。现有的嵌套形式 `{"frame":{"templateId":"…","useSessionResources":true}}` 也有效。该标志必须出现在与 `templateId` 或 `template_id` 相同的对象中。

选择规则是明确的：

| 请求 | 结果 |
| --- | --- |
| 标志被省略或为 `false`，有效的 `blobs` | 现有显式字节渲染；一次成功的提交会安装其存储。 |
| 标志被省略或为 `false`，没有 `blobs` | `ERR_RENDER`，即使之前存在存储。 |
| 标志 `true`，已验证存储非空 | 使用该会话的存储进行渲染。 |
| 标志 `true`，任何 `blobs` 属性 | `ERR_INVALID_REQUEST`，包括 `blobs: null` 或 `{}`。 |
| 包含非布尔值的标志 | `ERR_INVALID_REQUEST`。 |
| 标志为 `true`、空、未验证或已失效的存储 | `ERR_RENDER`。 |
| 标志 `true`，原始帧且无清单模板 | `ERR_INVALID_REQUEST`。 |

标志和资源检查在组件钩子和帧发布之前进行。
提供无效的哈希值或不完整的显式候选值将无法回退到前面的字节。上一版发布的帧和已验收的存储仍可获取。显式候选字节只有在渲染器验收其生成的帧后才会替换存储。与其他渲染提交一样，发布后在钩子中出现的错误将单独报告为 `committed: true`；已验收的帧及其资源存储仍保持安装状态。

`replace_manifest` 保留前一帧，但当清单元数据变更时会取消资源复用。显式字节的渲染成功必须重新验证并为替换清单安装资源。使用相同值替换清单可保留授权。替换失败不会改变授权。会话销毁在内部渲染句柄全部消失时释放其存储；新会话不会继承授权。

开发预览使用候选会话的资源存储，从不借用实时会话的授权。其首次渲染通常提供显式字节。一次成功的预览可以在后续预览渲染中重用自己已验收的存储，而无需更改实时存储或帧。

`session_render_resources` 集成测试在启用原生 QuickJS 和 V8 时验证公共桥接：预加载的第一帧、真实的 Page.setData、显式初始化、钩子之前无效的选择、失败的候选、会话隔离、清单替换和开发预览隔离。内部测试还拒绝未经验证的非空映射，并断言选择存储时保留 `Arc` 身份。这些是运行时合同检查；它们不建立官方 DevTools 一致性、GPU 行为、设备行为或性能预算。
