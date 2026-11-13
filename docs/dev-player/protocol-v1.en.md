<a id="dev-player-设备协议-v1"></a>
# Dev Player device protocol v1

[简体中文](protocol-v1.md) · **English**


This protocol is independent of business bridge and SDK C ABI. The current wire version is `"1.0"`, and it serves only LAN/established VPN. The client executes QuickJS + Skia locally; the protocol transports build artifacts, control, and diagnostics, without transmitting frames or executing any remote JavaScript. Both parties require an exact version of `1.0`; compatibility with `ERR_PROTOCOL_VERSION` is not supported and silent downgrade is prohibited.

Sources are defined as `scripts/device-dev-server.mjs`, `scripts/lib/device-dev/`, `apps/dev-player/lib/src/protocol.dart`, and `pack_store.dart`. This document records the implementation contract; it does not indicate that all five endpoints have been empirically validated.

<a id="身份tls-与配对"></a>
## Identity, TLS, and Pairing

The service defaults to `https://<LAN-IP>:5180`, with minimum TLS 1.2. The project ignores the directory `.weapp-container/device-server/identity.json` for storing self-signed EC certificates, private keys, and a stable `serverId`; `devices.json` stores the device token hash and expiration period. The private key is not included in the pack. Certificate expiration results in explicit failure; certificate rotation requires a full re-pairing and cannot be relaxed with pin exceptions.

The connection string has the following form, with all query values URL-encoded:

```text
weapp-container://connect?endpoint=https%3A%2F%2F192.168.1.20%3A5180&fingerprint=<64-lowercase-hex>&code=<one-use-base64url>&project=<project-id>
```

`fingerprint` is the DER-encoded leaf certificate SHA-256 hash. Each HTTPS/WSS socket on the client is fixed to this certificate and does not accept cleartext, external redirects, or system certificate exceptions. `projectId` is the first 32 bytes of the SHA-256 hash of the canonical project absolute path; it is not secret. The connection string and token must be treated as credentials and must not be included in history, business logs, packs, or installation packages.

The pairing credential is a 24-byte random base64url-encoded value, valid for 120 seconds, usable only once; a new credential replaces the old one. `POST /v1/pair` does not require a bearer; the JSON is:

```json
{"protocolVersion":"1.0","code":"<one-use>","deviceId":"<stable-id>","name":"My phone","platform":"ios"}
```

The platform only supports `android|ios|macos|windows|linux`; deviceId/name is 1–100 characters and contains no control characters. Each address may attempt up to 5 times per minute, with a maximum of 256 addresses in the attempt table; up to 32 valid devices. The one-time credential is consumed before asynchronous storage and cannot be concurrently reused. On success, the response is:

```json
{"protocolVersion":"1.0","deviceToken":"<32-random-bytes-base64url>","projectId":"<id>","serverId":"<id>"}
```

The device credential is valid for 30 days; the service only stores the hash. The client uses the OS secure store; if unavailable, it explicitly displays memory-only, without faking persistence. All subsequent HTTP/WSS requests carry `Authorization: Bearer <deviceToken>`. Upon revocation, new requests are rejected and existing WSS connections are closed; the credential is not included in the URL. Re-pairing with the same deviceId replaces the old credential.

<a id="产物发布与-https"></a>
## Artifact Publication and HTTPS

Rust `DevSupervisor` is the sole watcher and build owner. After a portable publication completes, a successful receipt is submitted anonymously via stdin to the sidecar; the sidecar then verifies directory ownership, manifest raw SHA-256, normalized integrity root, and all blobs. The URL cannot select arbitrary files. On build failure, only diagnostics are sent; the current generation remains unchanged.

| Interface | Successful Response |
| -------- | ------------------- |
| `GET /v1/project` | Current descriptor; no successful build has been generated as 204 |
| `GET /v1/generations/<generation>/manifest.json` | Manifest raw UTF-8 bytes, immutable private cache and hash ETag |
| `GET /v1/blobs/<sha256>` | Raw blob bytes, Content-Length, immutable private cache and hash ETag |
| `GET /v1/events` upgrade | Authenticated WSS, RFC 6455 version 13 |

JSON errors are returned as `{error:"ERR_*"}`; 401 indicates unauthorized access, protocol mismatch during pairing returns 409, and pairing rate limits return 429. The HTTPS service does not provide business control or proxy for arbitrary file access. The request JSON body is limited to 64 KiB.

Descriptor example:

```json
{
  "protocolVersion":"1.0",
  "projectId":"<stable-project>",
  "runId":"<32-hex-per-server-run>",
  "generation":"7",
  "manifestSha256":"<64-hex>",
  "integrityRoot":"<64-hex>",
  "manifestPath":"/v1/generations/7/manifest.json",
  "blobsPath":"/v1/blobs/",
  "compiler":{"name":"weapp-vite","commit":"<pinned>","platform":"weapp"},
  "schemaVersion":3,
  "route":"pages/home/index",
  "blobs":[{"sha256":"<64-hex>","size":1234}]
}
```

The generation is a positive decimal string, not represented as JSON floating-point for identity; the service accepts only secure integer revisions. A new runId is generated each time the sidecar starts, and generation values cannot be compared across runs. Within the same run, previous or duplicate publications do not overwrite the current package. The service retains up to three generations.

Service limits: manifest 8 MiB, descriptor 2 MiB, pack 256 MiB, 10,000 blobs. Player limits single blob to 256 MiB, supports two concurrent download workers, and has a project download cache cap of 1 GiB. The client downloads only missing CAS, re-verifies cached bytes, complete reference graph, and resource sizes; it does not trust a local receipt to claim validity. All resources are ready before staging is atomically published, and the native SDK performs final validation. Late downloads, service run changes, background operations, or project switching invalidate previous tasks; failure does not alter accepted packages.

<a id="wss-更新与报告"></a>
## WSS Updates and Reporting

The server first sends:

```json
{"protocolVersion":"1.0","type":"ready","serverId":"<id>","projectId":"<id>","runId":"<run>"}
```

If a successful build already exists, it then sends `pack`. The notification contains only identity; the client retrieves the full, current descriptor via `/v1/project`:

```json
{"protocolVersion":"1.0","type":"pack","runId":"<run>","generation":"7"}
```

Other server types: `diagnostic` (build diagnostics), `heartbeat`, `command` (name=`reload|rollback`), and `shutdown`. Heartbeats occur every 15 seconds; if a peer does not respond within 60 seconds, the connection is closed. Up to 16 peer connections are allowed simultaneously. WSS text message size is capped at 64 KiB; clients must mask messages and support bounded text fragmentation. Binary messages, compression extensions, or payloads exceeding 64-bit length are not accepted. If the write queue of a slow peer exceeds 1 MiB, the connection is terminated, without blocking other devices.

The client sends either `heartbeat` or:

```json
{"protocolVersion":"1.0","type":"report","projectId":"<project>","runId":"<run>","generation":"7","phase":"started","details":{"reloadKind":"inPlace"}}
```

Phase is allowed to be `connected|downloading|downloaded|verified|starting|started|presented|error|diagnostic|metrics|log`; reports with generation must include the current runId. If `projectId` is present, it must match the pairing project; older clients may omit it. `details` is bounded diagnostic data and does not grant runtime privileges. A command enqueue of 202 only indicates receipt, not client completion.
`started` is a native candidate accepted. The current Player sends `diagnostic` after matching SDK generation, valid frameRevision, inputEnabled, and actual gpuSurface. The Player explicitly ACKs boundaries via `code=NATIVE_FRAME_ACKNOWLEDGED`, `presentationStage`, and `screenPresented:false`. On macOS, `flutter-texture-consumed` is issued, proving only that Flutter consumed the GPU texture; for all other current adapters, `native-frame-acknowledged` is sent. These signals do not verify final screen presentation time or actual FPS, and thus the current Player does not send `presented`. The protocol reserves `presented` for future clients with additional display receipts. Late or expired receipts cannot recover input; retries after GPU pause must wait for a new frameRevision. Reports displayed by the service are device declarations, and network logs cannot substitute hardware display or interaction evidence.

<a id="只读-source-map-定位"></a>
### Read-only source-map localization

`error|diagnostic|log` may carry raw stack traces in `details.stack` or `details.error.stack`, or report position via `details.error.{file,line,column}` (with row and column starting from 1). The service retains the original `details` and adds a new `sourceMapping` in the management history, containing `version: "1.0"`, `status: mapped|partial|unmapped`, `frames`, optionally `mappedStack`, and failure `reason`. It does not accept file reads, URL downloads, or JS execution commands.

The map binding is tied to the most recently declared accepted project/run/generation. `starting` does not switch identity; late `presented` does not override an already accepted generation. A new build release does not affect the map of old instances. Candidate reports are marked as `unaccepted-generation`, and retired generations are marked as `generation-unavailable`. Only identity-bearing `started` or initial `presented` can establish an accepted identity; this remains a device declaration.

Regular scripts are precisely linked to the full path of the manifest module and its corresponding `<module>.map` asset. It supports either the full module path or the `module:<path>` execution filename. Modern View uses `weapp-view:///modern:<SHA>.js` and the manifest's `sourceMapSha256`, with stack positioning offset by three lines from the existing runtime library; stacks already containing `[generated ...]` are not rewritten. `<input>`, eval, basename-only, or custom `sourceMappingURL` do not attempt module inference and preserve unmapped results.

Maps are read exclusively from verified CAS; symlinks are disallowed upon opening, read length is limited, and SHA-256 is revalidated. After compilation, the map is kept read-only and cached, and is evicted along with up to three generations. Each generation may contain up to 128 maps, each up to 2 MiB (totaling 8 MiB), 100,000 lines, and 100,000 segments; each map may contain up to 4,096 sources and 16,384 names. A single stack may have up to 16 KiB, 64 positions; budget overages are explicitly marked, and partial guessing is disallowed. Full support for standard source-map v3 and VLQ is provided; indexed maps, empty `sourceRoot`, absolute paths, URLs, and paths outside the project label space are rejected. Modern source maps must be in the manifest allowlist or be restricted virtual ID. `sourcesContent`, names, and map's `file` are not displayed or used as aliases; source-level breakpoint debugging is not yet available.

<a id="本机管理面"></a>
## Native Management Face

Management HTTP is bound to `127.0.0.1`, defaulting to port 5179, and is separated from the TLS device port. `GET /` generates a page with a randomly generated management secret per process. All other interfaces require bearer, exact Host, and same-origin Origin:

| Interface | Content |
| -------- | ------- |
| `GET /state` | Paired devices, connection phase, current descriptor, bounded history |
| `POST /pair` | New one-time connection, expiration time, and QR code data URL |
| `POST /revoke` | `{deviceId}`; revoke credential and close peer |
| `POST /command` | `{deviceId,name:"reload"|"rollback"}`; enqueue only |
| `POST /inspect` | `{deviceId}`; dispatch a unique read-only `pages.read` request; 202 indicates only waiting for device response |
| `GET /inspections/{requestId}` | Read pending/failed/valid results; snapshots are not written to history logs |

Management secret and device token permissions are separated; devices cannot invoke the legacy Web emulator `/api/bridge`. The computer panel does not provide any remote evaluation. The read-only inspector is bound to the current peer and the accepted project/run/generation. The Player performs a batch call to `devState`, extracting page data and passive SDK state from the whitelist, accepted pack, and development operation receipts; it does not export storage, native private configurations, or any command. One in-flight request per device, with 5-second timeout; result size capped at 48 KiB, 32 pages, 2,048 nodes, 12 layers; sensitive keys and credentials are masked, and snapshots are not logged in history. Disconnections, instance updates, or identity mismatches invalidate prior requests/snapshots; unknown operations are not permitted to invoke the runtime. The management face separately displays pending, failed, and valid results.
Optional `playerViewDiagnostics` is version 1 diagnostic record owned by the Player process, containing up to 16 entries. It includes only controlled operations, View lease, operation and receipt sequence numbers, error codes, closure reasons, retirement flags, and the controller role at the time of the event. It does not include native error body, stack traces, or any UI logs. `lastSequence`, `droppedCount`, and `sequence` are up to 128-bit normalized decimal strings; lease and operation sequence numbers are positive u64 strings. The service validates the complete field, enumeration, and order, rejecting unknown fields and non-conforming numeric values. This bounded scalar record does not consume page node quotas but is counted within a 48 KiB byte limit; if insufficient, the oldest record is removed from the response copy and `responseTruncated` is set; if even the minimal encapsulation cannot fit, `ERR_DEV_INSPECT_LIMIT` is explicitly returned. New Player instances also send `lastSequence="0"`, `droppedCount="0"`, and `entries=[]` encapsulations prior to their first failure; older Player instances lacking fields still indicate unavailability and cannot be defaulted to zero. This record only captures asynchronous View operation failures observed by the Player and does not prove the absence of loss for all native events or diagnostics. Historical data across projects and after restarts are not reattributed based on current pack ownership; upon Player process restart, record sequence numbers are reset.

On iOS, layout measurement cancellation omits propagation of the closed `{schemaVersion:1, reason}` detail for nine actual branch failure reasons. Only `ERR_CANCELLED` with strictly matching field, integer version, and reason combinations is permitted to enter the record; invalid details remain as `unclassified` and are not reverted to error body inference. Empty details remain compatible with known precise error body from legacy Android. The cancellation reason only describes the failure origin and does not grant input, prove safe recovery, or rewrite unclassified error history.

`state.viewExecutionMetrics` may carry document registration count, input byte count, and optional native `lastBatch`. Native clock and thread identity are maintained as decimal strings; unmeasurable values remain as `null` and are not filled with fabricated zeros. An independent optional `lastBatchBreakdown` version 1 must match adjacent `lastBatch` in engine, profile, operation, batch, and thread identity. Its QuickJS phases separately record context calls, native JSON stringify API, UTF-8 copy, final deadline check, and poisoned realm destruction, as well as actual output bytes. Phases may be nested but are not additive; the stringify API includes a wrapper for Value release, and pure serialization CPU time cannot be claimed. Private writer in modern profiles belongs to the execution phase; V8 does not populate the QuickJS phase. When diagnostics are disabled, this optional field is omitted, and the original `lastBatch` v1 field remains unchanged; full specification is defined in SDK contract `PREVIEW5.md`. These metrics remain subject to existing page/state shared budget constraints. Diagnostics and metrics do not alter health status, input permissions, development operation outcomes, or actual presentation state. Breakpoint debugging is not yet available; local and WSS/HTTP testing do not substitute real device data validation, error localization, or performance acceptance.

<a id="reload失败和退出"></a>
## Reload, Failure, and Exit

SDK `pack.devReload.protocolVersion="1.0"` is a required capability; older libraries explicitly reject it. Shared classifier determines `inPlace|restart`. State preservation only applies to confirmed safe View/resource changes; structural/script changes trigger a full restart with persistent storage retained. Failures during download, validation, and startup are retained for the current instance prior to acceptance. After acceptance, GPU failures pause input and allow retry or fallback to the previous package; the previous package restarts, but prior JS heap recovery is not guaranteed.

Disconnection does not destroy the local app. Background stop attempts reconnection and cancels the current update; foreground re-synchronizes. On exit, device reader/connection is stopped first, followed by the sole supervisor watcher and its own staging; this task does not close other development services or user devices. Verification must separately record connection, download, validation, startup, presentation, retry, exit, and resource release.
