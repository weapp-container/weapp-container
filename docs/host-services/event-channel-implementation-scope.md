# EventChannel 与 Console 分组的实现范围

EventChannel 的四个方法 `emit`、`on`、`once`、`off` 为 AppService realm 内的真实
同步调用，函数和对象引用不跨 native JSON transport。wx.navigateTo 的 events 在
出发页注册；导航 success/Promise 结果与目标页 getOpenerEventChannel 返回同一通道。
无 opener 时返回官方 EmptyEventChannel。Page 和 Component 实例均安装公开 getter。

通道按原 engine 请求 ID 与实际目标 page instance 绑定，在 onLoad 之前完成；即时
和 trusted-page-mirror 延迟提交两条路径都已接入。相同 route 的多次实例保持独立。
绑定函数是 bootstrap 返回并由 QuickJS/V8 捕获的私有 native handle，guest 全局同名
函数替换不会改写它。目标页面或出发页面卸载后关闭关联通道，保留的通道句柄拒绝后续
调用。observer 清理失败也不能跳过通道关闭，且保留既有卸载错误。

每个 realm 最多 256 个活通道，每通道最多 128 个监听与 64 条未接收事件，每次 emit
最多 32 个参数，递归深度最多 64。once 在调用前退休，支持递归、off 和注册期间事件
缓存。私有索引/数组和捕获内建函数不依赖 guest 原型。序列化准备在分配通道前完成；
失败的 wire/Promise/enqueue 不保留 pending 或活通道额度。超额明确失败。

Console group/groupEnd 使用已有 opt-in 诊断队列，跨 drain 保存分组和缩进，层级上限
32，关闭诊断后清空状态。队列仍受原条数/字符背压预算限制，不执行属性 getter 或
用户 JSON hook，不充当 LogManager/实时日志服务的虚构实现。

双引擎原语、即时导航和延迟布局提交的有限测试不能代替从新归档安装的公开 SDK 链。
legacy 即时导航仍沿用既有可变 page table/current setter；完整的公开 mirror 防篡改
保证只适用于 trusted-page-mirror 延迟路径，不能据私有 binder 一项就推广为两模式的
完整 trusted-owner 安全保证。未声明新的严格身份/consent 能力或提升 API 验收状态。
