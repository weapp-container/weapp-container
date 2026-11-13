<a id="managed-build-inputs-for-browser-development"></a>
# 浏览器开发态的受管构建输入

**简体中文** · [English](browser-source-preparation.en.md)


> 本页记录底层阶段合同；这些 API 本身不启用开发 CLI。当前显式 Browser CLI 复用的完整 runner、启动参数及关闭限制见 [Browser 开发循环](browser-dev-loop.md)。


`DevConfig.managed_browser_sources = true` 将固定编译器 watch、原始产物快照和 portable
打包接到现有 `BrowserWorker` 监督器。它需要显式提供 `browser_runtime` 的独立 producer
及哈希，使用 QuickJS 和固定 submodule `0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e`。
默认开发模式继续使用原有链路。

```sh
cargo run -p container-simulator --example prepare_browser_runtime -- \
  examples/apps/reference-app /absolute/completed-worker-producer \
  /absolute/independent-pins.json --owned-sources
```

pin 文件的格式见 [runtime 输入](browser-dev-artifacts.md)。示例先接收静态 runtime 回执，
再等待 `PortableReady`，检查当时的发布有效性，最后在同一监督器上重试退出清理。
这一入口不启动 HTTP、Worker 或浏览器；`runtimeReady`、`presentedReady` 仍为 false。
`--web-runtime browser` 仍需后续完整执行链路验收。这里也没有 stage、激活站点或
GPU／性能通过结论。

<a id="data-and-resource-ownership"></a>
## 数据和资源归属

监督器在完整构造后才启动自己的 watcher。源协议 `2.0` 使用单一原子替换的
`status.json`，序号是十进制字符串，避免 JS Number 丢失精度。源状态分为 building、
success、error、blocked；只有实际成功 END、已签发的 grant、匹配的 writer-done
回执、compiler pin 和实际目录清单全部验证后，才能取得不可变原始输入。

grant 先于复制准入。同步复制完成并关闭句柄后才能确认 writer done；关闭结果不确定时
结束同一个 watcher，由 Rust 持有的实际进程树屏障解除写入权。未使用 grant 可通过
原子重命名撤销。缺失、损坏或错误 run 的 ACK 不能授权提前删除；实际 watcher barrier
成功后则不再依赖损坏 ACK 完成清理。

容量恢复在同一 compiler context／watcher 上重试受 END 和构建状态约束的发布，
不会因取得新 grant 而另建上下文。固定编译器的公开 `closeAll()` 会吞掉内部关闭失败，
这里只将其用于尽力关闭；它不构成写者退出证据。初次 context、npm 或 build 调用抛错
时，此受管模式终止进程，需重新启动监督器；正常 watch 构建报错后可在原 watcher 上
继续编辑恢复。终态失败会退出自有 Node wrapper，子进程仍由 Rust 的原进程树 owner
确认退出后才可删除输入。默认开发模式的重试行为保持原样。

打包器持有原始输入的真实 borrower，直到实际子进程退出及独立 portable 校验完成。
超时、创建失败和校验失败都保留原 owner 供清理。成功输出沿用同一 namespace 与费用，
通过 `.staging → pack` 发布。新的构建错误使发布 token 失效，先前有效 pack 继续保留。
清理会遍历全部依赖项，不能因原始输入还被打包器借用而跳过那个打包器。

watcher、portable 和 runtime 使用同一个账本。以下数字是逻辑准入策略，不能当作
实际 RSS、Node heap、磁盘硬 quota 或性能测量：

| 保留项 | 最大数量 | 每项内存策略 | 每项磁盘策略 |
| --- | ---: | ---: | ---: |
| root／producer／tools | 1 | 512 MiB | 512 MiB |
| runtime | 1 | 1024 MiB | 512 MiB |
| 原始 | 2 | 32 MiB | 256 MiB + 64 KiB |
| 可携式 | 2 | 256 MiB | 512 MiB + 64 KiB |

显式 source profile 上限为内存／磁盘各 3 GiB、81,984 文件、10,286 目录、6 namespace
和 1 个有限 artifact 作业；默认 retain-only 上限保持不变。编译器自身的可变输出仍在
独立 preparation owner 下，不能因本表而声称它具有硬 quota。常驻 watcher 的实际
进程树归属单独管理，不冒充有限打包作业的串行 permit。

当前 source profile 显式拒绝自定义 `wv`、未知 compiler 和任何 `container.config.json`，
包括现代 View sidecar；它尚未准入其源码／依赖闭包。编译器 Git pin 是版本来源，
不是对本机未跟踪构建文件真实性的证明。watch／packer 的实际源码应随执行证据绑定；
这一阶段也不声称完成了浏览器站点全部输入的冻结。

<a id="next-stage-execution-gatekeeping"></a>
## 后续执行门禁

下一阶段需让 consuming stage 实际持有 portable、runtime、工具和 parent 输入，并
为临时副本与旧站点的峰值另行准入，再接严格 HTTP、真实 Worker、输入、热更新和
失败恢复。必须在真实浏览器完成这些路径后才能开放独立 browser 开发模式。
七宿主和官方 near-parity 门禁继续分别记录。
