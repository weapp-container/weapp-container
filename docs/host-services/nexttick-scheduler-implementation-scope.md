<a id="nexttick-and-idle-scheduling-implementation-scope"></a>
# nextTick 与 idle 调度实现范围

**简体中文** · [English](nexttick-scheduler-implementation-scope.en.md)


retained turn scheduler 使用有界 FIFO frontier、Promise checkpoint 和 Page/Component owner retirement。`wx.nextTick` 保持 callback → void 合同；idle API 仍缺真实 host idle opportunity producer。实现代码、Node 和历史 native 验证分别记录，不能由有限 Web 诊断扩张合同。

先前安装产品浏览器尝试存在未决网络取消失败；最新 capture-only 与最小 stream/GC 诊断分别保存实际严格状态。诊断通过、执行完整或清理通过均不等于七端产品验收通过，也不建立取消豁免。历史原始报告和补充归因更正分别保存，详见[证据](../archived-evidence.md)。

三个 API 共 21 格继续 Partial；Δavailable=0、Δacceptance=0。没有公开 SDK、硬件、其他 OS 或微信 oracle 验收。
