# 兼容验证

Weapp Container 通过固定版本的公开工具行为观察兼容性，测试不以私有实现源码为输入。
基线见 [baseline-v1.json](baseline-v1.json)，用例索引见 [case-index-v1.json](case-index-v1.json)。

## 验证层级

- 单元测试验证 manifest、IR、运行时和证据处理协议。
- headless 回归验证所选运行时路径，不能代替官方开发者工具。
- 官方观察绑定实际工具版本、compiler 提交、执行输入、运行报告和证据哈希。
- 平台、GPU、真机和性能是独立结果，不由其他层级推导。

索引中 unknown、blocked、failed 和 passed 保留各自语义。缺失证据、未执行的
平台和不完整的差异报告不能视为发布通过。历史用例和原始报告保存在私有档案；
请阅读 [历史证据说明](../archived-evidence.md)。当前公开快照没有全量微信兼容声明。

## 常用入口

证据处理测试也使用固定上游仓库的 Vitest / IDE CLI，先准备公开源码依赖：

```sh
pnpm --dir vendor/weapp-vite install --frozen-lockfile
pnpm --dir vendor/weapp-vite --filter weapp-ide-cli... build
pnpm conformance:index
pnpm conformance:verify
pnpm conformance:evidence:test
pnpm mpcore:conformance:run
```

`conformance:verify` 校验已提交的 golden，修改索引后应审核差异再提交。
官方工具执行使用 `pnpm conformance:official`，需按脚本说明提供实际安装的工具和
任务拥有的资源。完整 `near-parity:gates` 在未满足条件时继续失败，保留其报告。

编译器构建和 producer 版本说明见 [compiler-build.md](compiler-build.md) 和
[reviewed-producer-revisions.md](reviewed-producer-revisions.md)。新增公开结论必须记录
源码、工具、输入、输出、执行方法和剩余限制。
