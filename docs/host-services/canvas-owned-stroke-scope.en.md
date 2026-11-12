<a id="canvas-stroke-状态与页面绘制"></a>
# Canvas stroke state and page rendering

[简体中文](canvas-owned-stroke-scope.md) · **English**


Final product `c058896f43e346f0c300bcbc6f6ab92ceea33466`, built on delivered metadata `6ea85300`, implements shared stroke state, Canvas receivers owned by pages and components, and transactional page redraws. The fixed baseline remains WeChat 3.17.3, miniprogram-api-typings@5.2.3, and 1265 APIs × seven platforms = 8855 cells.

`lineCap`、`lineJoin`、`miterLimit`、dash/offset、save/restore、paths and transformation state entered into the same command record and typed preparation, then consumed by software and Skia. The four fixed attributes: `lineCap`, `lineDashOffset`, `lineJoin`, and `miterLimit` add 28 partial units; the non-fixed `fontSize` extension is not included, and font/composite/shadow attributes are not implemented by inference from their owning objects. The current complete CanvasContext is still incomplete; the available increment in this batch is 0.

The Canvas page is bound to a real Page/component receiver, occurrence, and incarnation. Reusing canvas-id, component isolation, removal and reconstruction, unloading, or renderer borrowing cannot reuse old permissions. The guest's canvasId/owner field does not grant page redrawing permissions. Drawing before the first frame waits for a declaration to be accepted; setData is published before the draw's effect drain; after each completion, the next pending draw is processed, allowing setData in the completion callback to invalidate the node first.

Draw first validates the entire batch, pixel, and resource budget, prepares an immutable Canvas image and page candidate, then jointly publishes the renderer, Canvas binding, and session's input/authority/presentation state. The acceptance receipt for the old image and surface is retained until after the joint publication; this rule also applies to both the main layout submission and Canvas-specific redrawing. Failures do not override old pixels or consume pending retry commands. Redraw updates the render revision, retaining the page's layout frameId, geometry, and input source.

Capture wire-byte aggregation and item limits by actual aggregation computed before JS admission. Real session stress testing submits 25 batches, each with 50000 dash scalar items: the first wave accepts 19 batches, the next wave is synchronously rejected; only retries that batch and first checks blue pixels before submitting the subsequent batches, ultimately all 25 callbacks and Promises are exactly completed. Budget is not relaxed.

<a id="验证与剩余范围"></a>
## Verification and Remaining Scope

Precise product completion at stage 47 and full Git blob/gitlink/source/tool binding before and after. Testing includes actual QuickJS/V8, software/Skia raster, owner/retirement/rollback/budget paths, and real macOS offscreen Metal Session submission and readback. Metal is a Rust test cycle for two engines, confirming full BGRA pixel reads after GPU completion on the same queue, verifying unchanged old textures/Arc, and checking stale/current/duplicate revision ACK. The ACK itself remains a host-order contract and is not a GPU completion credential.

Web direct/Worker release completed independent producer, build, archiving, empty directory installation, and byte-by-byte validation; no browser execution in this round. DOM/WebView route page Canvas draw is explicitly unsupported. Web Software route source code retains RGBA page snapshot to putImageData display chain; CanvasKit direct/external and Worker paths are still rejected by the presenter's canvas guard; browser validation was not executed in this round. Shadows, gradients, complete font/text, extreme changed-CTM, fixed invalid/zero row behaviors of WeChat oracle remain unaddressed; complete functionality cannot be inferred from limited parameters, registration, mock, build, or installation.

Native macOS results do not replace actual device results on Android/iOS/Harmony/Windows/Linux, public SDKs, or WeChat acceptance. SDK/gitlink was not modified in this batch; seven precise remote references are available; accepted remains 0. Complete commands, original failures, source code fixes, and raw/gzip hash see [evidence of this batch](../archived-evidence.en.md).
