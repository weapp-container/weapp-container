<a id="performanceobserverdisconnect-实现登记范围"></a>
# PerformanceObserver.disconnect implementation of scope registration

[简体中文](performance-disconnect-accounting-scope.md) · **English**


The limited cleanup contract for `disconnect(): void` already has a real private implementation: it synchronously removes subscriptions, clears pending work, and increments generation to block detached old deliveries. Public receivers cannot redirect the private authority. Observing again delivers under a new generation, and the original observer can still be cleaned up after capability revocation. This change only separates the method from incomplete metric production coverage and restores 7 previously omitted implementation cells across the seven platforms. Runtime source is unchanged.

Performance factory, observe, supportedEntryTypes, setBufferSize, and six list read methods remain Partial. The return list is missing moduleName/pageId, route/render/resource/loadPackage, and other metrics have not been integrated into real production boundaries; adding fields cannot replace metric implementation. No new producer or platform acceptance has been added.

The complete lexical closure is composed of a fixed Acorn AST and existing installer/bootstrap source identity constraints; subsequent semantic changes must be re-evaluated. Actual 327 Node and matrix validations, independent reviews, and remaining scope are available at [evidence](../archived-evidence.en.md). This batch contains no new native, browser, device, public SDK executions, or new build archives. Accepted remains 0.
