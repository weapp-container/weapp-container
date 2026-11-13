<a id="dom-inputtextarea-basic-adaptation"></a>
# DOM input／textarea 基础适配

**简体中文** · [English](dom-text-controls.en.md)


DOM presenter 将已求值 `ViewDocument` 中的 `input`、`textarea` 映射为真实 HTML
文本控件。远端 DOM 与 Browser QuickJS Worker DOM 共用同一个适配器；应用逻辑、
事件声明和组件／slot 归属仍由现有 runtime 管理，不在 iframe 中执行小程序脚本。

本页定义文本编辑的基础状态与事件契约。它不表示原生中文 IME 会话能跨文档重建
连续保留，也不授予微信官方、七宿主、无障碍、设备或性能门禁通过。

<a id="attributes-and-content"></a>
## 属性与内容

| 属性／内容 | 基础行为 |
| --- | --- |
| `input` | 真实单行 HTML input；支持 `text` 和 `password`，密码标志选择原生密码显示 |
| `textarea` | 真实多行 HTML textarea；内容由 `value` 属性设置，不把模板子节点当作初始值 |
| `value`、`placeholder` | 使用 typed 属性优先的标量投影；对象和数组明确拒绝 |
| `disabled` | 设置真实 native disabled，并在本地和 runtime 输入边界阻断被禁用控件的交互 |
| `maxlength` | 显式值先校验再应用；`-1` 解除长度限制，不把非法数值交给浏览器隐式截断或转换 |
| `cursor`、`selection-start`、`selection-end` | 接受 `-1` 或非负有符号 32 位整数；`-1`／省略表示没有显式请求，非法数值明确失败 |
| `id/class/style/hidden/data-*/aria-*/role/tabindex` | 复用现有 DOM 属性、声明归属和 WXSS 边界；内部 `data-wc-*` 不向应用开放 |

未指定 `maxlength` 时保留浏览器原生默认值，没有补写官方小程序的默认长度。
显式长度的校验与 UTF-16 选择区偏移是当前基础契约，尚未证明与固定基础库的
全部字符计数、输入法和截断规则等价。请求聚焦的声明式 `focus` 值仍明确拒绝，不能借准备候选
或设置属性提前聚焦尚未获得呈现授权的控件。

input／textarea 不接受子节点；按钮内的文本控件，包括经自定义组件包装的后代，
在整文档预检中拒绝。未知 input type、未接入的原生键盘／宿主属性及不支持的组合
返回显式错误，不生成无行为的占位控件。该适配不改变 Skia 或其他宿主的能力声明。

<a id="edit-status-and-candidate-transactions"></a>
## 编辑状态与候选事务

每个已接受候选按 occurrence 保存本地值、滚动位置、焦点、选择区起止及方向。
快照还携带控件的语义身份：tag、输入类型、声明文档及组件／事件／slot 归属。
同 session、同 page 中仅有 occurrence 名称相同，不能据此将编辑状态转移给不同
声明 owner 或不同类型的控件。

身份匹配且规范化后的声明 `value` 未变化时，新候选可以保留用户尚未写回
AppService 的本地编辑。声明 `value` 明确变化时使用新的声明值。
`selection-start`／`selection-end` 必须同时给出非负值，且起点不大于终点；显式
选择区优先于 `cursor`。没有显式请求且身份匹配时，恢复快照选择区及方向。
所有选择区均按最终实际 value 的 UTF-16 长度夹紧。新的 disabled 控件不能恢复焦点。
先恢复实际 value 再恢复滚动，避免浏览器按旧的短声明值夹紧偏移；滚动快照同样受
文本控件的语义身份约束，不能转交给同 occurrence 的新 owner 或不同类型。

准备、commit 和最终 ACK 继续使用既有 `PresentationKey`、epoch 和输入授权。
内部恢复焦点不作为一次新的用户 focus／blur 上报，避免
`bindfocus → setData → 重建 → 恢复焦点` 重复触发业务处理。真实用户焦点变化仍
进入批量事件流，恢复后可能发生的几何变化通过已有 geometry 路径报告。

失败候选不会授予输入；旧候选能否继续交互由原呈现事务和 runtime 的有效版本决定。
保留旧画面不意味着旧 key、页面或 owner 仍可输入。退休、断连和页面切换继续撤销
对应权限与资源，不通过复制编辑快照恢复已失效的会话。

<a id="input-and-keyboard-events"></a>
## 输入与键盘事件

原生 input、focus、blur 和单行 confirm 采集 `value`、`cursor`、`selectionStart`、
`selectionEnd` 等文本事实，并通过现有批量 `view.events` 交给 runtime。
浏览器不提供 handler、组件 owner、传播路径或 dataset 权威；runtime 从当前已接受
文档的声明拓扑重新派发。

每个编辑事件的 `value` 有独立的 **64 KiB UTF-8** 传输预算；它不等于原生
`maxlength` 的字符计数，也不会静默截断输入。运行时对超限、未知文本字段、无效
UTF-16 偏移和禁用控件事件明确拒绝，并在执行任何一项回调前验证整批输入。
未声明监听器的密码字段不发送文本值；几何观测不包含编辑内容。

单行 Enter 只有在非输入法组合阶段才产生 confirm。`isComposing` 或兼容的
keyCode 229 输入法键盘事件不能被当作确认提交。默认 textarea Enter 由浏览器插入
换行，不复用单行 input 的 confirm 合成。composition 状态仅用于本地键盘判定，
本次没有给 wire 协议增加 composition 字段。

应用 input handler 的返回字符串替换原生值、官方 focus／blur／input 等事件的
完整非冒泡规则，以及平台特有 confirm／键盘行为仍未完成官方语义对照。
现有事件路由的 capture／target／bubble／catch 边界不因这次基础适配自动升级。

<a id="clear-limitations-of-native-ime"></a>
## 原生 IME 的明确限制

当前普通呈现仍为“旧 iframe 快照 → 创建新 iframe → 恢复状态 → ACK”。
原生 IME composition 属于实际 Document 和文本控件，复制 value、选择区或组合标志
无法复制浏览器持有的输入法会话。因此本次能够识别组合阶段的 Enter，却不能承诺
无关 setData、热更新或候选替换期间的中文输入法连续性。

完整实现需要同文档的稳定控件协调，或独立、稳定的 native editing surface／lease；
普通数据更新应保留实际编辑控件，在页面、语义身份或授权失效时明确结束编辑。
runtime 已撤销旧呈现权限后等待旧控件 compositionend，不能代替这一生命周期设计。

后续的 [原生编辑连续性设计](native-editing-continuity.md) 将稳定 Document、
文档 permit、实际几何最终接受与有限编辑 lease 分开定义。该文档是尚未实现的
协议提案，不代表现有 v1 支持跨呈现 IME，也不增加任何已声明能力。

<a id="verification-and-evidence"></a>
## 验证与证据

所需验证包括真实输入、单行／多行 Enter、输入法确认过滤、选择区与方向、声明值
覆盖、本地编辑保留、disabled、语义身份变化、恢复焦点不重复回调、失败候选以及
旧呈现输入拒绝。涉及 Page handler、setData 和呈现版本的检查必须运行实际 runtime，
不能仅以合成 ViewDocument 或 DOM double 代替。

各次执行的源码、环境和结果由独立证据归档记录；本页不自报测试通过。合成
composition 事件只能证明本地过滤逻辑，不能证明操作系统中文输入法、原生会话
连续性或硬件设备通过。冻结的 279 项发布门禁保持原有验收要求。
