# 七宿主双渲染 goal 与冻结验收清单

目标是在 Web、macOS、Windows、Linux、Android、iOS、鸿蒙上提供 `skia` 与 `webview` 两种页面渲染器，复用同一 AppService、页面状态和批量 bridge。`skyline-compat` 是 Skia 的兼容 profile，不是第三种 backend。Web 分别验收 `--web-runtime remote` 与 `--web-runtime browser`；其他宿主的运行模式为 `native`。

计划阶段只进行了安装产物和源码审计，并未证明新的渲染器、GPU、设备或性能门禁通过。此目录开始冻结执行阶段的范围。goal 保持 active，只有全部必需门禁具备相匹配的实测证据，才允许标记完成；实现代码、接口编译、已有旧版本截图和检查器单测均不能代替该验收。

## 冻结基线

- 主仓提交：`c7d0dc6f595cd2d2c0ae2f7cd781c56a6cc6dab9`。
- weapp-vite：`0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e`。
- 官方语义 oracle：微信开发者工具 `2.02.2608080`、基础库 `3.17.3`。
- `baseline-v1.json` 从上述 Git 对象读取，保存现有 API/conformance inventory、172 个 IDE case 的 ID、状态与来源、33 个已有官方通过项、100 个现有运行时 API 合约，以及 282 个测试、脚本、工作流、Rust 测试入口/清单的路径和 SHA-256。并行工作区修改不会改变这份基线。
- 每个必需 gate 的定义由检查器独立生成；`gates-v1.json` 共 279 项，初始状态全部为 `unknown`。不能通过删行、改检查项、改变证据种类或减少 case 数量缩小目标。

官方回归要求上述 33 个已通过项继续通过；其余 IDE case 保留原状态与来源，完整 172 项 near-parity 通过要求继续由独立门禁管理。每个宿主/渲染器的 conformance 要求冻结的 100 个现有 API 合约，partial/unsupported 按冻结 inventory 的已文档化边界与错误契约验收；现有 WXML/WXSS、WXS/现代 View 等源码回归入口也必须保留并执行。新增双渲染、组件、硬件与性能检查独立列在必需 gate 中，不能用辅助测试冒充官方通过。

所有宿主/渲染器/Web 模式要求 QuickJS 实际执行。V8 保留已有可运行边界：Web remote、macOS native、iOS native；这些组合对新渲染器仍须重新验证。iOS 已有 V8 记录使用匹配的本地 archive，不能推导全新机器可复现分发已经完成。其他 V8 组合必须具备显式 engine availability 测试；不可用时返回 `ERR_ENGINE`，禁止静默切换 QuickJS。availability 测试通过只证明错误边界，不代表 V8 运行通过。未来增加 V8 支持必须新增运行、组件和性能门禁，不能删除现有要求。

## 实施阶段与完成条件

1. 统一 frame/resource 准备、按需快照、GPU/DOM 呈现及页面 renderer 选择，移除普通呈现的重复 CPU raster/readback。
2. Web remote/browser 接入本地 CanvasKit 或 DOM 渲染；开发模拟器继续共用一个语义 session，按批次分发场景和资源。
3. macOS/iOS Metal、Android/鸿蒙 GLES 接入新呈现生命周期；Windows/Linux 补充实际宿主后端。Skia GPU 请求不可静默使用软件路径。
4. 两种渲染器接入实际宿主组件：input/textarea 的编辑、中文 IME、选择区、焦点、键盘、事件和基础无障碍；video 的播放暂停、seek、静音、循环、全屏、事件和释放；camera 的权限、预览、拍照、录像、前后台恢复及无设备错误；map 使用 MapLibre 和可配置本地离线样式/数据，覆盖手势、标记、折线、多边形、事件及显式 GCJ/WGS 坐标转换。
5. 核对组件尺寸、裁剪、变换、层级、遮挡、触摸和销毁；执行冻结 conformance、实际设备/窗口交互和性能回归，再完成可复现交付。

七宿主各自验收，不能把七个 Rust crate 的构建成功算作七个平台运行成功。缺少真实 Windows/Linux 窗口、浏览器运行、移动设备或 GPU 证据时，相应项目保留 `unknown` 或在实际尝试后记录 `blocked`。软件渲染模拟器仅作为辅助验证；移动端 surface/performance 的完成证据要求物理设备。既有 near-parity 总门禁继续独立执行，本 goal 的完成不替代完整微信行为近等价声明。

## 证据与性能规则

每个 gate 只使用 `passed`、`failed`、`blocked`、`unknown`。非通过项必须说明原因。通过项指向一个 SHA-256 绑定的 JSON receipt；receipt 记录 gate ID、精确源码 commit、编译器及冻结基线、host/runtime/renderer/engine、实际环境、逐项检查结果和非空原始证据文件的哈希。通过的 receipt 必须绑定实际测试的源码 commit；旧失败尝试可以保留，但不能贡献通过状态。`blocked` 执行、错误 engine 或哈希不一致均被拒绝。要求硬件 GPU 的 gate 拒绝软件 fallback；普通 pack 执行通过不能升级为硬件 GPU 通过。

### 源码与证据归档分离

测试后的证据提交会改变 HEAD。为避免把证据归档误认为生产源码变化，receipt 可以增加以下 `sourceBinding`，保留原始 `commit`，不填写尚未生成的未来提交 SHA：

```json
{
  "sourceBinding": {
    "version": "1.0",
    "inventory": {
      "path": "docs/evidence/<run>/source-inventory.json",
      "sha256": "<inventory 文件的 SHA-256>"
    },
    "pathListSha256": "<完整受保护路径列表的 SHA-256>",
    "gateDefinitionsSha256": "<冻结 gate 定义的 SHA-256>"
  }
}
```

inventory 必须由 `captureSourceInventory(testedCommit)` 从真实 Git tree 生成，并同时列入 receipt 的 `artifacts`。它默认保护所有受跟踪路径、Git mode 和 blob/gitlink OID，包括运行时、schema、锁文件、构建器、测试、CI、检查器自身与 submodule 指针；receipt 无法选择排除项。检查器会独立重建 inventory，而不是信任文件内自报的路径或哈希。

仅以下变化允许沿用原来的实测结果：

- `docs/evidence/` 内新增普通非可执行文件；已经归档的证据不能修改、删除或改为链接。
- 精确的三个说明文件内容变更：`docs/dual-renderer/README.md`、`docs/dual-renderer/implementation-status.md`、`docs/dual-renderer/browser-dev-loop.md`。文件删除、重命名和 mode 变化不在允许范围内。
- `gates-v1.json` 的 `status`、`reason`、`evidence` 变化；完整 descriptor、列表顺序、279 项数量和全部 checks 仍必须与检查器冻结定义完全一致。

被验收提交必须是实测提交的后代。检查器审查两者之间的每个 commit、merge 的每个 parent→child diff，并核对端点完整 inventory。生产变更后再 revert、旁支变更后合并，都不能借由最终字节相同沿用旧结果。源码、依赖、构建、测试、CI 或检查器的任何变化均需在新源码上重新运行；不能给旧截图或 receipt 重贴新 SHA。该规则也意味着引入本检查器的提交不会自动授予此前浏览器结果新的通过状态。

CLI 总是验证真实 expected commit 和当前 HEAD checkout/index，即使指定历史 `--expected-commit`、清单全为 unknown 或 receipt 没有新 binding。校验直接读取受跟踪文件字节、可执行位和 symlink target，并递归核对已初始化 gitlink checkout；不依赖可能被 `assume-unchanged`、`skip-worktree`、`core.fileMode` 或 submodule ignore 设置隐藏的 Git status。源码证明限制为 16 层 gitlink、200,000 个条目和 1 GiB 读取预算，超限明确失败。当前工作区 mode 证明要求 POSIX 文件系统；Windows 原生检查会明确返回无法证明，应在完整 POSIX checkout 执行证据审核。旧的正常 exact-commit receipt 不要求补写 binding；dirty checkout 同样不能通过。

Git blob 身份保持原始字节与 OID，不把归一化结果写回 inventory。checkout 默认必须与 blob 字节一致；唯一额外允许的物化是对应 immutable tree 的 `.gitattributes` 明确声明 `text eol=crlf`，且普通文件恰好为该 LF blob 的规范 CRLF 版本。混合换行、裸 CR、含 NUL 的转换、内容变化、`text=auto` 或仅由 `core.autocrlf` 造成的差异均不通过。属性解析使用 Git 的 `--source=<commit>`，支持受跟踪的层级规则与宏；全局／系统属性不参与，存在本地 `info/attributes` 时明确拒绝。Git `--all` 结果中存在 `filter`、`working-tree-encoding` 或 `ident` 时一律拒绝，包括显式禁用以及名称为 `unset`／`unspecified` 的 filter，避免布尔值与同名字符串的输出歧义。检查器不调用 content-aware `git status` 或任意 clean/smudge filter：完整 index／直接字节证明覆盖受跟踪文件，额外文件只通过 `ls-files --others --exclude-standard` 列举。该规则同样递归应用于固定的 submodule，不修改 vendor 文件以迎合校验。

`inspectChecklist()` 的默认纯结构模式供合成 schema 单测使用；实际 CLI 固定启用 `verifyCheckout: true`。以上检查仅证明源码与归档关系，不能证明原始日志、截图或人工断言的真实性，也不替代对应的真实浏览器、官方工具、GPU 或设备执行。

性能场景固定为 1000 节点、10000 个 setData 条目、1000 项滚动列表及 20 次混合网络请求，使用 release 构建并保存至少 20 个样本。Web 的 remote/browser 分别在 375×667、2× 下验证输入到呈现 p95 ≤ 50 ms。首帧 p50：Web/桌面 ≤ 500 ms、移动端 ≤ 900 ms；全部 p95 ≤ 1500 ms；setData p95 ≤ 8 ms；bridge p99：Web/桌面 ≤ 2 ms、移动端 ≤ 5 ms；实测输入 57–63 Hz 下滚动丢帧率 ≤ 1%；稳态内存桌面/Web ≤ 150 MiB、移动端 ≤ 120 MiB；QuickJS 增量 ≤ 8 MiB，V8 记录并满足对应平台预算。冷/热启动也必须记录。检查器校验数值和证据绑定，不执行测试，也不独立证明 receipt 的观察真实性；实测 harness 与人工证据复核仍然必要。

```sh
# 验证冻结清单和证据格式；成功仅表示清单有效。
node scripts/check-dual-renderer-gates.mjs --validate-only

# 完成门禁：任何 unknown/blocked/failed 或失效证据均非零退出。
node scripts/check-dual-renderer-gates.mjs --expected-commit <exact-40-character-commit>

# 检查器本身的回归；不运行浏览器、设备或官方 oracle。
node --test scripts/check-dual-renderer-gates.test.mjs scripts/check-dual-renderer-source-binding.test.mjs
```

默认 expected commit 为当前 HEAD。`--validate-only` 不修改状态、不填充通过项、不授予 releaseReady。报告文件和原始证据需要在实施完成后由对应 harness 产生并复核，不能以手写通过声明代替观测。当前清单的全部 `unknown` 明确表示尚未为本次新目标提交验收证据。
