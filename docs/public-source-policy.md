# 公开源码发行边界

对外仓库只接收审定的 main 历史、源码、文档及匿名化回归输入。
原核心、website 和 runtime-artifacts 的完整历史、PR 引用、Release、Actions
日志和附件分别保存在同组织的 `weapp-container-private-archive`、
`website-private-archive`、`runtime-artifacts-private-archive` 私有归档中。
这些档案不属于公开集合，也不应在后续迁移中 mirror push 回公开仓库。

公开前整理快照的旧历史另存于 `weapp-container-publication-private-archive`，
同样保持私有归档。公开核心仓库从最终审定的源码快照开始。

源码按各目录实际许可证分发；第三方许可保留。旧专有运行库不会因为当前源码
采用 Apache-2.0 而改变许可。新的公开二进制应从匹配的干净源码构建，附带完整
许可、构建来源、目标平台和哈希，使用新 tag 发布。

## 提交检查

每个源码仓库的 Publication security 工作流使用 SHA-256 固定的 Gitleaks 8.30.1，
扫描完整取得的 Git 历史，另检查本机用户路径、签名文件、私有证据目录和 LFS 指针。
本地可用 `node scripts/scan-public-source.mjs --root . --scanner /absolute/gitleaks --mode source`
检查核心工作树；其他仓库的入口位于 `tools/`。提交后以 `--mode history` 检查候选仓库。
子模块独立扫描，不由父仓库扫描结果替代。

例外只接受 `.public-source-policy.json` 中按文件、规则及内容摘要绑定的已核验 fixture；
不按整个目录忽略。报告不输出匹配原文，临时原始报告执行后删除。任何新增或变化的
候选都需要重新审查，不能用更新 allowlist 掩盖真实凭据。

公开前核对新仓库身份、所有远端引用、子模块、Release 与 Actions；仅有 main
工作树通过不代表整个原仓库可公开。私密漏洞报告流程见 [SECURITY.md](../SECURITY.md)。
