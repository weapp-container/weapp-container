<a id="transform-interaction-mini-program"></a>
# 转换交互小程序

**简体中文** · [English](README.en.md)


这个原生小程序通过真实页面处理器，驱动 typed 2D 变换，支持 `setData`、WXSS、选择器查询、坐标输入和沙箱存储。它使用固定绑定的 `vendor/weapp-vite` 构建工具，没有捆绑运行时依赖。

```sh
pnpm --dir vendor/weapp-vite exec wv build \
  "$PWD/examples/apps/transform-app" -p weapp --outDir dist
pnpm container:pack -- examples/apps/transform-app/dist \
  --out artifacts/transform-app/pack \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
cargo run -p container-simulator -- \
  dev --project examples/apps/transform-app --surface web
```

舞台从页面坐标 `(0, 0)` 开始，大小为 `320 × 280` CSS 像素。
视口宽度至少为 320 像素。坐标是页面/客户端逻辑像素，而非物理设备像素。导航栏位于此合同之外。

| 阶段 | 操作 | `#box` 边界矩形 `(left, top, width, height)` | 内部样本 |
| --- | --- | --- | --- |
| 小 | 初始 | `(134, 104, 52, 32)` | `(150, 112)` 蓝色 |
| 大号 | 在 `#box` 上点击 `(150, 112)`，或点击 `#toggle-size` | `(114, 94, 92, 52)` | `(150, 112)` 绿色 |
| 更小一些 | 点击 `(150, 112)` | `(134, 104, 52, 32)` | `(150, 112)` 蓝色 |
| 旋转小 | 点击 `#cycle-transform` 一次 | `(134, 136, 32, 52)` | `(150, 160)` 蓝色 |
| 无变换 | 再次点击 `#cycle-transform` | `(160, 120, 52, 32)` | `(176, 136)` 蓝色 |
| 重置 | 点击 `#reset` | `(134, 104, 52, 32)` | `(150, 112)` 蓝色 |

内容大小为 `40 × 20` 或 `80 × 40`；边距和边框为每个维度增加 12 像素。`-50%` 的平移使用最终的边框盒。初始红色边框示例：`(134, 116)`。初始黄色角点：`(138, 108)`。白色外部示例：`(132, 112)`。控制中心坐标为 `(52, 22)`、`(148, 22)`、`(244, 22)`。静态顺序探测器有红色矩形 `(60, 220, 40, 10)` 和蓝色矩形 `(210, 220, 40, 10)`，用于区分平移/缩放函数的顺序。

`data.taps` 仅记录尺寸变化；`data.lastTarget` 记录实际的事件目标，点击黄色角落会将目标设为 `corner`，在冒泡到框处理器之前。每次接受尺寸/模式/重置变化都会写入 `transform-app-state`，内容为 `{large,width,height,mode,transform,taps,lastTarget}`。`onInspect` 查询已接受的 `#box` 几何信息，并将保存的值复制到 `data.persisted`。它可以在宿主发布新帧后显式调用；`setData` 回调中的选择器查询仍可观察到之前发布的帧，直到该宿主边界完成。`data.lifecycle` 记录应用/页面钩子，与视觉变换状态无关。

固定的官方目标是 DevTools `2.02.2608080` / 库 `3.17.3`。
打开一个预构建的测试用例、进行本地像素检查，或 CanvasKit 重放本身并不能确立官方的视觉一致性，也无法实现物理 GPU 运行或设备级一致性。
官方自动化必须使用真实的授权 AppID，并遵循仓库中单窗口机器租用和自有资源清理规则。
