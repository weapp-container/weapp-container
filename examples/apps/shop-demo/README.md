# Morrow Supply 跨端商品流 Demo

这是一个离线电商演示，用来验证同一份 portable pack 在 Web/WASM、桌面、Android、iOS Simulator 和 HarmonyOS 宿主中的页面、导航、事件、存储和渲染边界。

商品、图片、购物车和订单都是本地数据。示例不调用网络、登录、支付或设备权限 API，因此所有宿主都可以运行同一份输入。

从仓库根目录执行：

```sh
pnpm demo:shop:package -- --out artifacts/shop-demo
pnpm demo:shop:browser -- --out artifacts/shop-demo-browser
pnpm demo:shop:test
```

`demo:shop:package` 会生成一个 portable pack，并在 `artifacts/shop-demo/package-report.json` 中记录 Web/WASM、桌面、Android、iOS Simulator 和 HarmonyOS 的 `passed`、`blocked` 或 `failed` 状态。缺少本机 SDK/工具链时保留为 `blocked`，不会借用旧产物。

浏览器验收覆盖首页、详情、加入购物车、数量调整、结算、订单完成和刷新后的购物车持久化，默认测试 375×667 和 1024×768。原生构建结果只表示对应平台的编译/打包边界通过；设备、GPU 和物理 iOS 安装仍需独立证据。
