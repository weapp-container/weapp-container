# 运行库发行入口迁移

2026-11-12，发行工具从 `weapp-container/runtime-artifacts` 的 `f50e26252b43c13ea68821154d5ebaaa40527b75` 迁入核心仓库。独立 SDK 的下载器支持核心仓库精确发行，旧仓库只保留九个既有历史版本。根项目不再依赖旧仓库的 submodule。

新构建使用 [运行库发行工具](../tools/runtime-artifacts/README.md)。这次没有新构建原生二进制，也没有改变已发布资产、旧锁文件或 `ORIGIN.json`。源码 Apache-2.0 许可、历史二进制许可、仓库可见性和读取权限分别保留。

开源整理后，完整旧仓库改名为 `runtime-artifacts-private-archive` 并保持私有归档。
原 GitHub 仓库 ID、Release 和资产身份保留；新同名 `runtime-artifacts` 只保存审定的
停更工具源码。六个 SDK 的新下载器对冻结的九个旧版本定向私有档案，保留原锁哈希。
旧版下载器需升级，不依赖同名仓库的重定向；新的运行库版本只发布到核心仓库。

## 历史 pin 审计

归档前通过 GitHub API 读取了 9 个已发布 runtime prerelease 和 1 个 Dev Player 草稿，共 139 个资产。以 release ID、tag、draft 状态及每个资产的 ID、名称、大小、服务端摘要生成快照，其 SHA-256 为 `408be85b389237e338932294d48ef77c2bc8480477e8177b0fa6cbef389e8fe9`。本地证据保存在 `artifacts/runtime-artifacts-migration/`，归档后复查相同字段。

GitHub 在仓库归档后不再通过 Release API 返回草稿。临时解除归档确认原草稿和 APK 仍存在，并将草稿元数据及原 APK 按原摘要备份至本地 `artifacts/runtime-artifacts-migration/draft-backup/` 后，再恢复归档。九个已发布版本的 138 个资产保持原身份；旧锁的一份 preview.5.3 Android 归档在归档后完成真实下载、SHA-256 校验和全新安装。草稿没有改为公开发行。

迁移前默认锁与当时 GitHub 资产的比对结果如下。数量包含锁内全部条目，不代表对应 SDK 版本或设备验证已经通过。

| SDK | 默认锁版本 | 与当前远端资产相符 | 现有问题 |
| --- | --- | --- | --- |
| Contract | preview.5.3 | 10 / 10 | 当前 contract 源码为 preview.5.7，旧锁不能充当本代运行库 |
| Android | preview.6.0 | 0 / 2 | 两个同名 runtime 资产的大小和哈希已与旧 pin 不符 |
| iOS | preview.6.0 | 3 / 3 | 只确认锁与资产身份一致，不追加真机验收结论 |
| Desktop | preview.6.0 | 0 / 12 | 四个 SDK 归档缺失，其余同名 runtime 资产与旧 pin 不符 |
| Flutter | preview.6.0 | 1 / 12 | 三个 SDK 归档缺失，八个 runtime pin 与同名资产不符 |
| React Native | preview.5.3 | 10 / 10 | 源码所需原生版本为 preview.6.0，旧锁会被拒绝 |

这些差异发生在此次迁移之前。下载器继续按原 pin 拒绝缺失或变化的字节，不把远端当前哈希写回旧锁来掩盖差异。需要这些平台时，从匹配的干净源码构建，或显式选择已独立核验且与目标 SDK 匹配的清单。新发布器拒绝覆盖已有 tag/release，以避免继续在同一版本名下替换发行物。
