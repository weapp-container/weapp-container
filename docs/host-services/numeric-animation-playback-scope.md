<a id="range-of-numerical-animation-playback-implementation"></a>
# 数值 Animation 播放实现范围

**简体中文** · [English](numeric-animation-playback-scope.en.md)


本批把 `animation` 属性接入 Session 的受信时钟、绑定身份和呈现事务。此前共享
`animation.js` 只能记录与导出动作；现在有限数值动作可以在原生渲染场景和 Web DOM
上消费同一份时间线采样。本文记录实现策略及有限验证范围，不能据此推定微信基础库 3.17.3 的完整行为。

固定分母仍为 1265 API × 七端，共 8855 格。当前基线为 Available 1504、Partial 1070、
Requires host service 86、Missing 6195、Accepted 0。本批不晋级任何格；12 个数值方法
对应的 84 格仍为 Partial，其他 Animation 方法、工厂、`step` 和 `export` 也保留原等级。

<a id="timeline-and-value-ranges"></a>
## 时间线与数值范围

播放解码器接受共享 producer 导出的 `actions → animates/type/args + option` 结构。
支持 `opacity`、`rotate`、`rotateZ`、`scale`、`scaleX`、`scaleY`、`skew`、`skewX`、
`skewY`、`translate`、`translateX`、`translateY`。数字必须有限，opacity 范围为
`[0, 1]`。3D 变换、长度字符串、宽高与定位等布局动画尚未进入这条播放链；队列含有
不支持的动作或字段时整体拒绝，不能只跳过该动作后声称成功。

同一 step 的动作同时过渡，不同 step 顺序执行。支持 `linear`、`ease`、`ease-in`、
`ease-out`、`ease-in-out`、`step-start`、`step-end`，包括 delay 和零时长；贝塞尔曲线
按 x 反求进度。每轴最后一次写入覆盖同组前值，`rotate`/`rotateZ` 共用旋转轴，未写轴
沿用前一组端点。这些重复动作与别名策略属于容器当前约定，尚无固定微信版本的
逐项 oracle 证明。

变换端点保存平移、旋转、缩放与 skew 的数值，按 `T × R × Scale × Skew` 合成。
每次采样从原端点计算，不逐帧积累矩阵。已有二维 CSS 矩阵通过 QR 分解建立基线：
X 缩放取非负值，Y 保留符号；可重建的 rank-one 和零矩阵可用，数值不稳定且无法在
检查精度内重建的矩阵明确拒绝。skew 穿越极点和不可靠的大角度也拒绝。合法端点仍
可能在中间采样溢出，因此发布前必须完成整批采样与验证。

opacity 读取真实的已解析基线；不能假设为 1。只改 opacity 的队列不会读取或覆盖
无关的 transform，现有 matrix3d 因而不妨碍单独 opacity 动画。新触及的 transform
必须能取得实际二维仿射基线。`transformOrigin` 复用 WXSS 解析路径，保留来源字符串，
由正常字体、视口和 border-box 规则解析；支持可解析的二维 origin，规范化
initial/unset，拒绝 inherit、延迟解析值和非零 z。origin 在本组 delay 结束时离散切换，
后续组等待期间保留前组 origin。

每份队列最多 4096 step、16384 operation、4 MiB JSON 载荷和 24 小时累计时长；
origin 字符串最多 4096 字节。Session 同时保留的绑定/运行最多 4096 个；聚合绑定载荷
和写入身份另有 8 MiB 限制。这些是显式资源策略，不代表 JS 引擎总内存上限。

<a id="binding-replay-and-owner"></a>
## 绑定、重播与 owner

View/IR 在求值时记录私有的属性来源、数据依赖和源码 occurrence，Session 在读取数据
时同步抓取 Page/Component incarnation 与写入快照。直接路径、实际执行分支、动态
成员选择及其控制依赖、`wx:for` 集合索引别名、include，以及 template 的直接对象
别名/shorthand/spread 可以携带来源；构造标量、条件或计算的 template 映射保守拒绝。
WXS、模块与外部可执行依赖尚不提供来源，不为收集来源二次执行用户表达式。公开
属性、导出对象或 bridge 参数不能选择 owner、写入 stamp 或动画时钟。无法还原来源
的动画绑定必须明确拒绝。

接受记录比较解析后的数据路径与写入 stamp。普通重渲染继续同一条已接受时间线；
对相关路径再次成功 `setData`，即使队列值相等，也能形成新的播放。路径身份随真正
来源转发到组件输入，组件本地写入接管相应路径直到外部属性更新；父子、同名局部
变量和不同 incarnation 不共用播放身份。slot 复用既有声明所有权和缓存来源快照，
本批尚无新增真实 slot 专项回归。没有成功相关写入时，单独改变 payload 不触发重播；
同值 stamp 不额外触发普通 observer/dirty mutation。数据写入前先预留身份，数据
事务成功后提交；
预留或私有回执失效会阻断本 Session 的后续动画，不能以不可信公开 effect 补造来源。

替换动画先在准备阶段抓取旧动画的数值样本作为新起点；新增加的属性才读取实际
CSS 基线。基线回复必须覆盖精确 occurrence 和请求属性，不允许缺项、重复或多项。
父元素的旧采样先参与正常层叠，再为新触及的子元素计算 inherit 基线。空动作队列
冻结这次抓取的样式；移除绑定则移除动画覆盖层。

显式 native frame 或携带显式 data 的模板替换没有实时 Page 输入证明。它们真正被
接受呈现后会退休旧拓扑的节点身份与运行，保留私有写入账本和 Page 暂停状态；后续
同源码重新出现的节点重新建立基线。失败候选和迟到 ACK 不提前退休已接受绑定。

<a id="clock-presentation-and-lifecycle"></a>
## 时钟、呈现与生命周期

动画时间来自 Session 单调时钟。每次宿主 turn 固定一个采样时刻，嵌套调用复用它；
guest timer 时间戳、公开配置与 WASM 导出均不能推进时钟。测试控制时钟仅在
`cfg(test)` 内可见。

准备新动画时先生成 elapsed 0 的样式，真正接受呈现后才锚定起点。异步准备、浏览器
布局和等待 ACK 的时间不先吃掉播放时长；失败候选不能安装时间线。旧动画的正常
重渲染保留原 anchor。每页隐藏时暂停该页时钟，恢复后继续；Page、Component scope、
Session 退休及来源失效都会封锁旧候选与迟到 ACK。

独立 `sampleDemandRevision` 只表示采样需求，不能替代模板、文档、呈现或输入身份。
该字段在首次成功接受动画发现后启用，旧路径保持原状态形状；失败发现不安装新 lane。
候选携带冻结的 `{ demandRevision, sampleRevision }`，一次准备不能在 ACK 时换成
更新需求。新的需求在精确旧候选释放后合并，不能中止旧样本后为其改名。采样序列和
需求序列各自验证，不假设二者具有数值大小关系。需求约按 16 ms 产生，并补一次准确
终点；实际呈现频率仍取决于宿主 poll 与呈现泵。

原生采样复用已接受的原始声明场景，重新执行正常样式、布局、图片授权和 Canvas
声明准备，再原子发布新 renderer revision；不重新执行 View/WXS 或 ready hook。
Software raster 在实际接受时提交，external frame 与开发者呈现路径等待对应 ACK。
输入和组件快照沿用原模板接受记录，不能顺便采纳准备之后的数据。density、scroll、
Canvas 和开发者 resize 等既有重绘只在精确输入/前版关系成立时携带原采样证明。

Web 在语义准备时消费具有精确 baseline occurrence 和 typed 绑定的 `animation`，并从
浏览器计划中移除原始值。上游已求值的七类 `wx:if/elif/else/for/for-item/for-index/key`
也只作为来源保留，不投影为 HTML 属性，不再求值；未知 `wx:*` 继续拒绝。Worker
采样统一 `preparePaint(demand, accepted, context)` 三参合同，以私有最后真实 ACK
proof 和 client retained key/input/authority 校验前版。输入版本可领先 captured demand，
采样回复必须保持精确前版输入。缺少元数据的 null/空字符串 animation 绑定仍不支持。

Web 的首个模板候选在隐藏布局中读取真实 computed style、应用冻结数值样式，再
按正常几何与呈现事务接受。后续样本保留同一个已接受 DOM 与 documentRevision，
只递增 presentationRevision；浏览器负责验证目标、原子样式写入和几何回传，不负责
推进时间或插值。应用失败按 undo 恢复旧样式，恢复失败保留 cleanup 错误并阻断成功；
ACK 后样式不能回滚。旧拓扑、epoch、输入与 permit 不能授权新样本。scheduler 只有
在真实模板或样本需求推进时重试，
失败水位不能靠 ACK 附加字段伪造刷新。

首次模板与保留样本共用精确终态清理规则。向 runtime 发出 presented 请求后，本地
超时和取消不能单独决定回滚；清理先用 exact-key abort 查询终态。runtime 保留有界
的已呈现 final 或已中止 tombstone：已呈现回复包含原 permit 或 consumedSample，
只证明历史接受，输入恒关闭；已中止才允许本地回滚，迟到 presented 不能复活它。
传输或终态未知时保留已应用样式、DOM 和资源，阻止普通及 legacy successor，关闭
过程报告未完成清理。重连可重新查询，真实 native presenter retirement 可授权新一轮
排空；此前失败的清理 Promise 保留失败结果。已验证 ACK 先同步封存本地 journal/key，
再调用输入守卫、前版资源释放与激活，守卫抛错不撤回已接受图像。

保留 DOM 样本继续使用该 DOM 已持有的资源租约，不新读图、不换文档、不安装资源；
它不构成一次新的 BufferURL consumer。原生保留场景产生新帧时仍经过正常图片准备，
新的 Skia/cache 读取复核当前 BufferURL 权限。撤销后已发布不可变帧/DOM 的既有租约
保持原有 last-use 生命周期，不能把这一点扩大为对新消费者的授权。

<a id="final-verification-scope"></a>
## 最终验证范围

v3 完成 fmt、workspace all-targets check、all-features 严格 Clippy、runtime all-features
lib 和四线程 workspace。runtime 为 757 passed/0 failed/2 ignored；workspace 为
132 个结果块、2999 passed/0 failed/10 ignored。命令有重叠，不能相加为独立测试数。
v8 的 Rust 输入与 v3 字节一致；源码差异单列在证据中，没有声称 v8 重跑全套 Cargo。
此前标准并行的 View/native_query 截止时间失败仍未归因，四线程通过不改写历史失败，
也未放宽截止时间或断言。

v8 Web Node 979/979、清点/矩阵/IO 539/539、实际矩阵生成及 --check 通过。回归包含
modern View VM 实际求值后保留结构指令的文档、精确动画元数据与错误 occurrence、
原始属性不进入浏览器投影、CSS animation/transition 拒绝、ACK 取消与终态结清。
真实 owner/RPC/bridge/scheduler/DOM adapter/client/presenter 的组合回归还覆盖保留 ACK
连续采样，以及 show 原生观测早于本地可见状态更新的竞态。生命周期控制期间暂停调度，
仅真实 final 和本地控制栅栏都就绪后恢复；旧 show 不能覆盖更新的 hide，metrics 和
surface recovery 的现有栅栏继续生效。

217 个完整 cell 对象更新 31 条 Animation 的七端实现范围、源码引用和缺口说明，
其余 8638 个对象不变。
8855 格的状态、验收、coverage 和责任未变，CSV/合同/ledger 字节未变。当前
可用 1504、部分 1070、需要主机服务 86、缺失 6195、已接受 0、
N/A 87，距 7084 仍差 5580，本批 Available 增量 0。

干净私有构建快照为 `2a9889589eceee0d90e60f9944e5589e89de34de`，494 项编译输入摘要为
`040e2da5570e16d82fa16644c054920b860e36ff78d0cf01f4c67ac6fa9ee833`。
该提交仅标识私有输入，不是父仓库产品提交。实际 QuickJS/WASM software renderer 的
legacy/Worker release、tar.gz 归档、全新目录安装及独立 2084 项输入字节核验通过。
复用既有 Cargo target，不声称全新 target 或环境完全可复现。六份既有 tracked notice
在 v8 构建前进入私有提交，独立于 494 项编译输入；v3 曾在构建后补 notice 并使用
后继 license 链，其原始失败和补充范围均保留。

Chrome 156.0.8078.80 headless 的实际安装产物执行通过：direct 8 项、生产 Worker 6 项。
场景覆盖 CSS 初值、中间/终点数值与 hit geometry、保留 DOM 身份、同值重播、替换、
旧 ACK 拒绝、节点移除，以及 direct 中实际 runtime 已接受但 sample/template ACK
回包被取消后的精确终态结清。Worker hide/resume 只证明本 fixture 的有限输入恢复，
不扩展为浏览器全生命周期 oracle。两 lane 使用手写并重新计算摘要的 synthetic fixture，
没有上游构建或公开 SDK 验收。严格 pageerror/requestfailed 均为 0，包括清理阶段；
page/context/browser/Worker/server 全部关闭，9187 端口已核对关闭，没有保留页面。

v1 QuickJS 原型 setter、v2 IR 数值 key provenance、v3 animation 属性拒绝、v4 wx:if
属性拒绝和 v5 Worker 三参接口漂移保持各自失败。v5 direct 8 项通过按该 lane 保留，
不改写 overall failed。v6 的中间 pin 清点失败后未构建或运行浏览器，Node 记录保留
来源竞态限制。v7 首轮清点的旧接口 token 失败与后继 868/539 检查分开保留；其浏览器
为 direct 8 项通过、Worker 4 项后 resume 超时，overall failed。v8 沿用相同 fixture、
断言和时限，重新冻结、构建、安装及执行；后继通过不覆盖失败记录。完整源码绑定、
日志和失败/后继关系见[本批证据](../archived-evidence.md)。

官方资料只支持默认值、七种 easing、同组并行/跨组顺序和 export 清队列等有限描述。
别名与重复动作排序、同值重播、未 step 动作导出、替换中断、hide/resume 和精确呈现
起点仍缺固定 3.17.3 oracle。源码 pin、测试和 synthetic 浏览器执行不替代七端公开 SDK、
设备或商户验收；全部 Animation 仍为 Partial，Accepted 为 0，80% 目标继续 active。
