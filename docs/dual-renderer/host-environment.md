<a id="installing-the-appservice-host-environment"></a>
# AppService 宿主环境安装

**简体中文** · [English](host-environment.en.md)


运行时将 capabilities、DOM query policy、同步 API 的值与错误、storage 和文件镜像作为一个版本为 `1.0` 的 `HostEnvironmentSnapshot` 安装。QuickJS 与 V8 在 bootstrap 时保留私有安装函数，后续通过原生 JSON parser 调用它；安装不经过应用可改写的全局函数，也不执行应用微任务 checkpoint。

安装函数先验证并准备所有替换字段，再更新私有 lexical cells。使用 bootstrap 捕获的 intrinsics 和 null-prototype descriptor，避免环境修复触发应用替换的属性访问器或异常字符串转换。原有全局镜像名称保留为诊断别名；修改这些别名不会替换可信安装入口。`wx`、App、Page 和 Component 没有因此被冻结，WXS／现代 View 的独立 realm 也不变。

<a id="business-state-and-effect-consumption"></a>
## 业务状态与效果消费

`storage: None` 和 `files: None` 表示保留当前私有业务容器；`Some` 表示显式替换。几何修复保留尚未交给宿主的文件写入。Rust storage revision 变化需要替换 storage 时，安装会重放私有待消费 intent，保留 set、remove、clear、undefined 及最后一次写入顺序。此链仅记录待消费意图，不是第二份 storage 权威。

效果 drain 持有当批事件和 storage tail，新增效果进入下一批。原生 JSON 转换或执行预算失败时不消费该批；成功后以私有 token 确认，只退休捕获的前缀。序列化期间和后续微任务产生的写入仍属于后缀。token 从公开 `{ events, errors }` 结果移除；专用 drain 和原有 `JsEngine::call` 全局入口使用同一消费边界。

<a id="dirty-gate-and-failures"></a>
## Dirty gate 与失败

宿主几何 epoch 变化后，普通 AppService 调用、模块注册、effect continuation 和 owner turn 都在进入应用代码前检查完整环境。owner turn 先建立原有预算，再执行修复；检查原生 fault 不进入应用代码。安装成功才更新已安装 epoch 和 storage revision。

真实原生安装失败使 Session 进入 sticky engine fault，后续应用调用明确拒绝，需要新 session。故障后不运行补偿 JS、resize 或清理回调。无原生引擎的 headless 协议行为保持原有边界，不能作为执行 JavaScript 的证明。

这只是逻辑 resize 的宿主镜像前置条件。画面候选、Web 容量预留、共同发布、实际呈现回执及 resize hook 的一次性执行由各自边界负责；本接口不回滚应用、storage、timer 或 View 状态。执行结果必须另行绑定受测 commit，源码测试定义和格式检查不算运行通过。
