# TCP/UDP 对象监听移除的实现范围

产品提交：`617862ab39b98bcc379c1a5c5f4fc9c1deafed45`。固定统计口径为微信基础库 3.17.3、miniprogram-api-typings@5.2.3，1265 API × 七端 = 8855 单元。本批只将以下九个 off 方法的 63 格 Missing→Available：

- TCPSocket：offBindWifi、offClose、offConnect、offError、offMessage。
- UDPSocket：offClose、offError、offListening、offMessage。

完整矩阵另有 8792 个完整 cell 对象不变。Available1777（20.07%）、Partial1308、RequiresHostService86、Missing5684；accepted0、platformNotApplicable87，距7084仍差5307。验收、coverage、责任、限制、参数合同及 ledger 字节未变，阶段 goal 保持 active。on、工厂、TCP.close、UDP.close 和广告对象没有新增信用。

## 单一回调所有者与真实取消

九组实际 on 回调迁入已有私有 finite owner，按工厂对象、API、事件和订阅 ID 分开。原函数重复注册去重；off 选择原函数删除，省略或 undefined 清空当前对象/事件，重复移除幂等，同步返回 void。保存的别名绑定原创建者，改变 this 不能改指向其他对象。off 有自己的准入，不依赖 on/off provider，不额外调用 close/destroy 或取消工厂请求。

私有 authority 先同步撤销，Session 随后取消原生订阅的实际 creator call，成功完成清扫后才给 retained 前缀 ACK。晚到事件、订阅成功/失败和先 off 后 on 的排队竞态不能复活旧 identity。全局注册拒绝非空 objectId；对象注册必须绑定真实存活的 native receiver type。Session、account epoch、API、object、event 与 u64 sequence 检查都在回调 payload 解码之前。

## 对象生命周期和结算故障

TCP.close 只结束连接，保留 socket 对象；UDP.close 成功后销毁对象，失败保留。等待中的 UDP close 仍允许最后一个 Close 事件。off 本身不改变这些生命周期。

工厂失败、UDP 成功销毁以及 native 终态资源清理，通过两引擎保留的 typed ingress 在公开 Promise 结算之前退休私有 owner。退休同步清空回调、关闭并删除 bridge 对象记录。公开 resolver、Promise.then、事件队列或 facade 被应用替换，不得保留已退休回调。新私有状态与对象记录使用无原型存储，避免继承 setter 捕获退休权限。

通用 finish_host_call 收集首次清理错误，继续取消其余真实 creator，再尝试外层结算并返回错误。该修改涉及共用异步资源边界，因此本批同时执行完整 runtime/workspace 与 feature gates。

## 实际验证与首轮失败

根实际通过 Node146/146（其中新文件40项）、相关回归198/198、清点/矩阵/IO1275/1275；Node 的两个生产组合标签不代表 native engine 执行。真实 QuickJS/V8 的三个集成文件分别有原7、新11、普通9个 test 函数，每个循环已启用引擎。重叠命令不合计为独立测试总数。

格式、workspace all-targets locked check、全部 features 严格 Clippy 均通过；无 native feature 编译通过并保留 36 条 warning。runtime 全特性库 758 passed/0 failed/2 ignored；完整四线程 workspace 135 个结果块、3067 passed/0 failed/10 ignored。以上命令有重叠，不累计成唯一测试数。

生产 WASM 检查显式选择已安装 rustup cargo/RUSTC/RUSTDOC、LLVM C 工具链及 wasm,quickjs-native，不使用缺少对应 target 的 Homebrew Rust。它是编译检查，没有本批 Web release 构建、归档、安装产物或浏览器执行。

首轮 Node144/146、Rust E0282 失败完整保留。Node 原用例在挂好 hook 后污染 Promise.then，却通过公开 raw resolver 结算，先在夹具自身调度处失败；后继改为在 hook 挂接前污染，并仅为 raw 结算恢复调度，实际 Session 同时覆盖 poisonResolve/poisonThen × 工厂失败/UDP 销毁四组合。Rust 后继明确 Vec<String> 类型。两处只改新测试，八个生产源与两个 inventory 文件仍等于封存候选，独立后继复核通过。

库存作者的首次699/702失败、修正后1247/1247和静态来源审查分别保留。根的1275项实际复验包含矩阵/IO，不能把库存-only执行冒充 API/native 运行。

## 来源、产物与验收边界

产品只改14个明确路径；全部1778个最终非文档源码及两份矩阵与产品 Git blob 逐字节绑定，其余源码保持原字节。七个 gitlink、913个历史文件、默认 checkout 本地 main 未改。52个额外 SDK 输入另行绑定到当前字节及精确 gitlink；本批没有改 SDK main、生成 native SDK 归档或生产发布。封包保留源码作者59份、库存348份、独立审查、根的失败/后继和完整原始命令日志；历史父包按已提交 parent 记录，不重复声明其全部历史 raw 文件均包含在本包。

Available 信用只属于本地监听移除和真实订阅取消。完整事件 producer、固定版本 payload/时序/插件行为、七端已安装公开 SDK/物理设备/微信 oracle 验收未由这些测试证明。Ads 六项 off 仍需独立的 Page ownership 和 RewardedVideoAd singleton/multiton 设计。

本批没有创建或借用浏览器、Worker、预览服务器。全部根测试进程在封包前结束；无保留页面。历史 affine 浏览器失败保持原结论。

完整证据见 [本批封包](../archived-evidence.md)。后续 Performance 私有 owner 仍是独立工作；全部六个列表查询继续 Partial，未完成 route/render/resource/package producer 前不授予信用。
