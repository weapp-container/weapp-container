<a id="native-editing-continuity-follow-up-protocols-and-implementation-design"></a>
# 原生编辑连续性：后续协议与实现设计

**简体中文** · [English](native-editing-continuity.en.md)


**状态：原生编辑 lease 仍为设计；文档事务基础已新增显式实验实现。**
当前实际 wire 名称、身份、容量和限制见 [Live Document v2](browser-live-document-v2.md)。
它声明 `nativeEditing:false`，更新期间冻结原生输入；普通模拟器和 Worker 保持 v1。

v2 已增加 native 保留的事件派发入口：完整预检已接受 receiver snapshot，并在每个
listener lookup 前、getter 后、实际调用前及结果序列化后检查真实实例；runtime 在
microtask checkpoint 后再次复核，退休时撤销旧输入权限并保留已发生的 JS 效果。
touch cancellation 也保留原 snapshot，不能向同名新实例重定向。此边界已具备
后续 editing lease 所需的逐回调实例校验；lease 发放、延后事实及受控 echo 因果仍未实施。
下文描述完整编辑连续性的目标设计，不代表所有入口、lease 和产品接线已经实现。
现有 receiver／`inputLifetimeRevision` 和 document permit 不会使旧呈现 key 恢复有效，
也不会发放编辑 lease 或保留原生 IME。

当前行为与限制继续见 [DOM 文本控件](dom-text-controls.md) 和
[Browser presentation v1](browser-presentation.md)。本设计不修改这些 v1 合同，
不登记测试通过，不修改冻结的 279 项门禁。Web remote/browser、macOS、Windows、
Linux、Android、iOS、鸿蒙仍在原目标内；QuickJS 与已有 V8 范围、官方 oracle、
实际宿主、设备、硬件和性能证据各自验收。

<a id="issues-and-choices"></a>
## 问题与选择

当前 presenter 按 revision 创建 iframe，快照旧控件，再向新控件写回 value、
选择区和焦点。浏览器持有的 composition、撤销栈、输入法候选窗口及原生编辑上下文
属于实际 Document 和控件，无法从快照重建。即使控件值正确、Enter 被过滤，
也不能说明 composition 跨呈现连续。普通 revision 将 iframe 设为 inert、
阻止所有 keydown 默认行为，或者重新 focus，同样可能提前结束编辑。

后续实现采用以下边界：

- 同一个 live surface 持有稳定 iframe、Document、page root 和原生控件。
- 准备阶段只生成冻结的 typed patch、资源准备和连续性判定，不试改 live tree。
- runtime 先授权一次精确的文档变更；浏览器应用后才采样实际几何。
- runtime 在同一个最终事务中接纳实际几何和呈现 ACK，然后恢复业务事件权限。
- runtime 发放有限编辑 lease，使一个精确接收者可以在普通呈现暂停期间继续原生
  编辑；lease 不授予提前执行应用回调、查询或命中测试的权限。

不采用通用的“临时应用 → 测量 → 撤销”路径。没有发生 paint，不等于没有副作用：
value/type/selection/disabled、祖先移除或隐藏、焦点和 inert 变化可能已经终止 IME，
改变撤销栈、触发 native 事件、发起资源请求或启动 CSS/native 状态。撤销 DOM 字节
不能撤销这些行为。即使当前 authored animation 被拒绝，基础样式、浏览器默认行为
及后续 adapter 也不能据此假定可逆。

hidden clone 可用于非权威预检，不能提供 permit 的权威几何。它没有原控件的真实
`:focus`、`:focus-within`、`:focus-visible`、hover、native selection/scroll 状态；
独立上下文还可能具有不同 font、viewport、media 和资源状态。将原控件移入 clone
又会损害需要保留的编辑上下文。本设计不重写全部动态 CSS 来模拟原生状态。

<a id="three-independent-lifecycles"></a>
## 三个独立生命周期

| 生命周期 | 身份与权限 | 普通 setData | 必须结束的边界 |
| --- | --- | --- | --- |
| 呈现事务 | 完整 `PresentationKey`、permit、最终 ACK、geometry epoch；授权当前业务事件与查询 | 新 key，旧 key 继续按既有规则退休 | 事务取消、替换、失效或最终 ACK |
| 硬输入生命周期 | runtime owner/attachment、session、page instance、route、surface generation、`inputLifetimeRevision` | 只有 runtime 证明不存在硬失效时才保持 | owner/attachment 退休、页面或应用 hide/unload、导航、renderer 切换、surface 丢失、逻辑 metrics 失效、接收者图销毁等 |
| 原生编辑 lease | runtime 发放的有限 lease ID，绑定硬生命周期及精确编辑接收者 | 可跨允许的后继文档，业务派发仍等待新 ACK | 到期、原生 blur、受控状态冲突、身份变化、硬生命周期失效或显式释放 |

编辑 lease 不延长任何呈现 key。旧 `view.events`、旧 geometry、旧 query response
仍必须拒绝；不能把它们改成新 key 重放。`inputLifetimeRevision` 的同值也不等于
编辑接收者仍存活，runtime 还必须校验页面、声明和组件实例的实际连续性。

lease 的接收者身份至少绑定：page instance 与 routePath、occurrenceId、声明文档、
tag/input type/key、eventOwner、componentScope、slotOwner，以及 runtime 中实际
接收者实例的连续性 token。相同字符串 ID 不能证明实例相同。组件移除后重建、
slot 改属、导航返回缓存页、owner A → B → A 都不能复活旧 lease。浏览器不能
提交 handler、owner、传播路径或 dataset 来补造这份身份。

硬输入失效先撤销本地编辑许可和队列，再运行可能重入的取消、blur、清理或通知。
不能为了等待 compositionend、资源清理或应用回调而延后撤销。重新获得相同页面
名称或尺寸也需要新权限。普通 root-data 更新是否允许连续，由 runtime 根据实际
生命周期和接收者变化判定，浏览器不得从“没有导航”自行推断。

<a id="explicit-negotiation-and-v1-retention"></a>
## 显式协商与 v1 保持

新合同需要 runtime、桥接 transport、session client、owner adapter 和 presenter
全部显式协商。建议单独登记 presentation v2 与 native-editing v1 两个合同，并明确
要求：文档 permit、live geometry finalization、精确 handle、有限 lease、有限队列、
同步硬撤销和异步释放屏障。最终名称和 schema 必须在实现时统一定义并覆盖严格验证。

能力来自实际接收端的合同结果，不能从方法存在、传入可选参数、版本号大小、
`isComposing`、示例配置或测试 fixture 推断。尚未完成任一端时继续使用 v1，
不得将未实现的字段写入 loadResult、manifest、capability 或 observation。

v1 保留“隐藏候选实际布局 → 几何 permit → commit → ACK”的严格顺序、
错误与旧权限拒绝行为。v1 的未知字段、v2 请求、编辑 lease 和无几何 permit
必须明确拒绝。不能把 v2 的延迟几何塞进 v1 permit，不能以空几何占位，不能
因为另一端未支持就静默退回更宽松的授权。显式选择 v1 时仍不承诺原生连续性。

<a id="draft-api-and-transaction-order"></a>
## 草案 API 与事务顺序

以下名称用于完整 lease 设计的数据流；实验实现使用独立的 `view.live.*` 命名，
尚未提供本节的 editing lease 或 edit flush/release wire 入口。
u64 继续使用规范 decimal string，所有请求与响应使用 exact schema、整体预算、
原请求关联和不可变快照。文档 token、permit ID、lease ID 由 runtime 发放。

| 草案入口 | 请求中的关键内容 | runtime 结果与含义 |
| --- | --- | --- |
| `view.prepare` v2 | 当前 owner/attachment、surface generation、精确 render 请求、可选活动 lease ID | 已求值文档、完整新 key、document token、base key、接收者连续性和受控冲突判定；尚无输入权限 |
| `view.prepare.commit` v2 | 新 key、document token、base key、精确活动 lease ID 或 null | 有限 document permit；只授权应用这个文档，不声称几何已测量或呈现已接受 |
| `view.presented` v2 | 精确 document permit、live patch receipt、完整实际 geometry batch、lease 连续性结果 | 原子校验并接纳文档及实际几何，返回最终 ACK、inputEnabled、lease disposition 和效果 |
| `view.abort` v2 | 精确 key、document permit/receipt（如已取得）、原因 | 取消仍未接受的事务；返回权威恢复/禁用结果，不恢复旧 lease 或 key 的权限 |
| `view.edit.flush` 草案 | 当前已 ACK key 与 epoch、lease ID、连续 edit sequence、有界 native facts | 从当前文档和 lease 重新验证接收者，整体预检后按序派发；返回精确消费结果 |
| `view.edit.release` 草案 | 精确 lease ID、序号、释放原因 | 单调退休 lease；幂等重复只能确认原释放，不能影响后继 lease |

document permit 必须绑定 runtime 当前 owner/attachment、硬输入 revision、base key、
新 key、document token、连续性/冲突决定及有限 deadline。token 指向 runtime 保存
的精确已求值文档，不能仅比较客户端重编码 JSON 的摘要。typed patch 只在浏览器
本地使用，并由精确 handle 绑定冻结 plan 与 permit，不能作为 wire dispatch 权威。

建议一次只存在一个 live patch transaction，另保留一个“最新待准备请求”。旧事务
未完成 ACK/abort 的明确结果前，不得让后继 patch 覆盖其 journal、receipt 或 lease。
提交中收到更新只替换待准备请求，不改变当前事务已经捕获的身份。

一次事务按以下顺序执行：

1. 捕获当前已接受 base、硬生命周期及活动 lease，暂停普通业务事件入口；有效 lease
   对同一真实编辑控件的 native defaults 可继续。先登记事务与 drain，再开始可重入工作。
2. runtime 求值和预检文档，独立判断原编辑接收者是否仍是同一个实例、声明是否冲突。
   浏览器准备 typed patch、解析后的 CSS 和资源 leases；live Document 尚不变化。
3. runtime 发放 document-only permit。浏览器同步重查 owner、硬生命周期、deadline、
   base 和精确 handle；有任一变化时释放本次候选，不能应用 patch。
4. 浏览器按连续性决定处理编辑 lease，再把 typed patch **应用一次**到 live Document。
   保留旧资源和 rollback journal；业务派发继续暂停。此时新画面可能已经可见，必须
   标记为 committed/unacknowledged，不能把它报告成 accepted。
5. 等待本事务拥有的 decode/font/RAF 等必要稳定点，采样包含所有 occurrence 的真实
   geometry。等待可取消、有 deadline；硬失效会立即终止编辑和后续 ingress。
6. `view.presented` 在 runtime owner 线程上重查全部 fence，验证完整几何，然后在一个
   原子接受步骤中发布文档、初始 geometry epoch 和最终 ACK。几何不合法时不发布任何
   一部分。页面 ready 等应用效果在接受点后执行，不能据其失败回滚已经接受的呈现。
7. 浏览器处理最终结果时先登记“已接受且输入关闭”，再处理生命周期效果和重入。
   等待前驱真实资源释放屏障，最后重查当前 owner/硬 revision/lease/新 key，才能开启
   普通输入。编辑队列使用新鲜已接纳几何另行派发，不能借 document permit 越过 ACK。

ACK 丢失或超时是结果不明，不能立即回滚。transport 必须能够按原请求取得相同最终
结果，或通过明确的 runtime 结果查询/abort 判定是否已接受；这同样需要新合同实现。
无法判明时保持输入和编辑关闭、资源有界保留并要求恢复，不能再发另一次 commit
赌结果。取消通知、HTTP 202、SSE snapshot 和本地 patch 完成都不是最终 ACK。

<a id="stable-surface-and-typed-reconciliation"></a>
## 稳定 surface 与 typed reconciliation

surface 持有 iframe/Document/page root、DOM occurrence map、native-node WeakMap、
一组委托 listener、ResizeObserver 和 surface 级异步清理 owner。revision candidate
只持有 plan、typed operations、journal、资源 leases、异步任务及 receipt。
老 candidate 的 `dispose()` 不得销毁后继共享的 iframe、listener、observer 或编辑控件。
page/owner/surface 真正替换及 shutdown 才按所属资源执行 surface 释放。

typed operations 应至少区分 create/remove/move、text、attribute、inline style、
stylesheet、image binding、scroll、control value/selection/disabled。所有值先完成
现有语义、CSS、资源和预算校验；不能使用 raw HTML、脚本、任意 URL 或 component
prop 到 DOM attribute 的捷径。remove attribute 必须是明确 operation，不能只补新值。

普通非破坏性更新须保持实际控件及其保留祖先的 node identity、Document、连接关系
和焦点，不执行等价 value/selection/type/disabled 写入，不调用 focus/blur，不切换
inert/display/visibility，也不通过 `replaceChildren`、fragment 或重建祖先搬运控件。
新建/移除其他分支和修改 label 可以按 patch 执行。重排若必须移动活动编辑分支，
默认判定为连续性边界；只有该宿主对相应 native move 原语有真实连续性证据时，
才可另外扩展合同，不能假定普通 `insertBefore` 保留编辑上下文。

CSS scope token 分配须在 surface 内稳定，或与整份 stylesheet/attribute patch 一起
原子更新。新样式和 inline URL 使用新 plan 的资源 leases；旧样式、旧 image URL、
被移除节点及 decoder 借用保留到最后使用和 ACK/rollback 决定结束。浏览器 CSS
支持性预检不是实际布局证据，真实 geometry 始终在 live apply 之后采集。

CSS 变化仍可能隐藏编辑祖先或触发实际 blur。浏览器必须在 apply 和每个异步恢复点
检查原节点仍连接、`ownerDocument` 相同、activeElement 仍是原节点且可编辑。
失败时报告 continuity ended，立即关闭 lease；不能用再次 focus 或伪造组合标志修复。
可以继续接纳合法新文档，但不能报告该次编辑连续。任意 CSS 变化都连续并非本提案承诺。

<a id="editing-lease-distribution-duration-and-queue"></a>
## 编辑 lease 的发放、期限与队列

建议每个 surface 最多一个活动 focused-editor lease。runtime 只从当前已接受文档中
验证过的真实 focus 事实发放 grant；grant 返回在该事件的实际最终结果中，不从
浏览器自行声明的“正在 composition”字段发放。focus handler 若触发导航、移除
组件或其他硬失效，最终结果必须撤销或省略该 grant。处理结果时先采纳权限变化，
再调度新呈现或交付应用效果，防止重入窗口使用尚未验证的 grant。

grant 至少包含 opaque lease ID、runtime receiver token、硬生命周期身份、起始已
ACK key、单调 lease sequence、control source version、已消费 edit sequence、运行时
限定 TTL、队列上限和允许的 native fact 种类。
建议 TTL 上限 **15 秒**；runtime 可发放更短期限。续期需要 runtime 在当前已 ACK
文档中重新验证同一 focused receiver，并返回新的 sequence 和 deadline；heartbeat、
重复 observation、输入法事件或本地活动均不能自行延长。请求挂起期间不能靠无界
续期等 ACK。到期立即撤销；晚到的旧续期不能复活已经到期/释放的 lease。

runtime 使用自己的单调时钟独立校验到期。跨进程不比较绝对时钟；浏览器用请求
发出时记录的本地单调时间加响应给出的 TTL 建立保守截止点，不能从收到响应时
重新开始完整 TTL。系统恢复、owner reconnect 或计时连续性不明时先禁用再验证。

建议初始队列限额：最多 **256 条**尚未完成的 native fact，总计最多
**256 KiB UTF-8 编码字节**，单条编辑 value 继续最多 **64 KiB UTF-8**。
总量必须计入 envelope、身份、序号、字符串及选择区等完整编码，待发、在途和
结果不明的副本全部计费；既有 Worker/transport 整体 payload 上限仍适用较小值。
runtime 与浏览器均执行 count 和 aggregate-byte 两道限制，不能靠大 value 的少量
事件绕过 count，也不能在复制巨大值之后才检查。实现必须定义同一有限编码器与
预检顺序，并覆盖多字节、代理对、元数据和在途副本边界。

每条记录绑定 lease ID、硬生命周期、receiver token、连续 native edit sequence，
以及采集时实际原生 value/UTF-16 selection/time facts；composition/键盘原始观测
可作为诊断，但不是转移 dispatch 权限的凭据。暂停期间的记录尚无可用呈现 epoch。
最终 ACK 后，以当前 key 的新鲜已接纳 geometry 绑定待发批次；runtime 再验证该
lease 与当前接收者一致，独立推导处理器与传播路径。不能把旧 `view.events` 批次
换 key，不能把旧 geometry epoch 搬过来，不能将编辑队列用于 tap/touch/query。

只允许一个在途 flush，另有一个有界待发队列；所有记录和结果指纹受同一预算。
相同 sequence 与原始内容只允许幂等确认，冲突内容是协议失败，已消费记录不能
执行两次。整批先预检，再逐条执行；某条回调造成硬失效时立即终止余下记录。
不得为节省容量静默合并 input/focus/blur 或丢弃选择区历史，改变应用事件语义。

超出任一预算、sequence 耗尽、TTL 到期或不可恢复 transport 失败时，先撤销 lease
并关闭编辑，然后记录明确原因和实际消费/丢弃结果，释放有界队列。禁止静默截断
文本、drop-oldest、无界重试或等待未来 compositionend 来解除堵塞。诊断默认不含
密码和完整编辑文本；无监听器的密码值仍不得经几何或诊断通道外传。

<a id="native-defaults-focus-and-controlled-state-conflicts"></a>
## native defaults、焦点与受控状态冲突

业务输入门禁和 native 编辑许可必须分开。业务门禁关闭时，一般 pointer、tap、
confirm、query 和业务回调仍关闭；有效编辑 lease 只允许原 active editor 继续浏览器
输入、selection、composition 及其必要键盘默认行为。不能在此分支对所有 keydown
统一 preventDefault，否则输入法选择候选仍会被阻断。单行应用 confirm 继续过滤
真实 isComposing/keyCode 229，textarea Enter 继续由浏览器插入换行。

lease 不授权聚焦其他控件。呈现暂停期间，浏览器应阻止会转移到新控件的普通点击
或 Tab 默认行为；系统、窗口、辅助功能或用户造成的实际 blur 无法据此假装没有
发生。真实 blur 立即关闭本地 native 编辑许可，只可保留一个有界 terminal fact
等待有效最终 ACK；若 lease/receiver/hard fence 已失效，直接按明确结果丢弃。
closing lease 只能在期限内对仍存活的接收者完成一次末尾派发然后释放，不能继续
收集编辑或接受后来的续期。初始 focus 与后续真实 focus/blur 只派发一次；呈现
ACK、scope 更新和资源清理不产生合成 focus/blur，也不自动重新聚焦。

需要将旧的 `setInteractive()` 拆成业务派发开关与硬 native 撤销操作。普通 revision
不能对保留 surface 切 inert、改 pointerEvents/visibility 后再 focus。hard suspend
或 lease 撤销可以终止编辑；调用原生失焦前先发布本地撤销状态，重入 focusout
只能关闭既有 lease，不能发放或恢复权限。

受控属性采用明确冲突策略，不能凭 composition flag 任意拖延应用状态。runtime
还需要输出每个控件的单调 source version 和可信的 source-edit acknowledgement。
后者只能来自该 receiver 已消费的编辑事件及其同步数据更新，并要求新声明值确实
等于该条原生事实的值；浏览器不能自报“这是 echo”，任意 timer/async 写入也不能
自动继承先前事件的因果标记。转换过的值、无因果标记的写入或显式 reset 是受控覆盖。
这是一项新增实现要求，不能从现有 source-value 相等比较推断它已经存在。

例如已消费 sequence 10 的值为 `拼`，浏览器在等待呈现时已继续原生编辑到 sequence
11 的 `拼音`。应用对 sequence 10 的确认不能因与当前原生值不同而退回 `拼`、
结束 IME 或丢弃 sequence 11；它只推进已确认 source baseline。acknowledgement
不能超过 runtime 实际消费的序号，也不能跨 lease/receiver 或回退 source version。

| 变化 | 连续性和写入规则 |
| --- | --- |
| 规范化 source value 不变，本地 value 已变化 | 保留本地值；普通 revision 不回写 source、不写 selection |
| source value 更新且等于当前原生值 | 更新 source baseline；不执行等价 `.value` 写入 |
| 可信 source-edit acknowledgement 落后于较新的本地编辑 | 只推进已确认 baseline，保留较新 native value 和队列；不按旧 echo 回写 |
| 其余 source value 更新且不同于当前原生值 | permit 明确返回 end-and-apply；先退休 lease，再在 live commit 应用新值，不等待 compositionend |
| cursor/selection 请求与先前声明相同 | 不把静态声明在每个 revision 重放到原生选择区 |
| 新的显式 cursor/selection 请求 | 作为受控选择区冲突，先结束 lease，再按最终 value 的 UTF-16 范围应用 |
| disabled/type/password/语义身份改变、节点移除 | 结束 lease 后执行变更，禁止向后继转移本地编辑或组合状态 |

如果 permit 后、live apply 前 native value 又变化，浏览器必须按冻结的冲突规则
重新判定，不能悄悄把不同值当作 echo。需要改变 runtime 的 continuity 决定时，
取消该 permit 并重新准备，或使用合同中明确允许的 end-and-apply 降级结果；不能
借客户端布尔值扩大 permit。新的声明式 focus 能力不在这里隐式开放，当前严格
拒绝保持到其独立合同和证据完成。

<a id="state-transitions-rollback-and-cleanup"></a>
## 状态转换、回滚与清理

presentation 状态建议为 `accepted → preparing → permitted → applied →
finalizing → accepted`；任一尚未接受阶段可进入 `aborting`，结果不明进入
`uncertain`，硬失效进入 `retired`。editor 独立为 `none → active → paused`
（仅业务派发暂停，native 编辑仍有效）`→ active`，或进入 `closing/revoked/expired`。
lease 的 retired 状态单调，后继同名接收者只能持有新 grant。

| 失败点 | 可恢复内容 | 权限与资源处理 |
| --- | --- | --- |
| permit 前 | live tree 未改变 | 丢弃 staged patch，精确释放新资源；原权限是否有效仍由 runtime 决定 |
| apply 后、明确未 ACK | journal 能恢复的 DOM/样式/资源 | 恢复旧内容后重新测量；只有 runtime 明确确认 base 仍有效才恢复业务输入 |
| destructive editing change 后回滚 | 可恢复值和 DOM 表示 | 已结束的 IME、撤销栈或焦点不能声称恢复；旧 lease 不复活 |
| final 结果不明 | 保留已应用状态及所需前驱资源 | 输入关闭，查询原 final；不能推测未 ACK 或直接恢复旧 key |
| runtime 已最终 ACK | 新文档、实际 geometry 和接受身份 | 禁止回滚；前驱清理失败保留新图但输入关闭，报告真实 cleanup failure |
| hard revoke/shutdown | 可保留诊断画面 | 同步撤销所有 ingress，按所有权等待实际异步清理，不能等待编辑结束才撤销 |

journal 只承诺恢复所拥有的 DOM/样式/资源引用，不承诺逆转 native/CSS/网络副作用。
开始 apply 前完成可能失败的语义和结构校验；逐项记录已应用操作，即使中途抛错
也知道实际所有权。回滚失败进入 faulted/disabled，并保留可检查的 cleanup outcome；
禁止一边宣称恢复成功一边留下混合新旧 plan。

所有异步入口先发布 exact handle、状态、共享 promise 和 drain，再调用 resolver、
presenter、transport 或外部 callback。每次 await 返回后重新检查捕获身份，不从
可变的 latest/current 重新补 key。同步硬撤销优先于释放、onDiagnostic 和应用效果。
callback 返回 Promise 不能被当作同步 boolean fence；异常也不能授予输入。

ACK 的不可逆接受点先登记，再清理前驱。前驱资源 dispose、迟到 decoder、旧 abort
和 release timeout 只影响它们的 exact owner；不得移除新 plan 仍使用的节点、清空
surface listeners、改 successor.inert、释放 successor URL 或回滚新 receipt。
共享 surface 用明确借用/引用所有权及最后使用屏障管理，不靠“当前 iframe”查找释放。
保留既有 `releaseCandidate`／`drainCandidate`／`confirmAsync`／shutdown 的真实 drain：
超时表示 cleanup pending，不能伪装已释放。重入调用返回同一操作 promise，资源
只释放一次；真实迟到失败继续留在原 drain 和最终 shutdown 结果中。

<a id="concrete-implementation-gaps"></a>
## 具体实现接缝

- `dom-presenter.mjs`：把 `createBrowserCandidate()` 拆为 surface owner 与 revision
  candidate；替换 per-revision populate/snapshot/restore 路径，新增 typed diff/apply/
  rollback 和 live measurement。委托 listener/observer 留在 surface，事件的权威
  entry 随最终接受切换；普通 prepare 不再 hard-disable 有效 editor。
- `DomViewPresenter.prepare/commit/confirmAsync/abort`：v2 使用独立状态分支和合同，
  不更改 v1 的几何 permit 断言。精确 handle/receipt 和 cleanup 屏障继续保留。
- `dom-session-client.mjs`、`worker-dom-adapter.mjs`、`remote-dom.mjs` 及各自 transport：
  协商新合同、转交 runtime lease、分开普通呈现取消和硬撤销，绑定实际 final，
  管理有限 native-fact 队列与 ACK 不明恢复。不能只修改 presenter 来绕过 owner fence。
- runtime/host 的 browser presentation、receiver 和 observation 边界：保存有限 permit/
  lease/幂等记录，证明实际实例连续，原子接纳 live geometry 与最终 ACK，输出同步
  撤销事实。Worker 和 remote 都要实现相同语义，不从浏览器传入 topology 权威。
- 原生七宿主 adapter：分别提供真实编辑对象生命周期、焦点/键盘和释放实现。
  Web iframe 的节点稳定证据不能升级为 WKWebView、WebView2、WebKitGTK、Android
  WebView、ArkWeb 或 Skia native control 的能力与通过记录。

<a id="real-ime-evidence-requirements-after-implementation"></a>
## 实施后的真实 IME 证据要求

以下是后续必须执行的场景，不是已有通过项。单测可以验证状态、预算、reentrancy
和故障路径，DOM double 不能证明 composition。合成 composition 事件和手工写入
`isComposing` 只能验证过滤分支，不能作为原生连续性证据。

1. 在真实 runtime 驱动的 input 和 textarea 中保存实际 iframe、Document、节点和
   activeElement 引用。用真实操作系统输入法开始中文组合，在组合仍活动时由 Page
   handler/timer 执行无关 setData 并完成新最终 ACK，继续选择候选/输入。记录节点和
   Document 引用始终相同、无额外 focus/blur、真实 composition/native key 原始事件、
   最终值、选择区和 AppService 消费顺序。不能先结束 composition 再更新。
2. 覆盖多个普通 revision、bindfocus → setData、input echo、无关 label/CSS 变化、
   input 的 IME Enter 选择与随后一次非组合 confirm，以及 textarea 的原生换行。
   保留事件 `isTrusted` 等原始观测；浏览器 CDP 原生组合可作为明确标注的 browser
   辅助证据，不能替代操作系统候选窗口和七宿主的实际交互。
3. 在 permit、live apply、geometry/final ACK 等待、前驱异步 cleanup 各阶段继续
   原生编辑。核对队列 count/字节计费、全批预检、顺序、重复 final/flush 幂等性、
   新 geometry 先于派发，以及旧 key、旧 epoch、旧 receiver 的持续拒绝。
4. 注入准备失败、apply 中断、实际 geometry 拒绝、明确 abort、final 丢失、ACK 后
   清理失败、迟到 decode 与释放超时。区分可回滚表示和不可恢复编辑状态；已 ACK
   的新内容不得被迟到 abort/旧 disposer 清掉，native lease 不得被错误恢复。
5. 在活动组合中改变 source value、selection、disabled、type、owner/slot、key，
   移除/重建编辑组件，执行页面/renderer/owner 切换、逻辑 resize、hide、disconnect、
   TTL expiry 和 queue overflow。验证先撤销再副作用、受控值正确、无无限等待、
   无晚到事件/续期复活，也不把“明确结束编辑”记作连续性通过。
6. 对相同路由与 owner 的 A → B → A、缓存页返回和相同 occurrence 重用保存原始
   runtime 身份与序列。旧 lease、旧 queued facts、旧 receipt 必须拒绝。真实用户
   blur 后重新 focus 需要新 grant，不能因 Document 仍在而沿用旧权利。

每次证据需绑定精确源码/产物、host/runtime/engine/renderer、协商结果、owner/硬
输入 revision、permit/lease 状态、逐项检查、原始日志/截图及资源归属和清理结果。
文本内容按需要脱敏，密码不归档。执行人员或 browser owner 只关闭本任务资源；
报告失败和实际保留资源。完成这些实现与实测之前，原生跨呈现编辑连续性继续是
未实现、未验收能力；receiver 加固或本文存在均不改变这一状态。
