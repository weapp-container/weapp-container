# Issue 1058 的静态样本

`fixture.json` 来自固定 commit `0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e` 的原始 `createIssue1058Project` / `buildIssue1058Project` helper 和全新编译器构建。实际生成目录通过仓库 `container-manifest` 打包，两个页面保持 `app.json` 顺序。这里仅保留 portable manifest、20 个必需 blob 和来源索引，没有临时项目、安装依赖或编译器大目录。

`authoring-provenance.json` 引用本机诊断的源码、编译命令、生成文件、打包日志和清理回执。该诊断未连接 DevTools，未记录正式 compiler-use，也未提升官方 case 状态。registry 没有 `oracle` 字段；它只是首个实际官方试跑的输入。

正式试跑必须重新观察原测试的五个成功 DOM checkpoint 和三次成功点击，并在真实官方 checkpoint 对本轮 CLI 生成的 `dist` 重新打包。只有 manifest 和完整 blob 闭包与此样本完全一致，独立的 fixture-build、compiler-use、版本及清理证据均通过，才可进入后续正式验收。

collector 只读取成功 checkpoint 的实际 `evidence.nodes`，并被动记录成功的 `tap`；其模块没有外部依赖，因此 `collectorInputs` 为空。checkpoint 中的文本和计数来自实际观察，缺失或乱序的观察会让 flush 失败。
