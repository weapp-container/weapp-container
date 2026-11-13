<a id="weapp-container-scrolling-fixture"></a>
# Weapp 容器滚动测试fixture

**简体中文** · [English](README.en.md)


此源应用程序包含两个独立的滚动视图，两个轴方向均启用，由数据驱动的滚动命令，滚轮和触摸输入，坐标点击，选择器几何结构，交集观察，页面滚动和导航清理。其彩色矩形使得移动和裁剪可以在实际渲染像素中进行量化测量。

运行 `node scripts/scrolling-smoke.mjs --help` 以触发固定编译器 → 可移植
打包 → 原生 QuickJS/V8 回归测试。烟雾测试调用编译应用自身的事件处理器。
观测结果由应用写入 `scroll:query` 和 `scroll:taps` 存储键，然后通过真实的 `wx` 提供商读取。
它从不注入预期的页面数据或手工构建的渲染帧。
这是本地合规性的证据；并未暗示需要新的官方 DevTools 或设备测试结果。

A 滚动视图的普通 `bindtouchmove` 处理程序调用 `stopPropagation`；其默认拖拽仍会滚动。C 滚动视图在页面滚动后显现，使用 `catchtouchmove` 并记录处理程序而不调用 `preventDefault`；该拖拽必须使 C 及其祖先元素保持不变。

```sh
node scripts/scrolling-smoke.mjs \
  --simulator-bin target/debug/weapp-simulator \
  --compiler-root /path/to/isolated/pinned/weapp-vite \
  --compiler-dist-hashes /path/to/independent/compiler-dist-sha256.json \
  --out artifacts/scrolling.json
```

编译器源码会与仓库子模块锁定的每个 Git 对象进行比对，并单独记录显式声明的 CRLF 转换。
在编译前后，会使用独立编译构建提供的 SHA-256 映射表对编译器发布版本进行比对。该命令重用该编译器及其已安装的依赖项；它不声明新的编译构建或依赖项安装。仅构建临时项目副本。

第一页故意与第二页共享 `.control` 类名。路由样式选择必须确保第二页的声明不会出现在第一页中；重命名类并不能解决宿主样式表泄漏的问题。
