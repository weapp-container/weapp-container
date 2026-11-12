# Clean-room 与证据记录

兼容行为通过版本固定的公开接口、独立测试和输入输出对照验证。每条记录需要保存方法、工具版本、输入 SHA-256、分析时间、选取范围、结论和限制；仓库不保存官方私有源码、资源、用户数据或可替代官方实现的二进制。

证据不能证明官方包声明与 unpacked bytes 一致。对声明完整性矛盾、关系覆盖不足或无法观察的模块，记录为 unknown/partial，并通过公开行为测试补充契约。

产品统一使用 Weapp Container 名称，模拟器 CLI 为 `weapp-simulator`，产品环境变量以 `WEAPP_CONTAINER_` 开头，C ABI 符号以 `weapp_container_` 开头。`pnpm naming:check` 校验公开 CLI、库名、包名和 C ABI 的声明；`pnpm naming:test` 覆盖声明缺失、名称不一致和错误导出的拒绝行为。

[公开证据索引](evidence-ledger.json)只保留可分发的历史摘要。完整原始记录保存在[私有档案](archived-evidence.md)，公开索引的整理不修改原始证据字节，也不将历史结果升级为当前版本的验收结论。缺少输入或原始记录时，完整证据检查继续报告未满足条件。当前容器输出使用 `.weapp-container`。

`vendor/weapp-vite` 保持为固定 commit 的干净检出。需要改动上游 E2E helper 或项目配置的验证任务，应从该固定 SHA 创建任务专属的临时 checkout，在那里执行和收集报告。结束时将本地 patch、配置和原始报告连同源 SHA、文件清单及哈希归档；校验后按归属清理临时 checkout。不要在固定子模块中留下验证配置或生成物，也不要把归档的本地 patch 当作已经验证或发布的上游能力。
