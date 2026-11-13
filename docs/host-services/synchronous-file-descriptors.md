<a id="scope-of-implementation-for-managed-synchronous-file-handles"></a>
# 受管同步文件句柄的实现范围

**简体中文** · [English](synchronous-file-descriptors.en.md)


本批补齐 `openSync`、`closeSync`、`readSync`、`writeSync`、`fstatSync`、
`ftruncateSync`、`truncateSync` 的实际 native std::fs 实现。公开调用经过
FileSystemManager → 共享同步 facade → sealed native transport → ManagedSyncFileSystem。
标准输入以锁定 miniprogram-api-typings 5.2.3 为准；没有将异步 UI 或缓存写入伪装为同步持久化。

每个执行 owner 独立生成 opaque fd 字符串，最多同时 64 个，不暴露 OS fd 或真实路径。
所有读写与 native async adapter 共用作用域磁盘事务锁；write/truncate 同步刷盘，创建
同步刷入父目录。已关闭或其他 owner 的 fd 均拒绝；正常 retirement 排空已准入同步调用并
释放全部文件句柄。公开自定义 provider 的 retirement panic 被隔离，错误保持到显式终结
通道，后续业务调用持续拒绝；资源失败不计作清理成功。自定义 provider 不可在其同步
invoke/retire 内重新进入同一 binding。

readSync 支持目标 buffer 偏移、读取长度、EOF 短读和 position；显式 position 保持文件
指针不变，未指定时推进当前指针。返回的 arrayBuffer 与调用者传入对象为同一实例。
writeSync 支持 UTF-8 文本及 ArrayBuffer 范围写入；文本长度按字节报告。append flags
总是在文件末尾写入，显式 position 不改变后续文件指针。truncate 缩短或扩展真实文件，
扩展区域为零。同步 FileSystemManager 的 named payload 去除重复 args，避免同一
ArrayBuffer 被计算两次预算。

<a id="explicit-limits-and-unaccepted-items"></a>
## 显式限制与未验收项

- 仅 native SDK 配置了 managed_files_root lease 且绑定同步 provider 时可用。
  Web/Worker 尚无对应同步持久层，不计本实现。
- 单次二进制/UTF-8 chunk 最多 1 MiB；原有作用域 quota 为 32 MiB。打开句柄还保留
  当前文件长度的保守字节 reservation，使 rename/unlink 后仍可访问的文件也受限；
  同一文件多开会重复预留，close 释放 reservation。该 reservation 只统计本 provider 的
  live handles，跨 owner/跨进程共享同一目录时，尚无统一的孤立 inode 账本；不能
  宣称所有 owner 合计物理占用的硬 quota，后续需要共享 registry 或统一文件服务。
- 目前只接受 UTF-8 文本编码；其他锁定编码、递归 stat、异步 fd 对等接口、压缩/zip
  等继续缺项，不把本批提升为完整 FileSystemManager。
- native 生命周期/文件和真实 QuickJS/V8 的有限测试，不能替代各 SDK 新归档安装、
  七端系统权限、物理设备或发布验收。
