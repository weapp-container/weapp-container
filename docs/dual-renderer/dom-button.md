# DOM button 基础适配

DOM presenter 将已求值 `ViewDocument` 的 `button` 映射为真实 HTML
`<button type="button">`。共享 WXML、组件/slot 归属、稳定 occurrence、typed 属性和
事件协议保持原样。该适配同时由远端 DOM 与 Browser Worker DOM 路径复用。

本页定义容器的本地基础契约；默认外观、键盘和 disabled 行为尚无官方 DevTools
oracle。Node 合同使用 DOM/RPC doubles，不代表真实浏览器、硬件或 near-parity 门禁通过。

## 支持边界

| 属性/内容 | 行为 |
| --- | --- |
| 文本、`text/view/image` 等非独立控件子树 | 保留已求值内容、样式和声明归属，不重新执行 View/WXS |
| `type` | `default`、`primary`、`warn`，省略时 `default`，仅控制外观 |
| `size` | `default`、`mini`，省略时 `default` |
| `plain` | 透明背景及边框的基础外观 |
| `disabled` | native disabled 与本地祖先输入栅栏；子节点不能绕过 |
| `loading` | CSS 忙碌指示和 `aria-busy`，不自动设置 disabled |
| `id/class/style/hidden/data-*/aria-*/role/tabindex` | 复用现有 DOM 属性和样式边界；内部 `data-wc-*` 属性仍禁止由应用提供 |

布尔属性沿用现有 typed 优先规则和 `truth` 转换：typed 值覆盖同名 legacy 字符串；
缺省、`null`、`false`、`0`、字符串 `"false"` 为假，其余合法标量按已有规则处理。
此处没有新增一套官方布尔语义。对象/数组不是控件标量属性。

按钮内的 `button/input` 或带 `tabindex` 的后代在整份文档预检阶段拒绝，包括经组件
包装的后代；该检查早于候选 iframe 创建和任何图片资源获取，避免嵌套独立控件产生
不确定的原生默认行为。普通后代仍可绑定 tap/touch 事件。

`open-type`、`form-type`、`hover-class`、`session-from` 等宿主特殊属性和其他未列出的
按钮属性均返回 `ERR_UNSUPPORTED_CAPABILITY`，包括空的 `open-type`。未知 type/size
同样拒绝。基础 button 事件仅包括 tap、touchstart/move/end/cancel、focus/blur；
按钮自身的 input/confirm/scroll 绑定明确拒绝。没有分享、登录、支付、表单提交/重置等空实现。

## 浏览器、事件和样式

原生 button 保留浏览器键盘焦点、Enter/Space 激活及基础无障碍角色；native click
进入现有一次批量 tap 分发，不额外由 keydown 合成 input confirm。按钮携带真实
disabled 状态以及相应 `aria-disabled`、`aria-busy`；应用可提供 `aria-label`。
同页面同 occurrence 的按钮焦点在新候选完成呈现后恢复，更新后 disabled 的按钮
不会重新获得焦点。

disabled 按钮及其后代的 tap、touch 和键盘激活在浏览器捕获入口与 presenter
批处理入口均同步拦截，不触发父级 capture/bubble handler，也不建立手势联系人。
loading 按钮仍可交互。启用按钮继续使用既有 dataset/组件/slot 归属和
capture/target/bubble/catch 顺序；catch 的同步传播与 touchmove 默认取消策略不变。

WXML `type` 不写入 HTML 的 type 值；native type 始终为 `button`，不会借 appearance
值触发提交或重置。样式编译将 `button[type]`、`button[type="primary"]` 以及无类型限定
的 `[type]` 选择器映射到保留源属性的内部投影，维持原来的选择器 specificity。
省略 WXML type 不会凭空增加源属性；`input[type]` 等其他原生控件的选择器保持原意。
内部投影不会写回 ViewDocument 或事件 dataset，应用不能用同名 data 属性覆盖它。

基础调色、尺寸、边框和焦点样式使用零 specificity 的 `:where(...)`，作者 WXSS
随后加载，inline style 优先级保持原样。loading 采用 CSS `::before` 指示器并尊重
`prefers-reduced-motion`；作者的伪元素样式仍可覆盖它。此默认样式不是官方资源或
官方像素基线。

## 验证范围

Node 合同覆盖基础属性与 typed 值、保留子树、显式 unsupported、嵌套控件提前拒绝、
disabled 后代阻断、loading 可交互、capture/catch/归属、native type/ARIA 投影、
源 type 选择器、默认样式优先级、键盘转交策略与更新后的焦点恢复。

controls 集成 r6 已通过真实 Enter/Space、disabled/loading、浏览器 CSS/布局和
迟到输入专项。屏幕阅读器、设备及官方默认行为仍须独立证据验收；该实现不更新冻结的
279 个发布门禁，也不授予 Skia、其他宿主、官方等价性或性能通过。

## 可选真实浏览器 fixture

`browser-dev-loop-smoke.mjs` 新增显式 `--fixture button`，仅接受
`--server-kind cli --renderer webview`。不传时继续使用原有 reference fixture，
不会把历史 button 失败改记为通过。该模式仍要求调用者提供独立、固定且已验证的
`--server-bin`、`--producer-dir`、`--pins`、`--node-bin` 与全新的 `--out-dir`；
runner 不构建 runtime、不派生信任 pin，也不连接现有预览或用户 Chrome。

fixture 使用真实 `button`/子节点与声明的 Page handler，public diagnostic module
只读取原 AppService 的有界事件日志。检查首次子节点点击与 typed dataset、capture/catch、
原生 Enter/Space、disabled 后代阻断、loading 交互、实际 computed CSS 与源 type selector。
动态检查使用真实 touchstart 触发 disabled，等待原始 `view.presented` final 与当前
DOM 输入栅栏，再发送迟到终止；要求旧触点 cancel 恰好一次、无迟到 target/祖先事件，
并验证后续新触摸正常工作。触摸 CDP 仅由 runner 所属 context 对其所属 page 创建，
在专用 finally 中 detach。没有 remote CDP 或借用浏览器连接。

Space 重建由实际按钮先开启声明的 AppService timer；按住真实 Space 时等待新文档，
先绑定仍可输入的原 owner、当前原始 final、已聚焦的旧 iframe/document/element，
再要求本 probe 的唯一 trusted Space keydown 确实来自这些仍连接的旧对象，且早于
新文档唯一 trusted focusin。旧 iframe 须在该 focusin 前从顶层文档移除；旧元素与其
Document 的归属和原始 `isConnected` 分别保留，脱离顶层的 Document 中后代仍可为 connected。
缺少本轮
keydown、输入栅栏关闭或只能找到之前普通 Space 的记录均明确失败，并检查迟到 keyup
不重放 tap、新 Space 仍只触发一次。观察器从父文档捕获真实 iframe load 后安装，
不为 sandbox 开启脚本。模块/DOM 观测轮询在 Node 侧严格 await；不会把异步浏览器
表达式的 Promise 当作已满足的条件。所有 frame final 只保存白名单版本元数据，
不记录任意 bridge payload 或凭据。

真实编译器、WASM Worker 和浏览器专项已在 `4f753cab` 的 controls 集成 r6 完成，
11 项检查通过，并完成 12 次热更新、构建失败保留交互及 Stop 清理。执行与旧失败见
[集成证据](../archived-evidence.md)。这些结果限于
该受测环境；iframe 从 DOM 移除与 runtime touchcancel 是被观察的释放边界，不宣称
浏览器 GC、硬件或完整内存无泄漏。
