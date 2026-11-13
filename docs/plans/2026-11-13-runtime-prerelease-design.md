# GitHub 预发布自动化设计

**简体中文** · [English](2026-11-13-runtime-prerelease-design.en.md)

## 目标

手动从 main 启动原生生产，开启 prepare_release 后，固定核心与 SDK 源码，生成完整 14 归档的 Release 草稿，最终由所有者手动 Publish。

## 实现

预检核对候选版本、SDK 源码清单及未使用的标签，保存候选收据。后续工作流只接受本仓库 main 上指定工作流的成功生产，并等待同一核心提交的源码、文档和安全检查。Android、iOS、三端 Desktop 使用该生产的运行库和许可输入，在各自宿主执行已有构建与消费者检查。Linux 汇总九个运行库及五个 SDK 归档，通过现有打包器和独立 Contract 离线安装器核验。

发行策略分别记录 runtimeVersion、publishedRuntimeVersion 和 contractVersion。候选构建不要求尚未生成的公开锁；六个已公开锁仍须闭合。草稿上传使用最小写权限、同版本串行及服务端哈希复验，拒绝覆盖已有草稿或 tag。发布器新增 draft-only 选项，默认验证和原显式发布行为保持兼容。

iOS 生成的 SwiftPM 包引用本地 XCFramework，避免验证过程中下载上一公开版本。保留源码中的公开 SwiftPM URL，生成包的文件哈希记录本次实际字节。

## 验证

覆盖失败或外部生产、错误源码、SDK 固定提交、候选与公开版本分离、14 个目标完整性、错误哈希、失败消费者、重复发行及上传中断。执行 actionlint、发行工具、SDK 合约和双语文档检查。新版本端到端验收保持草稿。人工 Publish 后匿名下载全部 17 个资产，复验 14 个离线安装，并输出后续六个 SDK 锁更新所需的 manifest。
