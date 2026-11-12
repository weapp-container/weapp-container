<a id="portable-pack-execution-evidence-v1"></a>
# 可携式包执行证据 v1

**简体中文** · [English](pack-execution-evidence.en.md)


Weapp Container 的实际程序执行门禁要求同一个 portable fixture 在每个宿主分别运行
QuickJS 和 V8。移动端是 Android、iOS、鸿蒙共 6 个组合；完整矩阵再包含 Web、macOS、
Windows、Linux，共 14 个组合。单引擎报告、host crate 单测、引擎 feature 可用性和独立
GPU context 都不能补足缺失组合。

多个独立执行报告可直接汇总，不需要重写或合并旧证据：

```sh
node scripts/check-near-parity-gates.mjs \
  --host-execution artifacts/android-quickjs.json \
  --host-execution artifacts/android-v8.json \
  --host-execution artifacts/ios-quickjs/execution-evidence.json \
  --host-execution artifacts/ios-v8/execution-evidence.json
```

`--host-execution` 可重复。相同绝对路径只读取一次；不同文件中重复声明同一宿主/引擎
组合会使该组合保持 `incomplete`。命令仍会检查原有的真实 DevTools、构建、bridge、
性能和 evidence ledger 门禁；本例没有提供的组合不会被标记通过。

报告使用下列结构。`fixture.manifest` 保存完整 manifest；`fixture.id` 和重新验证后的
manifest root 是跨宿主共享的程序身份。附加构建说明不会改变 fixture 身份。

```ts
interface PackExecutionReportV1 {
  sourceCommit: string;
  executionEvidence: {
    schemaVersion: 1;
    fixture: { id: string; manifest: ContainerManifestV1 };
    receipts: Array<{
      host: "web" | "macos" | "windows" | "linux" | "android" | "ios" | "harmony";
      engine: "quickjs" | "v8";
      status: "passed" | "failed" | "blocked" | "unknown";
      fixtureId: string;
      manifestIntegrity: string;
      sourceCommit: string | null;
      artifactSha256: string | null;
      build: {
        status: "passed" | "unknown";
        sourceCommit?: string;
        workingTreeDirty?: boolean;
        workingTreeScope?: string[];
        host?: string;
        engine?: string;
        artifactSha256?: string;
      };
      target: {
        host: string;
        id: string;
        kind: "official-simulator" | "device" | "browser" | "native-window";
      };
      sessionId: string;
      route: string;
      operations: Record<string, {
        status: number;
        requestJson?: string;
        request?: BridgeEnvelope;
        json: string;
        sessionId?: string;
      }>;
      surfaceProbe?: Record<string, unknown>;
    }>;
  };
}
```

`operations` 必须包含 `app.init`、`app.lifecycle`、`page.push`、`render.commit` 和
`render.snapshot`。前四项保存成功的 ABI status、原始 request 和 response batch，
requestId、sessionId、protocolVersion、operation 必须对应，且 batch 中不能含 error。
`request` 与 `requestJson` 二选一，后者便于保存原始 transport JSON。

`app.init` 的完整请求 manifest 必须与 fixture 规范化后相等，不能只保存相同 root。
manifest 依据仓库 JSON Schema 校验结构，并核对模块依赖闭包、WXS 与模板关系和
编译映射；schema 出现 audit 不支持的新关键字时保持失败，不能静默忽略。
完整运行时语义、实际模块/blob 字节闭包、AST 与 executable 验证仍由对应 source build
的 Rust loader 执行，audit 不替代该 loader，也不根据 manifest 元数据制造执行结果。
`app.init` 必须实际启用指定引擎、调用 App launch，加载数量与 manifest 中模块数完全
相等，且返回同一个 manifest root 与宿主身份。manifest 自身按 UTF-8 key 顺序规范化，
重新计算 SHA-256 root，并核对仓库固定的 weapp-vite submodule commit。
`page.push` 必须指向 fixture 中的 route；`render.commit` 必须发布该 route 的 WXML
template，返回 `committed: true`、`source: "manifest"` 和实际 frameId。手绘 frame
不能替代程序画面。

`render.snapshot` 保存同一个 sessionId；其 JSON 中 frame_id 必须等于 commit frame，
width、height 为正整数，format 为 `rgba8-premultiplied`。完整 pixels 必须都是合法
RGBA bytes，audit 重新计算 SHA-256；若同时声明 sha256，必须与计算结果一致。也可以
由已验证全部 snapshot bytes 的宿主保存精确 `pixelCount = width × height × 4` 和
完整 RGBA 的 `sha256` 摘要。摘要表示本次 runtime snapshot 的身份，不能宣称截图与
官方画面相同。

GPU 单独验收。`surfaceProbe` 必须含 schemaVersion 1、成功状态、host、engine、
sessionId、manifestIntegrity 和 frameId，并与上述执行相同；hostSurfaceAttached、
containerSurfaceAttached、gpuSurface 均为 true。snapshotSha256 必须等于上述 runtime
snapshot 摘要；它绑定程序 frame 身份，不能替代独立 GPU readback 像素比较。
backend 与 evidenceBoundary 必须
属于该宿主的明确组合，例如 Android 的 `skia-gpu-gles` /
`runtime-skia-gles-framebuffer`、iOS 的 `skia-gpu-metal` /
`rust-skia-metal-drawable`、Web 的 `skia-gpu-canvaskit` /
`runtime-skia-canvaskit-surface`。仅上传 raster snapshot、device-context-only、
其他 session 的 GPU frame 或零模块空帧都不能通过。

构建来源和运行来源分别记录。`build.artifactSha256` 必须等于实际运行 artifact 的哈希，
build 的宿主、引擎和已验证 source commit 必须对应；构建输入的 workingTreeDirty
必须为 false，并可用 workingTreeScope 说明检查的真实编译输入。只知道测试脚本的
HEAD，不能据此填写预编译 APK、App 或 HAP 的 source commit。缺失来源保留
`unknown` / `incomplete`，即便运行画面或 GPU 提交已成功。

Android collector 支持 `--engine quickjs|v8`，通过启动参数选择引擎和每次运行独立的
session nonce。它先删除本应用的旧 `files/portable-pack-execution.json`，启动后读取
本次 GPU callback 原子保存的完整收据。logcat 仅作辅助，避免长行截断被误当成完整
执行。读取失败、nonce 不符、未编译指定引擎或构建来源未知均不会产生相应发布通过。

旧报告继续显示在 `legacyPlatforms` 与 `legacySurface` 中。它们不自动生成缺失的
V8、fixture、binary source 或 GPU frame 证明。`mobileModuleExecution`、
`hostModuleExecution` 检查执行；`mobile` / `mobilePackGpu` 和 `hostPackGpu` 检查
关联的 GPU 提交。所有结果仅限列出的 fixture，不能代表完整 API、真实账号服务、
性能、真机覆盖或 near-parity 已完成。
