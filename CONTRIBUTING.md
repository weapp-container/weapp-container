<a id="contributing"></a>
# 参与贡献

**简体中文** · [English](CONTRIBUTING.en.md)


请先阅读根目录 README、架构和对应模块说明。使用 Node.js 24.x、pnpm 10.15.1 和 Rust stable，递归初始化固定 submodule，运行 `pnpm install --frozen-lockfile`。

从 `main` 建立短期功能或修复分支，例如 `feat/<topic>` 或 `fix/<topic>`。PR 说明触发方式、根因、行为变化和验证结果。SDK 改动先提交独立仓库，再更新主仓库指针。不要提交缓存、签名材料、运行库归档和设备个人数据。

运行 README 的检查命令和改动模块的回归测试。完整 Rust 测试使用 `-- --test-threads=1`，避免有执行期限的引擎测试争用 CPU。官方工具、设备、GPU 和性能验证需要额外环境，请明确实际执行范围和未执行原因。单元测试不能作为真机或完整微信兼容的证据。

PR 和 `main` 推送并行运行源码策略、API 清单、SDK 契约、Rust lint、完整工作区测试、桌面 GPU、双语文档及完整历史密钥扫描。只有根目录的 README、贡献/行为/安全说明、`docs/**/*.md` 和 `documentation.json` 构成的非空改动可以省略 Rust 与 API 源码清单检查；其他路径、缺失比较历史和手动执行均跑完整检查。`Source and contract checks` 与 `Rust workspace` 汇总所有适用任务，任一失败、取消或意外跳过都会阻止汇总通过。

同一 PR 或 `main` 上的新提交取消过时的自动检查；手动全量验证保留。Rust 按 lint、测试和桌面 GPU 分离依赖编译缓存，只由 `main` 的成功任务写入，PR 只读取；工作区源码、发布产物和执行证据每次重新生成。`Public native production` 的契约与九目标构建并行，归档和离线校验等待两组全部成功。

修复问题时先理解边界、数据流和生命周期，为可复现的行为问题补充有意义的回归测试。公开 CLI、C ABI 和 SDK 的兼容性变化须明确说明。

贡献采用所在组件的许可证，保留第三方声明，只提交有权分发的内容。[行为准则](CODE_OF_CONDUCT.md)适用于协作，安全问题请按 [SECURITY.md](SECURITY.md)私下报告。
