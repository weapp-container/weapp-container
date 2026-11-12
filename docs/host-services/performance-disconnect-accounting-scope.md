# PerformanceObserver.disconnect 实现登记范围

`disconnect(): void` 的有限清理合同已有真实私有实现：同步移除订阅、清空pending并递增generation，阻断已分离的旧交付；公开receiver不能重定向私有authority。重新observe按新generation交付，能力撤回后仍能清理原observer。此次只将该方法从不完整指标生产范围中分离，恢复七端7格已有实现漏计，运行时源码未改。

Performance factory、observe、supportedEntryTypes、setBufferSize和六个列表读方法保持Partial。返回列表缺moduleName/pageId，route/render/resource/loadPackage等指标尚未接入真实生产边界；补字段不能代替指标实现。没有新增producer或平台验收。

完整词法闭包由固定Acorn AST与现有installer/bootstrap源身份约束；后续语义变化必须重新审查。实际327项Node与矩阵验证、独立审查及剩余范围见[证据](../archived-evidence.md)。该批没有新native、浏览器、设备、公开SDK执行或新构建归档。accepted保持0。
