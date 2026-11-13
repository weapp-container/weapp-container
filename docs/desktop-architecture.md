<a id="cross-platform-desktop-architecture-and-next-steps"></a>
# 桌面跨平台架构与后续方向

**简体中文** · [English](desktop-architecture.en.md)

Weapp Container 需要同时支持独立模拟器和嵌入式 SDK。现有 Rust runtime、批量 bridge、
Skia renderer、平台 host 的分层符合这两个目标，建议继续保留。GTK、Flutter 和 winit
处理的是不同宿主的接入问题，不需要合并成同一个 GUI 框架。

<a id="current-boundaries"></a>
## 当前边界

```text
portable manifest / blobs
          │
          ▼
Rust Session：JS 引擎、页面栈、View、布局、渲染帧与输入权限
          │
          ├── 独立模拟器：winit + Metal / OpenGL / softbuffer
          ├── Desktop SDK：NSView / HWND / GTK 3 视图
          └── Flutter SDK：宿主控件与纹理接入
```

Session 是小程序状态的唯一拥有者。宿主处理事件循环、窗口、输入转换、drawable、
设备权限和资源释放。原生 GPU 路径向共享 Skia renderer 提供绘制目标，软件路径才
取得 RGBA snapshot。Flutter 外壳可以维护连接与设置界面，但不应再维护一份小程序
导航栈或按节点复制渲染状态。

Linux Desktop SDK 当前依赖 GTK 3.24，其父视图契约是 `GtkContainer*`。这限制的是
现有嵌入适配器；Rust runtime 和独立 winit 窗口不需要 GTK。GTK 4/Qt 宿主需要
对应适配器，不能把它们的控件指针当成 GTK 3 控件传入。原生父视图、外部纹理和
独立窗口也不能只靠一个未经类型区分的句柄互换。

<a id="current-implementation"></a>
## 这轮实现

此前独立模拟器只有 macOS Metal 原生 GPU 呈现；Windows/Linux 需要显式软件模式。
Desktop SDK 已使用共享 GL renderer，但独立模拟器没有对应窗口/context owner。

新增的 `container-host-desktop/gl-window` 使用 winit/glutin 创建 OpenGL 3.3 core
窗口：Windows 走 WGL，Linux X11 走 GLX/EGL，Wayland 走 EGL。它通过
`HostSession::attach_gl_context_with` 接入现有 renderer，把当前 retained scene
绘制到窗口 framebuffer，再执行 swap。GL resolver 只提供 GL 入口，避免 GLX/WGL
为 Skia 探测的 EGL 函数返回无效地址。该路径不引入 GTK，也不增加第二个 Session。

生命周期规则如下：

- 上下文、呈现、session 替换和销毁都在事件循环线程。热更新查询新 renderer 的实际
  GL attachment，随后重新绑定；不会用旧 session id 猜测它仍然有效。
- resize 清除输入几何和呈现标记。零尺寸窗口暂停呈现；恢复后重新绘制才能启用输入。
- 原生后端共用 revision ACK；只有运行时接受呈现回执后才公布输入坐标换算关系。
- 正常退出和事件循环错误返回均先 detach session，再释放 context、surface 和 window。
  context 无法绑定时 abandon Skia 句柄并返回错误；清理失败不能只打印后当作成功。
- 默认 GL 构造拒绝已知 CPU 驱动。`--software` 仍是显式软件选项。GL 提交及 swap
  成功不证明物理 GPU 执行、GPU completion 或屏幕扫描输出。

新增 X11 display 集成测试使用实际 GL drawable，检查像素、resize、session 替换和
detach，同时检查公开构造器拒绝软件 GL 驱动。测试允许 Mesa 软件驱动仅用于协议与
资源生命周期验证，Windows、Wayland、硬件 GPU 和性能需要独立验收。命令见
[桌面宿主说明](../crates/container-host-desktop/README.md#native-gl-windows-on-windows-and-linux)。

<a id="next-priorities"></a>
## 后续优先级

1. **先验收现有桌面路径。** 在 Windows 实机、Linux X11/Wayland 和 macOS 上执行
   同一套呈现、最小化、DPI 切换、热更新和关闭用例，记录实际驱动及运行环境。
   capability feature 的存在不能代替这些结果。
2. **收敛 GPU 生命周期契约。** Rust 独立窗口和 C++ SDK 可以各自拥有平台资源，
   但 context attach/detach/abandon、帧 revision、呈现阶段与输入权限必须沿用共享
   runtime 语义。增加更多后端之前，先用相同 fixture 验证两个入口的行为。
3. **补输入法与无障碍。** 键盘事件不能代替 IME composition，Skia 画面也不会自动
   产生系统无障碍树。需要把共享 View 语义分别映射到各宿主接口，避免平台层重建业务树。
4. **按实际消费者扩展嵌入能力。** 有 GTK 4/Qt 需求时，增加明确命名、独立构建的适配器，
   共享 Session 与设备 provider；宿主保留主循环，不强制改用 winit 或 Flutter。
5. **用测量决定新 GPU 后端。** OpenGL 3.3 是复用现有 Skia GL 接口的首步。
   若驱动覆盖、延迟或部署要求证明需要 Vulkan/Direct3D，再实现其资源与同步边界。
   当前的 `vulkan` / `direct2d` feature 名称本身不代表已经实现对应 presenter。

后续抽象应从至少两个已实现后端的共同约束中提取。现阶段新增一套通用 GUI 层或另一个
JS/Go runtime，会增加线程、对象所有权和构建分发成本，无法直接补齐上述能力。
