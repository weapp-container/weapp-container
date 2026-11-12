# 固定编译器的构建来源

正式官方回执的 `compilerBuild` 使用 `{ path, sha256, bytes }` 引用一份独立构建归档。同一轮 172 个 case 可以共享这份引用。读取器只依赖归档内容；清理原 checkout 后仍能复核。`retained-build-inputs.json` 继续用于复制 dist 的诊断运行，不满足正式构建要求。

```sh
node scripts/conformance-compiler-build.mjs \
  --archive artifacts/conformance-compiler-build/<unique-run> \
  --checkout artifacts/conformance-compiler-build/<unique-run>/checkout \
  --package-manager /absolute/path/to/pinned/pnpm
```

默认源码是 `vendor/weapp-vite`，commit 来自当前 baseline。入口验证源码实际 HEAD 和脏文件，创建自己的 detached clone；不复制原目录的 dist、node_modules 或缓存。包管理器实际版本必须匹配固定源码的 `packageManager`；Turbo 子任务通过 PATH 查找的 `pnpm` 也必须来自该包管理器目录且版本一致，防止 Node 目录中的 Corepack 入口替换固定工具。安装使用 frozen lock、禁用安装脚本和独立 store；构建对固定的 core workspace 闭包使用 Turbo `--force`。构建目录及 attestation 必须尚不存在，重试须换用新的受管目录。

归档包含原始 Git commit、完整 tree 与 blob 对象，读取器重算 Git 对象身份并检查完整树叶。Git 按固定属性对文本执行的 CRLF 转换单独记录并由原始 blob 重算。构建前后检查物理源码内容，因此 `assume-unchanged` 或 `skip-worktree` 不能隐藏修改。

依赖快照保存安装文件的内容身份、执行位及内部链接。Git 跟踪的 `node_modules` 测试样本只归入源码闭包，继续接受源码不变校验，不能在依赖快照中重复或覆盖。源码中的实际 pnpm workspace 成员决定直接依赖集合；读取器要求声明与解析记录一一对应，并按最近 importer 的 `node_modules` 搜索重算解析结果。指向 checkout 外的链接、缺失目标、循环、错误包名/版本、遗漏非可选依赖与借用外部 store 都会失败。原始内容保留在本地 `artifacts` 的 CAS 中，文档和正式回执引用必要索引，不将整份 node_modules 提交到 Git。

构建前要求 compiler output 目录不存在。安装与构建的实际参数、时间、退出状态、stdout、stderr 和进程结果分别归档；构建后记录产物内容。缺少成功命令、产物、源码闭包或依赖闭包时不会接受 `built` 标签。构建后的消费还须由运行器绑定实际使用的编译器文件；一个合格但未被本轮使用的构建引用不能替代该绑定。

正式运行器从构建归档重建独立的源码、依赖和输出闭包，每个 case 单独保存 `compilerUse`。受控的继承 preload 记录 Node 实际 resolve/load、文件与加载内容 hash、PID/PPID、线程和运行身份；读取器检查实际子进程归属、运行时间、前后文件 guard 及精确归档的 helper patch。必须实际加载 fresh compiler entry；只有 retained dist、成功退出或未观察到的 Vite transform 都不够。

启用宏观察的新消费配置另封存内部 `outputLoadPolicy: "sealed-esm-v1"`。对闭包中 `output` / `observed-output` 的精确 `.mjs` 常规文件，最外层 hook 在核验磁盘 hash 后直接返回原始 ESM 字节；要求规范 file URL、module 上下文及空 import attributes。这样 TSX 只转换仍需转换的 helper，不再改写已构建 ESM 的动态 import。配置、实际 startup 与每次成品 load 的 policy witness 必须一致；缺失、未知、伪造或作用于其他来源的标记均拒绝。未声明策略的旧记录仍按原始严格 hash 校验。未被策略接受的成品若实际加载内容发生变化，另归档返回字节供诊断，回执继续失败。

JSON 宏新运行使用固定的内部 `pinned-json-macro-esm-cjs-v4-runtime-input` 观察 profile；旧 ESM v2 与 CJS v3 验证分支保持严格性。CJS v4 区分原生编译器的完整输入与实际输出模块：只接受固定 5,878 字节虚拟 runtime 输入、被完全摇树移除后的单一 TypeScript entry 输出，以及零静态外部导入和零动态导入。实际 native 加载、原始临时 TS 与 Node `_compile` 消费的 CJS 字节继续分别校验。历史被阻塞回执不会因离线重读而升级。运行器只对四个精确匹配的构建输出按冻结 UTF-16 位置插入观察代码，分别归档原始输出、实际加载的观察后输出和重建清单，并将后者记为 `observed-output`。它不改原始 vendor checkout，不运行 AST 作者工具，也不把观察后字节称为原始产物。未声明观察的历史回执继续使用原校验路径。

宏证据从构建前 Vue 输入逐步绑定到实际 descriptor、宏求值源码、临时 TypeScript、原生 bundler 的输入/结果、输出 chunk、临时 ESM 写入、Node 实际加载内容和清理。ESM 分支仅支持已验证的无依赖宏，以及固定 Rolldown `1.2.14` 的 runtime、darwin-arm64 addon 和唯一 `node:module` 外部边；每项均要求同次运行的来源和精确字节。仅 resolve 到 addon、事后读取临时文件或成功退出不能代替实际执行观察。默认 Node hook 可返回 own-data `format: undefined`，记录器保留为 `null`；生成 ESM、wrapper、JSON 和 addon 各自仍须满足明确的格式约束。

CJS 分支只接纳已观察到的无依赖 `.ts` JSON 宏。固定编译器通过最近的 `package.json` 判定 `isESM=false`，临时替换该扩展名的 `require.extensions` loader、清除缓存，再以绝对文件路径 require 原始临时 TypeScript；它不写第二份 `.cjs`，也不走 ESM import。v3 归档实际 package 搜索、原始输入写入、扩展 loader 安装与恢复、两次真实 resolve 和同步编译 span。preload 另捕获 Node 原始 `Module.prototype._compile`，分别封存物理 `evalSource` 与该函数实际消费的 `bundledCode`，核验同次原生 bundler 与封闭 addon 依赖，并拒绝后续变换、绕过、fallback、URL 替代、缺失消费和不完整恢复。原返回值、抛出对象保持原样。旧 v2 没有这条消费边界，不能离线回填成 v3；producer/preload 等源码等同性规则继续适用，历史通过证据需要对应实现的实际新运行。

后注册的同步 hook 完成后，记录器重挂最外层观察，并记录连续 generation；目标 direct static CLI 的动态宏执行另要求完整 Terminal chain、封存的原始输入及成功结束。没有动态宏的 bridge / worker 只验证既有 startup 隔离与逐次实际 load 终值，不宣称完整宏执行链。观察 helper 保留原返回值和抛出对象，失败状态不可恢复。CJS addon 通过实际 `process.dlopen` 成功返回后，才记录同一封闭依赖文件的前后身份和 hash。此处是受信工具链的路径观察，不是内核映射证明；accessor 等不支持的 load 结果不保证与未安装 hook 时相同的 getter 调用次数。证据失败保持 blocked，不回填历史执行。

记录器通过 `NODE_OPTIONS --require` 同步安装，在子进程的 `execArgv --require/--import` 前开始观察。额外加载器只接受两种实际上下文：Vitest `5.0.4` 的线程 worker 加载该包的 `suppress-warnings.cjs`，或固定源码的 `e2e/utils/automator.cli-bridge.ts` 以 `--import tsx` 使用安装闭包中的 TSX `4.23.15`。包名、版本、真实入口、argv、cwd、PID/线程、同线程实际 resolve/load 和加载内容 hash 均须匹配；bridge 另保存真实受管项目的配置内容与 hash。Worker 的同步 preload 早于 `argv[1]` 赋值，因此还须在后续实际 worker 入口加载时核对完整 argv。仅有包文件、require cache、相似路径或成功退出均不能替代加载证据；外部包、别名、shadow loader、缺失加载及变换 fresh compiler output 均拒绝。

`fixtureBuild` 继续把这次消费绑定到官方打开的项目。目标项目仅接受一次直接执行的 `node <owned-cli> build <project> [--platform weapp]`，生成目录起初必须不存在。可执行文件须为选定 Node；裸 `node` 另记录当次 PATH 解析与实际启动 argv，不接受 shell、argv0 别名、其他平台或额外 flags。原始输入及依赖链接在构建前后逐项保持不变，包括已有的支持文件；CLI 只可新增以下八个常规文件，并将新增差集单独记为 `generatedSupport`：

- `tsconfig.json`
- `.weapp-vite/tsconfig.app.json`
- `.weapp-vite/tsconfig.node.json`
- `.weapp-vite/tsconfig.server.json`
- `.weapp-vite/tsconfig.shared.json`
- `.weapp-vite/tsconfig.shared.empty.d.ts`
- `.weapp-vite/uni-app.d.ts`
- `.weapp-vite/typed-router.d.ts`

新增支持文件也保存完整内容身份；额外路径、符号链接、原文件删除或改写均拒绝。checkpoint 与离线读取器使用同一差集验证，不能通过忽略整个 `.weapp-vite` 目录绕过源校验。支持文件属于项目归档，packer 仍只消费实际生成的 miniprogramRoot 闭包。

官方连接后采集的 Tool/wx 观察必须指向同一项目、安装和构建后的时间；checkpoint 检查实际 `project.config.json` 与 `miniprogramRoot`。worker 结束时还须证明目标没有第二次 build、dev/watch 或输入/生成物修改。fixture 正常删除后，可用此前归档闭包与完整 recorder summary 复核。

固定 helper 会清除 companion 的 `NODE_OPTIONS`。启用观察 profile 时，recorder 仅对精确受管 companion 恢复与目标相同的 preload、空 `NODE_PATH` 及配置路径；已有的外部 preload、其他项目或 CLI 参数仍拒绝。companion 不继承目标的 fixture input closure。实时 flush 只检查其归属、产物隔离和清理；编译器消费日志封存后，离线读取器再核对同一 PID 的实际启动 argv、cwd、父进程、环境及 compiler dist 加载。该启动证据不代表 companion 的完整动态宏链通过，目标 static 构建仍须单独完成严格验证。

官方 setup 自带的 HMR companion 单独记录，不计为目标构建。仅允许同一 worker 在受管 checkout 的 `.tmp/e2e-ide-hmr-companion/<精确 case 标签>` 执行 `dev --non-interactive`，其 cwd、项目及输出必须与目标完全分离，依赖链接须绑定编译器消费闭包。记录保留实际 argv、PID、时间、stdout/stderr、输入和输出；companion 必须先正常退出或经 SIGTERM 结束，并在目标构建前观测到项目目录已删除。SIGTERM signal 或处理该信号后返回 143 的退出，都必须绑定当前 worker 对该仍存活子进程的实际成功 `process.kill` / `child.kill` 请求；请求、返回和退出时间须按序且在固定 helper 的 4 秒清理界限内。单独的 143、未知来源信号、失败请求和其他终止信号不能证明正常清理。仍运行、退出异常、删除过晚、未知项目或其他 CLI action 都会阻断。companion 的产物不参与目标 pack，也不作为目标 HMR 通过证据。

运行结束后，独立子进程使用归档的受审 packer 模块及其依赖打包该生成闭包，并记录实际加载、输入 guard 与全部输出。`compilerBuild → compilerUse → fixtureBuild → official execution` 由同一验证器检查；缺少实际 CLI、runtime checkpoint、packer 或完整闭包时，不生成正式通过回执。HMR、重复构建、bridge wrapper 替代项目与未证明的生成代际仍会阻断。

静态作者 recipe 可选 `fixtureProfile: "captured-static-v1"`，只声明 case/source 和 collector 闭包。该模式禁止预填 fixture、resources 或 oracle：真实编译产物会包含临时项目路径，不能预先假定跨运行的 JS 字节相同，也不删除注释或改写标识符来消除差异。worker 先完成实际项目/SDK checkpoint，绑定其精确 `{path, sha256, bytes}`，再安装收集器并记录事件；绑定缺失、重复或晚于事件均阻断。parent 验证完整来源链后，要求观测绑定的 checkpoint 与该链逐字段相同，才使用本轮 pack 的原始 manifest 与全部 blob 生成正式 trace。

成功收尾会另写 `execution-recipes.json`：它把作者描述绑定为本轮固定 fixture、资源及 oracle，供全部容器 host/engine 读取同一份字节。未绑定的作者描述不能执行 matrix，记录 `unbound-case-fixture`。原固定 fixture recipe 仍兼容，并继续要求与实际 pack 完整一致；`issue1058-v1.json` 保留原候选，fresh 执行改用 `issue1058-captured-static-v1.json`。

```sh
rtk proxy node scripts/conformance-devtools-runner.mjs \
  --case ide-issue-1058-template-tags-runtime \
  --recipes conformance/recipes/issue1058-captured-static-v1.json \
  --compiler-build artifacts/conformance-compiler-build/<unique-run>/compiler-build.json \
  --out artifacts/conformance-official/<unique-run>
```

该命令还需要固定版本 DevTools 的登录、服务端口和资源 lease。现有 1058 recipe 与本地验证器测试不代表 172 个官方 case 或 2,408 个容器 pair 已执行；完整覆盖、七端双引擎、GPU、真机和性能仍分别验收。

这份记录依赖本地构建执行器和所记录的宿主工具链；它不是数字签名，也不宣称操作系统级的封闭构建。源码哈希不能证明远端事件发生，正式运行仍须保留实际官方执行、版本、trace 与清理证据。

`compiler-fixture-v1` 只供真实 Node 子进程的构建器单测，正式读取器默认拒绝该 profile。`scripts/fixtures/conformance-compiler-build.mjs` 则生成明确标记的 synthetic 离线记录来覆盖验证器正负路径；它不运行编译器，不进入生产运行器，也不能作为已完成官方执行的证据。
