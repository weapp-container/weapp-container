# Web 画面容量预留

`WebSurfaceHandle::reserve_frame` 预分配候选 RGBA、二进制响应与账本容量，返回不持有 Web mutex 的租约。应用 hook、绘制和像素转换期间，同一个 surface 仍能处理 HTTP、诊断与其他发布。租约保存已检查的 publication epoch、transport session 和下一序号，但不提前消耗序号。

完成应用与绘制工作后，`prepare` 才取得最终发布锁，重新验证身份和预算。其他画面、设置、profile、session 或退休操作会使旧租约明确失败；普通状态读取和诊断不改变画面身份。成功得到 `PreparedWebPresentation` 后，调用方才能执行 runtime 的无失败接受，再调用 `install` 移动已经准备好的字段。不能先接受 runtime，再处理可失败的 Web 准备。

## 容量与释放

候选通过私有 Weak 账目计入同一个 64 MiB 预算，包括实际 response/source capacity、账本、捕获字符串和有界 metadata 费用。Raster、CanvasKit 和 HTTP／资源响应都计算尚存活的租约；最终准入在登记字节的同一锁内复查。仅排除当前 Arc 对应的费用，不能根据可重复的 session／generation 值排除其他候选。

取消不获取 mutex，预算凭据晚于候选分配释放，包含 store poison 和早期校验失败。候选与短暂退休的 source 账目分别限制为 16 项。安装时旧页面大资源先移动出 Shared，释放 Web guard 后再销毁；在解锁至销毁的短窗内，旧 Raster source 仍由预分配的退休凭据计费。慢客户端持有的响应／资源继续由原 Weak response 账目计算。

这是 `PreparedWebPresentation` 的释放保证。旧的独立 setter／retirement API 保留原有行为；本改动没有让所有 Web 操作都具备共同发布语义。

## 验证范围

源码测试覆盖同 surface HTTP 重入、并发发布与 ABA、预算和真实队列准入、取消／poison、序号与 epoch 耗尽，以及实际安装和取消窗口的释放顺序。执行通过必须另行绑定主仓 commit。

此接口不回滚应用效果，不启用开发态 Raster 精确回执，也不完成逻辑 resize owner。resize hook 的一次性执行、旧宿主镜像修复、画面共同接受和浏览器实际呈现仍需联合接线，不能据此授予 GPU、性能或七宿主通过。
