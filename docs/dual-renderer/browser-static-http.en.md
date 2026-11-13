<a id="静态站点的原租约-http-传输"></a>
# Static Site's Original Lease HTTP Transfer

[简体中文](browser-static-http.md) · **English**


This page records the contract for the underlying stage; these APIs themselves do not enable CLI development. The complete runner, launch parameters, and closure restrictions for the currently explicit Browser CLI are available in [Browser Development Loop](browser-dev-loop.en.md).


`serve_browser_stage` connects a verified runtime and an actual managed stage to the local HTTP.
It reuses the fixed compiler, portable input, original resource bytes, and resource leases from `DevSupervisor`
for checking static descriptors, indexing, and content-addressable blob. This entry does not execute AppService, Worker, browser, or presenter, and does not grant site publishing, runtime, or input permissions.

<a id="运行示例"></a>
## Running Example

From the root of the repository, first complete [Fixed Compiler and Managed Input Preparation](browser-source-preparation.en.md),
then prepare an independent, selected and fixed-source completed Worker producer:

```sh
cargo run --release -p container-simulator --example serve_browser_stage -- \
  examples/apps/reference-app \
  /absolute/completed-worker-producer \
  /absolute/independent-pins.json \
  0 60000
```

Parameter positions as follows:

| Parameter | Meaning |
| --- | --- |
| `project` | Original mini-program project; uses a fixed vendor compiler and QuickJS, does not support modern View's `container.config.json`. |
| `producer-directory` | Completed independent producer directory; supports `software` or `canvaskit`, and must be separate from project, output, and prepare root. |
| `independent-pins.json` | The producer identity selected before the consumer starts, file size no more than 16 KiB. |
| `port` | optional, default `0`, assigned by system; example binds only to `127.0.0.1`. |
| `duration-ms` | optional, calculated from HTTP start, range `1..=86400000`; omitting it waits for Ctrl-C. To specify a duration, the previous port parameter must still be provided. |

pin file structure is identical to [runtime input](browser-dev-artifacts.en.md#监督器的静态-runtime-准备).
The following values are placeholders and must be replaced with the original values from the independent producer's execution record:

```json
{
  "expected": {
    "reportSha256": "<原 build-report.json 字节的 SHA-256>",
    "sourceCommit": "<producer 的 source commit>",
    "sourceSha256": "<producer 报告中的 source inventory SHA-256>",
    "renderer": "canvaskit"
  }
}
```

`sourceSha256` uses the producer's inventory recipe, not the hash from the `source-snapshot.json` file
The expected pin cannot be re-fetched from the pending validation directory at consumer runtime. Specific sources and byte verification are detailed in
[runtime artifact contract](browser-dev-artifacts.en.md).

Example waits for static runtime, real portable, and stage receipts, with a shared 180-second deadline during the preparation phase.
After success, print `StageArtifact` first, then output a single-line ready JSON containing the following fields:

```json
{
  "event": "static-http-ready",
  "address": "127.0.0.1:<port>",
  "descriptorUrl": "http://127.0.0.1:<port>/__weapp/site/<run>/<site>/site.json",
  "indexUrl": "http://127.0.0.1:<port>/__weapp/pack/<run>/<site>/pack-index.json",
  "runtimeBaseUrl": "http://127.0.0.1:<port>/__weapp/runtime/<bundle-sha256>/",
  "runtimeReady": false,
  "presentedReady": false,
  "publicationAuthorized": false,
  "sourceFreshness": "not-checked-after-stage"
}
```

Use the actual output `descriptorUrl` or `indexUrl` to obtain the original bytes. `runtimeBaseUrl` is a resource prefix, not a directory listing or a viewable mini-program page; specific resources should be requested from the allowlist. The example will not automatically open the browser; this static example itself does not enable the watch CLI. Current explicit CLI entry for the managed Browser runner is available at [Development Loop](browser-dev-loop.en.md).

<a id="url-和请求边界"></a>
## URL and Request Boundary

Resource-specific entry points only accept GET requests in the following three namespaces:

| URL | Original Resource Source |
| --- | --- |
| `/__weapp/runtime/<bundle-sha256>/<path>` | Exact serve allowlist retaining runtime receipt. |
| `/__weapp/pack/<run>/<site>/pack-index.json` | The current fixed stage original index. |
| `/__weapp/pack/<run>/<site>/worker-product-config.json` | Verified original startup JSON. |
| `/__weapp/pack/<run>/<site>/portable-pack/manifest.json` | The verified original manifest. |
| `/__weapp/pack/<run>/<site>/portable-pack/blobs/sha256/<hash>` | Verified content-addressed blob. |
| `/__weapp/site/<run>/<site>/site.json` | The original descriptor for the current fixed stage. |

run、site and bundle must equal the actual identity preserved by the example, site uses a normalized decimal u64,
hashes use 64-bit lowercase hexadecimal. URLs do not map to local file paths; syntactically valid URLs cannot override the original store's resource allowlist. The generated `worker-product-config.mjs`, runtime source, producer reports, and parser are not exposed to external services.
`/`, the old simulator UI, `/api/bridge`, SSE, and coordinator control entry points are not open.

New entry validates `GET ... HTTP/1.1` and a Host on the original request; Content-Length can only be missing or the literal value `0`, rejecting repeated Length, Transfer-Encoding, Expect, Upgrade, and trailing headers already received.
URL does not accept query, fragment, percent-encoding, backslash, empty segments,`.`/`..`, or non-ASCII paths.
This check only applies to bytes already read and does not predict subsequent TCP data; each response closes its connection.
Resource responses do not inherit the wildcard CORS from the original entry and send `nosniff` with `same-origin` resource policy.

<a id="owner-loop-与退出"></a>
## Owner loop and Exit

`WebSurface::bind_resource_only` explicitly enables the resource queue; regular `bind` retains the old simulator routing,
the retained control namespace explicitly rejects before old OPTIONS/CORS. Resource-only default also does not open control;
trusted owner can explicitly enable it via [control seam](browser-control-http.en.md) prior to the first accept,
this static example does not invoke it.
The same owner lane advances in the following order:

```text
surface.poll
  → surface.resolve_resource_requests
  → surface.poll
  → supervisor.poll
  → surface.wait
```

resolver only verifies fixed identities and invokes `browser_runtime_resource` or `browser_stage_resource` from the same supervisor, returning the original non-Clone borrower. It does not spawn new supervisors, does not read local files, does not re-stage/pack, and does not establish a second resource cache or ledger. When a resolution request exists, `wait` immediately returns; the embedder must execute the resolver, not just run `poll → wait`.

Pending parse requests, responses, and other connections share the original 64 connection limit. Resource requests from accept to owner lookup,
ultimately written with the original 5-second deadline, handoffs do not extend. Actual response holds the original runtime/stage lease,
writing only borrows the original byte slice; artifact payload retains original cost, HTTP records only additional small headers.
Existing 256 KiB write quantum and 2 ms fair scheduling continue to progress, slow readers do not block the entire supervisor.

Only release the borrower after the surface is fully completed, disconnected, deadline reached, or released. Retirement revokes new borrows, and ongoing byte streams still prevent early cleanup of stage, input, and parent directory. On exit, first drop the HTTP surface, release all sockets/body, then retry `try_shutdown()` on the same `DevSupervisor`; it's not possible to retain one's own HTTP borrow while waiting for the original owner to clear. Example retries cleanup within 15 seconds, explicitly reports failure on timeout, and does not consider Drop or logs as proof of cleanup completion. Resource lifecycle details see [managed consuming stage](browser-consuming-stage.en.md).

<a id="固定站点与证据含义"></a>
## Fixed Sites and Evidence Meaning

Initial source check is used solely for obtaining a stage ticket, during which the original Diagnostic is output to the terminal. stage
After capture, the example proceeds with the watcher and prints build diagnostics, but fixed run/site/pack entries are not automatically replaced with new source code and are not rechecked for publishability. Following source code changes, build failures, or the appearance of new portable components, these URLs provide only the old immutable static diagnostic bytes; one cannot assert that they represent the current source code or permit activation based on them.

Therefore, ready JSON explicitly maintains `publicationAuthorized: false`,
`sourceFreshness: "not-checked-after-stage"`, `runtimeReady: false` and
`presentedReady: false`. HTTP success only proves that the corresponding bytes were read through this transmission. True Worker startup,
preview lease, source barrier before activation, control receipt, presentation ACK, input, hot update, and shutdown barrier
still need to be wired up and verified individually; static services do not generate browser, CanvasKit, GPU, official DevTools or seven hosts
through the conclusion. This page does not fill in unobserved test results.
