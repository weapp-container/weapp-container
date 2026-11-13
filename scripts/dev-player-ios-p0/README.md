<a id="ios-p0-runner"></a>
# iOS P0 运行器

**简体中文** · [English](README.en.md)


这是一个新的 XCTest 运行时，用于 `examples/apps/player-correctness-app`。
它不修改或重用旧的形态测试二进制文件/证据。
准备或描述运行器的过程不会编译、启动、安装、配对或启动服务器。
这些源文件不声称任何设备权限。

```sh
python3 scripts/dev-player-ios-p0/run.py describe
python3 scripts/dev-player-ios-p0/run.py prepare \
  --out artifacts/dev-player/p0-preview5/ios/harness
```

资源所有者随后明确地构建测试框架。这仅构建独立的 UIKit 测试宿主，其中没有链接运行时：

```sh
python3 scripts/dev-player-ios-p0/run.py build \
  --project artifacts/dev-player/p0-preview5/ios/harness \
  --out artifacts/dev-player/p0-preview5/ios/harness-build
```

将 `config.example.json` 复制到新的证据目录中，并替换所有占位符。为每个任务拥有的 SE、Pro Max 和 iPad 模拟器设备绑定已配对的 Player 设备 ID，绑定仪表盘回环 URL，以及新 Player 可执行文件、运行时锁和源绑定清单的 SHA-256 值。运行器会将已安装的可执行文件与该精确绑定进行比对。缺少或过时的构件将导致执行中止。历史预览。3/4 版本的二进制文件仍为历史版本。同时绑定现有的源绑定 Player 的 `build.json` 为 `playerBuildReceipt`，以及本运行包构建的 `harness-build.json` 为 `harnessBuildReceipt`。Player 构建验证器会检查当前已审核的源代码和完整的准备好的 `.app` 仓库清单。已安装的 `.app` 必须与每个文件完全匹配，包括 Flutter `App.framework/App` 和原生库；仅匹配 `Runner` 是不够的。默认情况下，每个成员、字节哈希、大小、链接身份和可执行标志都必须匹配。没有安装程序生成的文件会被隐式忽略。运行包构建回执会绑定复制的源代码准备、成功的构建命令、生成的 plist 以及完整的实际运行器/测试产品哈希。过时的测试二进制文件无法通过复制其 plist 来重新绑定到当前源代码。准备过程还会归档并哈希 `run.py`、`installer_policy.py`、策略 JSON、屏幕输入几何辅助工具及其仅限宿主的 Swift/Python 检查。因此，对导入的验证器或其测试的任何更改都需要新的准备和运行包构建，就像对 Swift 测试的更改一样。这些副本是源代码证据；请使用标准仓库运行器来执行它们。旧的准备和构建保持历史状态。

<a id="explicit-simulator-installer-metadata-policy"></a>
## 显式模拟器安装程序元数据策略

独立保存的 Xcode 27.1 / iOS 27.0 模拟器观察结果有 76 个已准备并安装的成员，无新增成员，无缺失成员，无字节变化。恰好是这六个常规文件丢失了可执行标志：

- `Frameworks/App.framework/App`
- `Frameworks/Flutter.framework/Flutter`
- `Frameworks/flutter_secure_storage.framework/flutter_secure_storage`
- `Frameworks/objective_c.framework/objective_c`
- `Runner.debug.dylib`
- `__preview.dylib`

仅针对此已审核的安装程序行为，通过在顶层添加以下字段以及在现有 `bindings` 数组中增加三个条目来启用该选项。保留所有五个正常的 app/runtime/source/build 绑定。默认示例故意省略了启用选项，保持严格性。

```json
{
  "installerMetadataPolicy": "ios27-simctl-executable-bit-removal-observed-se-v1",
  "bindings": [
    {
      "role": "installerPolicy",
      "path": "/absolute/repository/scripts/dev-player-ios-p0/installer-policy-ios27-simctl-v1.json",
      "sha256": "9d617e94451d8cff9fe70c6cc02926fdb39152133fbf9df186043707fc6c8eb9"
    },
    {
      "role": "installerObservation",
      "path": "/absolute/preserved/installed-inventory-diff.json",
      "sha256": "e3e9669f52be9c3fed551b111ac1aa48c4c1b9d16899131515b525767f1392ea"
    },
    {
      "role": "installerOriginalFailure",
      "path": "/absolute/preserved/pair-preflight-failure.json",
      "sha256": "5864b016c9251bf3b07e12a8000d8e451e630fd1bf2872c0c2f6a8195d4ac3c3"
    }
  ]
}
```

保留的原始输入位于
`artifacts/dev-player/p0-preview5/ios/execution-source832e99d5/iphone-se/`。
保持或传递这些精确的字节及其历史证据。缺失、重建或更改的证据即使其新哈希值被放入配置文件，也将被拒绝；已审核的证据哈希值将被钉在标准验证器中。原始的严格失败在配对或产品测试之前仍视为失败。外部忽略的叠加层无法激活标准策略。

该启用选项仅允许在以下六条路径上进行 `executable: true → false` 的变更，其他属性（包括常规文件类型、字节、大小以及所有其他元数据）保持不变。当前安装的应用程序可能只体现部分这些变更。主应用程序可执行文件保持完全严格，每个成员和链接也是如此。此策略没有应用版本例外：每个新 Player 必须首先通过与原始生产者构建版本一致的构建验证器，针对其自身的实际构建回执进行验证。它永远不会将原始生产者回执重新绑定到新的源版本上。

`installed-payload.json` 保留了完整的原始准备和安装清单及其唯一哈希值、当前生产者回执绑定、所选策略/证明/实现哈希值以及每项实际转换。资源所有权回执还绑定完整的审核通过的测试框架源代码清单和标准运行器/辅助程序哈希值。此处不会对应用、已安装文件、清单或生产者回执进行任何标准化或重写。验收这里仅指消费者安装程序元数据；它不通过 C013、生命周期、C012、C018 或任何产品/平台门禁。

纯回归测试不会启动 Node 构建、模拟器、设备、服务或配对。合成证明哈希值仅作用于其固定测试数据，无法替代生产环境的密钥：

```sh
python3 -B scripts/dev-player-ios-p0/test_installer_policy.py -v
python3 -B scripts/dev-player-ios-p0/test_run.py -v
python3 -B scripts/dev-player-ios-p0/test_input_probe.py -v
```

最后一个命令仅使用宿主 `swiftc` 编译 Foundation/CoreGraphics 几何辅助组件，然后运行数值拒绝/坐标检查。它不会构建 Player 或 XCTest 代理，不会启动应用，也不会连接设备。

<a id="owned-device-execution"></a>
## 所有设备的执行

分别运行每个配置文件，针对新构建的 `.xctestrun`：

```sh
python3 scripts/dev-player-ios-p0/run.py run \
  --config artifacts/dev-player/p0-preview5/ios/config.json \
  --profile iphone-se --stage C013 \
  --xctestrun artifacts/dev-player/p0-preview5/ios/harness-build/derived/Build/Products/SDKConsumer_iphonesimulator27.1-arm64-x86_64.xctestrun \
  --out artifacts/dev-player/p0-preview5/ios/iphone-se/C013-run1
```

所选的模拟器必须已经启动，并且已安装新的 Player，连接，并显示正确性固定件的主页。运行器不会根据设备型号、列表位置或“仅连接设备”来选择设备。它为显式 UDID 使用一个独占租约。输出将拒绝覆盖。每次运行都会保留调用信息、时间戳、日志哈希、精确的源/应用/运行时绑定、`.xcresult`、附件以及测试结果摘要。即使可以导出附件，退出失败仍被视为失败。
对冻结的配置文件定义和 iOS 27.0 运行时与实际 UDID 进行比对。只有当导出的摘要记录了该 UDID 上恰好一个通过的测试、零跳过、零预期或实际失败时，该阶段才被视为通过。最终的 `stage-result.json` 会保留拒绝或失败状态，即使 `xcodebuild` 本身退出码为 0。

| 阶段 | 检查项 |
| --- | --- |
| `C013` | 十个横向→纵向→横向循环，每个循环包含所有新追加的 `onResize` 回调几何体，正常和自定义导航，返回操作，当前布局身份，首次 `onLoad` 几何体，基于真实选择器的触摸操作，以及原生 ACK/输入资格。包身份保持固定。 |
| `lifecycle` | 保存持久化数据，工具往返操作，关闭/重新打开，新会话，首次几何体和实际恢复的原生帧。 |
| `C012` | 红色 WXS 故障按钮，持续执行健康状态，输入已禁用，继续运行 250 毫秒 AppService 定时器，工具恢复，重试创建一个新接受的会话。 |
| `C018-baseline` | 在外部协调的失败候选发生之前，捕获不可变的已验收包身份。 |
| `C018-rejected` | 需要固定的基线身份，然后证明保留了旧的所有者/布局、原生回执、有效输入和定时器。 |

运行 C013 和生命周期之前必须运行 C012。C013 会为所有十次循环保留完整的日志；每次运行都需使用新的会话。普通点击操作会将 fixture 的 `.p0-control` 选择器矩形与当前原生视图和逻辑视口进行匹配。不使用历史像素偏移或远程客体突变命令。UIKit/XCTest 的逻辑屏幕边界必须独立匹配已提交的内容矩形和视口，只有在此前提下才能使用直接的选择器偏移；无法通过自适应的客体/原生缩放因子来隐藏错误的尺寸。每次旋转和导航都需要增加观察/布局修订次数。在断言每次旋转之前，必须附加其完整的前后回调日志。每个新的 `onResize` 参数必须与同步窗口查询结果匹配；窗口/显示/安全区域/方向和胶囊必须共同匹配完整的原生布局，且至少有一个回调要匹配新呈现的布局。缺少自身原生回执的中间元组将保守失败并保留所有样本；正确的最后帧不能隐藏更早的混合元组。

对于 C012 的输入阻断探测，测试程序在触发故障前固定 increment 选择器的屏幕坐标。附件记录独立 AX 表面/应用边框、已接受内容边框、逻辑屏幕坐标、应用偏移、方向及原生 pack/session/layout 身份。预期故障后，原生视图可能不再出现在 AX 中，因此探测使用稳定的 `XCUIApplication` 锚点，核对应用边框、方向及原生身份不变，不再解析隐藏表面。在实际屏幕点击前附上故障快照、截图与 AX 树。点击后，View 的粘性健康故障和禁用输入状态必须保持，AppService tick 必须推进，而计数和完整的 `increment.*` 日志必须不变。这证明可见故障状态阻断业务输入，不宣称隐藏原生表面本身接收到手势。只有上述断言通过后才能开始 Recovery/Retry。旧的元素锚定探测仍是失败的历史运行，不能因准备了新测试程序而改标为通过。

`snapshot.state` 和虚拟机轨迹来自同一份只读检查，因此仅靠截图无法通过几何/身份验证。

C018 是故意在宿主控制的源编辑处进行分割。在基线之后，资源拥有者会替换
`scripts/fixtures/player-correctness-startup-failure/app.js`，等待真实的候选者拒绝，保存构建/播放器错误证据，然后使用 `c018ExpectedAccepted` 从基线复制，`c018ExpectedCandidate` 从实际候选者描述符（根、生成版本、运行 ID）复制来运行被拒绝的阶段。测试框架会直接从 `inspection.snapshot.developmentAttempt` 读取实际的原生回执；它不接受手动构造的回执文件。它需要匹配的被拒绝的拥有者/尝试、候选者根/生成版本/运行 ID、稳定的 `ERR_*` 代码和原始的 `P0_CANDIDATE_STARTUP_FAILURE` 消息，而 `acceptedPack` 和原生状态仍能识别原始包。该快照会导出到 XCTest 附件中。未知或待处理的观察结果无法作为拒绝通过。

源码必须单独恢复，并单独检查下一个被接受的版本。仅拒绝 UI 阶段本身并不能证明候选者失败或对尝试进行分类：没有关联的失败证据，C018 仍不完整。丢失的原生回复/回执驱逐需要单独的原生和 Player 协调测试；该运行器不会通过 UI 模拟这些操作。

凭据只保留在进程内存中。运行时不会配对、撤销、关闭模拟器、停止服务、关闭用户应用或终止其他任务。它仅会移除自身的租约。原始资源所有者仍需明确负责应用/连接/服务/模拟器的清理工作，并单独记录这些信息。仅仅添加此工具包，并未创建任何当前任务的资源。设备执行会等待当前已审核的应用，匹配最新版本的工具包和服务。
