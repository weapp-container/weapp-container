<a id="wxss-visibility"></a>
# WXSS 可见性

**简体中文** · [English](visibility.en.md)


运行时在组件和插槽投影之后解析 `visibility`。被接受的节点在 `RenderNode.visibility` 和 `computed_style.visibility` 中携带相同的解析值；绘制、命中测试和原生组件呈现均使用该值。

| 声明 | 结果 |
| --- | --- |
| `visible`, `initial` | 可见，包括在隐藏的祖先元素下 |
| `hidden` | 隐藏此节点的背景、边框、文本和图像 |
| 缺失、`inherit`、`unset` | 继承组合父元素的可见性 |
| 无效值 | 在级联比较前丢弃 |
| `collapse`, `revert`, `revert-layer`, 有效 `var()`/`env()`/`attr()` 替换 | 保留获胜声明，然后在场景准备期间返回 `ERR_UNSUPPORTED_CAPABILITY` |

隐藏节点保留其布局框、选择器成员关系和几何信息。一个可见的后代会保留其祖先的变换、裁剪、堆叠和组不透明度。它可以接收指针输入，并能通过隐藏的祖先传递；但隐藏节点不能是直接的命中目标。一个替换失败的节点保留之前已验收的帧、渲染修订版本和像素。

解析器保留如 `var(--empty) visible` 这样的组合替换以及平衡的嵌套备用令牌，直到计算值处理阶段。它不评估属性值标识符中的替换或解码 CSS 转义。布局和完整的 CSS 可见性支持仍超出本范围。

旧的带类型帧如果省略了 `visibility`，在反序列化时会被视为可见。可见的带类型字段在序列化时会保持省略；隐藏的值会显式序列化。直接的帧生成器为每个节点提供解析后的值，包括位于隐藏父节点之下的可见覆盖值。添加公共的 Rust 字段需要外部的 `RenderNode` 结构体字面量显式包含该字段。运行时帧 JSON 现在包含解析后的 `computed_style.visibility` 值。

CanvasKit 验证输入的值和匹配的计算样式条目。其提交的绘制计划和传统遍历在保留隐藏上下文的同时，省略了隐藏的自身笔迹。显式空值、未知值、冲突的样式映射、隐藏的绘制命令以及缺失的可见绘制命令均被拒绝。

验证涵盖解析器/级联、SoftwareRenderer、CPU Skia、实际 QuickJS 和 V8 Page.setData、选择器值、像素、输入以及失败帧的保留。
固定版本的 CanvasKit 0.42.0 CPU 测试套件还检查了隐藏半透明上下文内可见图像的变换和裁剪情况，涉及两个绘制路径。两个引擎的密封原生帧已由真实的 CanvasKit CPU 后端消费。
官方槽位案例、原生窗口呈现、WebGL/GPU 以及七宿主兼容性仍需各自独立的执行证据。

```sh
cargo test -p container-runtime --test visibility \
  --features quickjs-native,v8-native,skia-backend --locked -- --test-threads=1
WEAPP_CONTAINER_TEST_CANVASKIT_DIR=<fixed-0.42.0-package> \
WEAPP_CONTAINER_TEST_CANVASKIT_FONT=<pinned-NotoSansSC.ttf> \
  node --test scripts/canvaskit-presenter.test.mjs
```

CanvasKit 测试在运行 CPU 检查之前，会验证确切的包、JavaScript、WASM 和字体哈希。
