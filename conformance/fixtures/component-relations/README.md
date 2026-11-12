# Component relations fixture

这是手写的原生微信小程序输入，不是 `weapp-vite` 的编译产物。直接打包时必须使用
`--compiler-commit unknown`；不能把当前 submodule 的 SHA 当作这个 fixture 的来源。

从仓库根目录启动独立开发页面：

```sh
cargo run -p container-simulator -- dev \
  --project conformance/fixtures/component-relations --surface web \
  --host 127.0.0.1 --port 5181
```

准备固定 vendor 的依赖与构建器后，该命令通过正常 watch 管线编译这个源码项目。
点击红色子组件会变蓝；Remove 将其移除，Restore 创建一个新的红色子组件。
这里的开发构建证据与下方 raw pack smoke 分开记录。默认不打开浏览器；访问启动日志
显示的本机 URL 即可，退出使用 Ctrl-C。桌面入口在相同命令上增加
`--features desktop-window`，并将 `--surface web` 改为 `--surface desktop`。

不经编译器的独立 conformance 命令：

```sh
cargo build -p container-simulator --features v8-native --locked
node scripts/component-relations-smoke.mjs \
  --simulator-bin target/debug/weapp-simulator \
  --out artifacts/component-relations.json
```

smoke 要求显式提供已构建的二进制，不会启动 Cargo、watcher、HTTP listener 或浏览器。
它用正式 packer 生成临时 pack，校验 blob 哈希，通过原生 QuickJS 和 V8 的真实
`App` / `Page` / `Component` 执行边界运行，并在结束时清理本轮子进程和临时文件。

父组件通过 slot 投影接收一个由 Page 声明、隔着原生 view 的子组件。关系类型分别是
`descendant` / `ancestor`。精确生命周期期望来自仓库已保存的
`vendor/weapp-vite/e2e/utils/componentInstanceApiContract.ts` 的 INITIAL / REMOVED /
RESTORED 记录；该 smoke 不重新运行微信开发者工具。

每个引擎分四次启动 CLI，每次从初始状态执行到指定阶段：

1. initial：双方关系已经连接，父、子引用与 `selectComponent` 返回值严格相等，色块为红色。
2. mutated：通过 `getRelationNodes` 返回的活引用调用子组件方法，真实数据和 RGBA 色块变蓝，生命周期不增加。
3. removed：`Page.setData` 隐藏子组件；detached 看到旧关系，unlinked 看到空关系，持有的旧子引用不再返回关系，色块消失。
4. restored：重新创建的子实例与旧引用不同，父实例保持不变，旧子的数据仍为 1、新子为 0，色块恢复红色。

CLI 阶段使用 `module.call → render.commit → module.call`，渲染请求不注入预期数据。
报告同时保存真实 trace、页面报告、像素采样及哈希，两个引擎各自满足断言后再比较。
返回数组隔离、活引用和 RGBA 是本地 conformance 约束；保存的生命周期 oracle 范围
不会被扩展成全量官方等价结论。开发态、CPU 软件帧和这次 raw smoke 均不代表新增
DevTools、GPU、真机、七宿主或性能门禁通过。
