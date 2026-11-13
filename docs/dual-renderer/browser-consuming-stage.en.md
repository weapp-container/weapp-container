<a id="受管-portable-到静态站点"></a>
# Managed Portable to Static Site

[简体中文](browser-consuming-stage.md) · **English**


> This page records the low-level contract; these APIs themselves do not enable the development CLI. The full runner, startup parameters, and shutdown restrictions currently in use by the Browser CLI are documented in [Browser Development Loop](browser-dev-loop.en.md).

**`DevConfig.managed_browser_stages = true`** connects a real `stage-pack` to the existing
**`DevSupervisor`**. It requires concurrent enabling of **`managed_browser_sources`**, BrowserWorker,
QuickJS, a fixed vendor compiler, and independently selected producer pins. The default profile still only prepares
runtime or raw/portable; this option explicitly increases site admission capacity.

Entry point is:

```sh
cargo run -p container-simulator --example prepare_browser_stage -- \
  <project> <completed-producer-directory> <independent-pins.json>
```

This example obtains runtime pins and actual portable through the same supervisor, then creates a coordinator ticket,
launches a limited stage job, borrows static resources, and executes a retryable cleanup. No native AppService is created.
Existing **`dev --web-runtime browser`** continues to explicitly deny; HTTP, Worker, and rendering still require further wiring.

Call order is:

1. Use **`browser_stage_run_id()`**, validated runtime pins, and the SHA-256 of the original startup JSON to create a **`BrowserDevCoordinator`**. All source events are delivered immediately via instant **`check_portable_publication`**, then a mint/consume **`PublicationApproval`** is performed and a **`StageTicket`** is created.
2. Call **`begin_browser_stage(ticket, original_startup_bytes)`**. The supervisor observes the source again in real time; events returned by **`SourcePending`** must be delivered first, then retried with a new ticket. Only when the complete report of the actual current portable matches the ticket is the original source owner borrowed; the same charge from the original runtime receipt is retained alongside the stage.
3. **`poll()`** always advances the stage's actual process and deadline, independently of compiler events. Call **`poll_browser_stage`** to obtain a **`CapturedStatic`** or a clear error. **`StageArtifact`** is merely validated static metadata; the release after completion still requires re-observation of the source, and cannot reuse the approval from the startup stage.
4. **`browser_stage_resource`** borrows the captured original bytes. The allowlist excludes generated executable config MJS, does not expose runtime source, original input paths, or bare Arcs that can be self-cloned. **`retire_browser_stage`** immediately revokes the new borrow; original output cleanup, input release, and original reservation refund are only permitted after full resource release.
5. Normal exit retries **`try_shutdown()`** until **`true`**. The order is: watcher actual barrier, stage output and borrower, raw/portable inputs, runtime, tools, parent. On failure, the same owner is retained and cannot be cleaned up via a new supervisor or global deletion.

The stage receipt verifies the actual **`ArtifactJob::request_binding()`**, original completion/file identity,
ticket, independent producer pins, manifest/content-addressed blobs, exact file set, and site/index/startup
original byte hash individually. Startup intent, generated JSON, and generated MJS are in three separate hash domains.
JSON semantic comparison follows Node's limited IEEE754 numeric handling, preserves original bytes, rejects duplicate keys, unknown fields, and budget overruns. Changes in numeric formatting are not erroneously interpreted as configuration changes, nor can they generate original byte proofs through re-serialization.

The stage profile shares the original ledger and a unique finite job slot, reserving 4 GiB memory/disk, 114,768 files,
14,386 directories, 8 namespaces. The recipe includes one runtime, one control root, two raw,
two portable, and two stage. Each stage reserves 512 MiB memory/disk, 16,392 files,
2,050 directories, and one namespace; process retirement only releases the finite slot, with the remainder of the budget retained until final cleanup.
Sites that are retired but still borrowed by future consumers like HTTP continue to occupy the slot. This is a logical admission policy, not RSS measurement or filesystem hard quotas; actual peak usage and cross-platform performance still require independent validation.

The **`runtime_ready`** and **`presented_ready`** of this interface are always **false**. A successful static site cannot serve as evidence of acceptance for Workers,
browser, CanvasKit, GPU, official DevTools, or seven hosts. The frozen release list remains unchanged.
