# container-sdk

**简体中文** · [English](README.en.md)


Weapp 容器的原生嵌入边界。该 crates 拥有一个经过验证的可移植包、一个真实的 JavaScript 运行时、导航、异步 HTTP 以及可选的持久化存储。平台适配器拥有其 UI 绘制表面，并在一条固定线程上调用 SDK。`ContainerSession` 故意既不实现 Send 也不实现 Sync。

默认功能启用实际的 QuickJS。未请求引擎的构建会返回 `ERR_ENGINE`；它们从不运行仅元数据的引擎，也不会选择备用引擎。Skia CPU、GLES、Metal 和 V8 有明确的 Cargo 特性。通过查询 `capabilities` 可以区分编译支持与当前附加/渲染的 GPU 绘制表面。

```rust,no_run
use container_sdk::{ContainerConfig, ContainerSession};
use serde_json::json;

let mut session = ContainerSession::new(ContainerConfig::default())?;
session.command("registerHostMethod", json!({"name":"account.current"}))?;
session.command("load", json!({"packPath":"/app/portable-pack"}))?;
session.command("pump", json!({}))?;
let events = session.command("takeEvents", json!({}))?;
# Ok::<(), container_sdk::SdkError>(())
```

配置使用驼峰命名法：`engine`、`host`、`sessionId`、`storageKey`、`storageRoot`，`host` 包含现有的运行时宿主元数据，包括 `windowWidth`、`windowHeight` 以及可选的完整 `displayMetrics`。默认逻辑尺寸为 375 × 667；原生适配器在加载前必须用嵌入视图的实际尺寸替换这些值。省略 `storageKey` 和 `storageRoot` 会选择仅内存存储；提供两者则实现持久化。原生 SDK 包装器应提供应用/账户作用域的稳定键和应用私有目录。

内部命令合约由 C/JNI/Swift/Dart 绑定共享：

| 命令 | 负载 / 结果 |
| --- | --- |
| `load` | `{packPath, route?, options?}`; 初始化一个本地解压的目录 |
| `lifecycle` | `{event:"show"\|"hide"}` |
| `navigate` | `{route, query?, replace?}` |
| `back` | `{}`; 拒绝弹出最后一页 |
| `input` | `{events:[...]}`; 一个完整的运行时输入批次 |
| `resize` | `{width,height}` 逻辑像素单位 |
| `windowMetrics` | 包含 DPR 的现有扁平 `HostWindowMetrics` JSON；加载前也可接受 |
| `inspectPackChrome` | `{packPath,route?}`; 验证并解析静态 Chrome，无需客体执行 |
| `hostChrome` | 按照方案 1 测量胶囊/内容矩形和单调修订 |
| `setPreviewOccluded` | `{occluded}`；预览呈现/输入与应用前台状态无关 |
| `switchTab` | `{route}`; 调用运行时 `wx.switchTab` |
| `sendMessage` | `{message:JSON}` 传递给已注册的小程序监听器 |
| `registerHostMethod` | `{name}` 加载前；`wx.*` 保留 |
| `completeHostCall` | `{callId,result}` 或 `{callId,error:{code,message,retryable}}`；错误码是运行时 `ProviderErrorCode`  wire 值 |
| `pump` | `{nowNs?}`; 绝对 Unix 纳秒，默认系统时钟 |
| `state`, `capabilities` | 精简版版本化的 JSON，不含像素或页面数据 |
| `takeEvents` | 返回并消耗已排队的事件数组 |
| `flushStorage` | 返回 `{pending,ticket?}`；等待 `storageFlushed` 事件 |
| `close` | 返回 `{pending,ticket?}`；持续泵送直到 `closed` |

事件包括 `ready`、`navigation`（包含当前页面和页面栈）、`frame`（包含单调修订号）、`hostCall`、`hostCallCancelled`、`message`、`error`、`storageFlushed` 和 `closed`。应定期处理事件；如果消费者落后，有界事件队列将报告 `ERR_EVENT_OVERFLOW`。帧修订号与帧 ID 无关，相同 ID 的重绘和会话替换都会导致修订号变化。快照像素使用观察到的 DPR，而输入/布局保留逻辑像素。帧快照是所有权值，在会话关闭后仍保持有效。

`load` 在启动前验证了清单的模式/完整性以及每个声明的内容寻址 blob，包括现代 View/编译器闭包。它会启动一个私有候选实例，并在第一帧成功后才替换当前运行时。候选的 HTTP/业务请求、消息和存储变更保持私有；失败时会保留原始实例和帧不变。替换成功后将退役旧实例，并使候选存储成为权威存储；旧的卸载钩子无法覆盖它。远程 URL 加载和下载可执行更新功能不属于本 crate 范围。

恰好一个原生绘制表面可以附加。低级 SDK 在附加时拒绝加载/关闭操作。UI 包装器必须清空 GPU 工作， detach，执行加载/关闭，并附加存活或替换的运行时。加载失败时可以重新附加保留的旧实例。detach 操作不会卸载或重置 JS 状态。

宿主在隐藏状态下也必须持续泵送：HTTP、业务完成、超时和持久化屏障仍会结算。JavaScript 定时器、输入和重绘在隐藏时会暂停。业务延续仅在拥有线程泵送或完成调用时运行。`wx.request` 使用独立的 reqwest/rustls 执行器，支持 HTTP(S)、头信息、JSON/文本/ArrayBuffer、取消和截止时间，并限制同时请求为 64 个任务，传输队列为 128 条命令，请求体大小为 8 MiB。每个已接受的运行时拥有独立的客户端、连接池和执行器；启动失败时保留当前拥有者的连接池，同用户凭证刷新会保持该池不变。已取消的任务在其未来被合并前会保留容量。最多八个退出的网络拥有者可能等待终止；进一步的加载会施加背压。
响应
不得从 I/O 线程进入 JavaScript。上传/下载/套接字 API 显式不可用。系统/窗口元数据仅返回已知的宿主字段；未知设备、权限和账户值不会被伪造。

持久化使用稳定的键 OS 锁、一个合并最新快照槽位，以及最多 64 个屏障。写入操作以原子方式替换同一目录中的文件，并在完成屏障前将其同步。快照会将 `undefined` 与 JSON 的 `null` 分开保存。写入失败可通过泵事件观察到。异步关闭会保留存储和管理文件租约，直到请求任务、连接池和专用网络执行器实际退出后，才会释放键锁并发出 `closed` 事件。账户切换除了使用宿主的清理确认外，还会使用相同的内部 drain 屏障。延迟回调无法进入已退出的运行时。Typed Rust 的 `flush_storage()` 和 `close()` 方法是 CLI/最终原生清理的显式同步屏障；UI 流程应使用非阻塞命令。Drop 会取消 I/O 操作，在网络工作者的执行器退出前保留账户租约，并允许持久化工作者完成其最后已验收的快照，但不会阻塞 UI，也无法报告失败；因此，必须显式调用 close 才能观察到持久的终止。

退休错误仍保留 `type: "error"`，并保留其原始代码和消息。`capabilities.diagnostics.retirementErrorOrigin.schemaVersion: 1` 其中声明了其可加的所有权字段：

```json
{"type":"error","error":{"code":"ERR_ENGINE","message":"..."},"origin":{"schemaVersion":1,"phase":"retirement","operation":"unload","sessionId":"old-session","acceptedPackIdentity":{"root":"<sha256>","acceptedPackRevision":"1","sessionId":"old-session"}}}
```

`operation` 为 `unload`、`cancelNavigation` 或 `cancelHostCalls`。SDK 在销毁前会冻结该身份，因此在成功加载后 draining 一个错误，不能将旧的清理归因于新接受的会话，包括完全相同的 pack root 重启情况。宿主可以在验证完整版本的来源（包括匹配的会话 ID 以及与当前接受身份的区别）后，将此类错误标记为历史错误。它仍被视为可观察的清理失败，而非成功的销毁。缺失、格式错误、不支持或无法归因的来源必须保持宿主的普通容错错误行为；绝不能以 `ERR_ENGINE` 过滤或丢弃所有清理失败。运行时错误在退休之外不会获得退休来源。此诊断元数据或成功的包接受均不能证明 GPU 呈现。

运行 `cargo test -p container-sdk` 以测试真实的 QuickJS 包、交易、HTTP、持久化和多实例合约。这些测试不声明拥有原生 GPU 绘制表面或设备认证。


<a id="host-navigation-chrome"></a>
## 宿主导航chrome

Preview.4 暴露了附加的 `chrome.protocolVersion: "1.0"` 能力。
在启动 guest 代码之前使用 `inspectPackChrome`，然后在 `load` 之前提交测量的 `windowMetrics` 和 `hostChrome`。`sdk/contract/CONTRACT.md` 中的公共合约定义了坐标和声明。
`state.chrome` 和 chrome 事件携带了已解析的应用/页面配置、每页动态导航的标题/颜色、实际的页面栈以及系统 tabBar。宿主直接渲染这些观察结果，而不是重新解析应用 JSON。实际的胶囊几何形状支持 `wx.getMenuButtonBoundingClientRect`。

`setPreviewOccluded` 在保持运行时的前台生命周期、业务定时器和存储存活的同时，撤销输入/呈现。当预览重新出现时，一个新鲜的已接受帧和 GPU 呈现回执将恢复输入。
