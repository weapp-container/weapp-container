# Isolated View engine

An explicit [modern JS/TS View profile](modern-view.md) is also available.
Schema v2 packs declare its compiler/ABI, source maps and verified source closure.
It uses a separate realm with standard JavaScript semantics; the WXS dialect
and function-argument copy contract below apply to the legacy profile.

`container-core::ViewEngine` is a separate batched execution boundary implemented
by `QuickJsViewEngine` and `V8ViewEngine`. It supports isolated expression and
whole-document WXML/WXS evaluation. A native-enabled `Session` owns this View
realm separately from AppService and submits page/component render frontiers
through it. Declared, verified WXS modules are loaded into this realm only.
Legacy WXS without a trustworthy module graph remains explicitly unsupported;
an unavailable selected native provider returns `ERR_ENGINE`.

The packer's WXS graph pass parses source with pinned Acorn Script grammar
through ECMAScript 2020. It distinguishes executable loader references from
division, regex, strings and comments, without transforming the original bytes.
This graph acceptance policy is separate from WXS dialect conformance and is
not a reflection sandbox. Native `require` resolves only declared dependency
edges, including when source obtains the loader indirectly.

Portable packs also carry optional `viewCompilation` metadata. Compiler
`weapp-container-wxs` version `1.0.0`, helper ABI `1.0`, lowers both WXS module
code and WXML expressions into separate content-addressed executables. Module
records bind `id`, `sourceSha256`, `executableSha256` and the hygienic `helper`
binding. Document records bind `documentId`, `wxmlAst` and each expression's
`source`, `shorthand`, `executableSha256` and `helper`. The original WXS source
blobs and WXML AST remain unchanged; compiler identity and executable hashes
belong to the manifest integrity root and runtime program/reload identity.
Hosts preload this complete verified resource closure in the initialization
batch. Missing, changed or unsupported compilation metadata fails explicitly.

The lexical helper implements property reads, captured method receivers,
invocation and writes without replacing native prototype constructors. In
compiled code an inherited standard `constructor` reads as `Number`, `String`,
`Boolean`, `Object`, `Function`, `Array`, `Date` or `RegExp`. Own properties,
inherited overrides and getters remain observable. Native Array methods retain
their normal species behavior. The ABI preserves argument order, receiver,
strict/sloppy writes, compound/update/delete timing and `for-in` property writes;
raw property keys are converted separately at native read and write boundaries.
WXML binds the helper inside an inner lexical function so its data scope cannot
intercept the binding. Direct `ViewEngine` inputs without compilation metadata
retain ECMAScript property semantics; they do not implicitly acquire this dialect.

This is a versioned admitted syntax subset, not a security sandbox or complete
official WXS compiler. Unsupported lowering forms return
`ERR_UNSUPPORTED_WXS_SYNTAX`: lexical `eval`/`Function`, `with`, imports,
optional operations, async/generators, tagged templates, classes, destructuring,
spread/rest and `for-of`. Graph restrictions remain an additional requirement
for packaged WXS. Reflection and all unobserved dialect differences remain
outside a proven compatibility claim.

Each adapter owns a new native runtime/isolate and context. It does not install
the AppService bootstrap, `wx`, `App`, `Page`, `Component`, `getApp`, host
providers, storage or timers. View calls never drain either View or AppService
microtasks. The existing AppService engine API is unchanged; V8 platform
initialization is shared once per process, while isolates remain separate.

## Batch contract

- `load_modules` validates a complete module graph and compiles every factory
  before replacing the registry. Factories execute only when a lexical alias
  is first read. A rejected load leaves the previous registry intact.
- `evaluate_batch` compiles full expressions and validates unique occurrence
  IDs, document bindings and all tasks before invoking module code. Expressions
  retain JavaScript short circuiting and intermediate values. This is not
  expression-string caching or eager extraction of individual function calls.
- `render_batch` accepts a document graph and page/component tasks. Each task
  transfers its data once; WXML branches, loops, template data and includes
  execute in order inside the View realm, returning a complete evaluated AST.
  It does not call Rust once per expression or node. Document paths, lexical
  bindings, source ASTs, dependency edges and expression syntax are checked
  before stateful module execution. Named templates use their declaring
  document's WXS aliases; includes retain the caller's data and switch lexical
  document. Raw inline WXS text is validated against the loaded source and is
  never scanned as WXML binding text.
- Evaluated ASTs retain typed `boundValues`, repeat keys, `keyScope` and
  UTF-8-length-based `sourceSite` identities. Every evaluated node also has a
  typed `lexicalOrigin.documentId`, generated from its evaluation environment
  and validated against the submitted document registry. Includes and imported
  named templates use their declaring document; projected slots preserve their
  origin. This origin is independent of component configuration and event
  ownership, and is never inferred by parsing a `sourceSite`. Values produced by bindings are
  never evaluated again as source. Only JSON data can enter attribute values;
  unsupported objects, functions and non-finite numbers fail explicitly at
  that boundary. Intermediate values stay inside View until consumed.
- Modules use a `(scope_id, module_id)` cache. Each page/component instance must
  supply its own scope ID. A scope can render several documents with distinct
  aliases; `(scope_id, document_id)` bindings remain fixed until module reload.
  Inline module IDs must match both declaring document and alias.
- `release_scopes` validates the full list before releasing exactly those
  caches and document bindings. Other page/component instances retain their
  module state. Releasing an unknown scope is harmless; duplicate IDs are an
  invalid batch. Expression and document evaluation share the same cache.
- `require` accepts declared relative `.wxs` dependencies only. Cache entries
  precede initialization to support cycles and partial exports. A failed module
  entry is removed for retry; successful dependency entries remain cached.
  Falsy `module.exports` and replacement versus `exports` rebinding are distinct.
- Every call through an exported/returned function copies its entire argument
  graph once. Aliases inside a call survive; data mutations do not leak to a
  later call. The receiver unwraps to the original module object so stateful
  methods retain identity. Explicit data receivers copy with the argument graph,
  including aliases between the receiver and arguments. Nested/frozen exports and returned functions stay
  inside the same membrane. Native `call`, `apply` and `bind` preserve this
  boundary, while custom function properties retain their own implementation.
- Final results use recursive `ViewValue` tags. `undefined`, null, NaN,
  infinities and negative zero survive; repeated references in an acyclic graph
  are accepted. Functions, cycles, promises/thenables, symbols, bigint and
  non-data objects fail explicitly. No user `toJSON` method is invoked.
- A failed evaluation returns no partial result batch. Module state may already
  have changed; callers must commit only a complete successful frame.
  This API alone does not implement transactional rollback of arbitrary scripts.

`register_documents` prepares an immutable `ViewDocumentProgram` and returns an
opaque, process-local handle. `render_registered_batch` then transfers that
handle's private token and the current tasks, without retransmitting the static
AST or recompiling unchanged expression wrappers. The runtime registers every
participating profile before executing any stateful task, using the same total
batch deadline. It still validates dynamic tasks, complete results and lexical
provenance; the public `render_batch` boundary continues to validate its full
external input. No function results are cached and call order is unchanged.

Each realm retains one active document registry. Successful replacement,
module reload, reset or disposal revokes its previous handles; another realm's
handle is rejected before entering JavaScript. An ordinary, proven preflight
rejection preserves the previous registry. Timeout, cancellation or an
unexpected VM/receipt failure requires a fresh realm. A registration accepts at
most 4,096 documents and 16 MiB of encoded static input. This is an input bound,
not a total heap limit; the separate expression cache retains its existing
4,096-entry bound. Provider timings distinguish registration from warm renders
and report their input byte counts.

The native transport uses intrinsic JSON APIs and immutable bootstrap
entrypoints. A shared guard rejects recursive calls into those entrypoints;
modules cannot replace the registry from inside an evaluation. Transport
intrinsics are captured and relevant constructors/prototypes are frozen.
`Function.prototype` remains writable because transport methods were captured
before execution. Internal error codes are branded privately, so a module
throwing `{code: 'ERR_TIMEOUT'}` is an execution exception, not a native timeout.

## Budgets and disposal

`ViewExecutionBudget` supplies one monotonic duration and an atomic cancellation
flag per batch. It covers input encoding, compilation, require, execution,
accessors, exception conversion, output encoding and Rust decoding. The default
is 50 ms; callers can choose a different budget. QuickJS checks a native
interrupt handler and completion time. V8 uses a thread-safe termination handle;
each watchdog is cancelled and joined before returning, preventing a late
interrupt from reaching another turn. V8 also prohibits `Atomics.wait`.

`SessionConfig.view_execution` exposes the typed `ViewExecutionPolicy` with
`batch_timeout_ms`, defaulting to 50 when omitted. Explicit limits must be
between 1 and 86,400,000 ms. The policy also bounds cold View program preparation;
it does not remove initialization, transport or mixed-profile work from the
existing shared batch deadline. The effective allowance remains the minimum of
this limit, the remaining AppService host turn and a supplied bridge deadline.
It neither enables an unavailable engine nor changes AppService execution
policy. Non-performance fixtures may explicitly choose finite extra headroom;
that does not change production defaults or establish latency acceptance.

Timeout/cancellation discards the entire View realm. Later operations return
`ERR_VIEW_REQUIRES_RESET`; `reset` creates a fresh realm with no modules or
caches. `dispose` releases it explicitly. AppService state is independent.
These budgets use cooperative engine interrupts and completion checks; Rust
serialization, compilation and native builtins do not constitute a hard realtime
or operating-system sandbox guarantee. Native engines remain thread-affine.

### Optional native batch diagnostics

The `container-core/view-batch-diagnostics` Cargo feature adds an optional
`lastBatch` record to provider timings on Android, Linux, macOS and iOS.
QuickJS and V8 also forward this feature. It is disabled by default. Unsupported
platforms and failed clock samples report unavailable fields rather than zero.
The record contains only a closed operation/profile/engine identity, a
thread-local sequence, native owner-thread ID, monotonic/boottime anchors,
thread CPU samples and a stable error code. All u64 values cross JSON as
decimal strings. No guest script, data, path, error message or stack is included.

`android-view-atrace` additionally enables an Android ATrace RAII section when
the platform trace facility is actually enabled. It does not start a trace or
grant permissions. Sections close on the owner thread, including early returns;
they never move to the V8 watchdog thread. Diagnostics neither arm nor extend a
deadline, clear cancellation, change a result, nor revive a poisoned realm.

Wall time and thread CPU are separate observations. Their difference alone
does not identify GC, scheduling, OS suspension or virtual-machine host pauses.
Use matching owner/batch and clock anchors with a separately bound platform
trace before attributing a real timeout. Failed clock samples remain null;
instrumented builds need their own source/binary and overhead evidence.

Native features are required. Stub constructors return `ERR_ENGINE`; they do
not substitute another engine. The isolated WXS realm now exposes the
`getDate(...args)` and `getRegExp(pattern, flags)` helpers in both native
engines. The latter accepts only the documented `g/i/m` flags; invalid or
duplicate flags fail the complete evaluation batch. The helpers are immutable
realm globals available to module factories and WXML expressions; captured
constructors and frozen prototypes preserve them if module code replaces a
global constructor. They return the engine's native Date/RegExp objects for use
inside a WXS call; an opaque object returned directly to Rust, or passed as an
argument across the exported-function membrane, is rejected at the transport
boundary instead of being silently serialized. No async checkpoint
is provided. Promise results are rejected, and internally queued jobs are not
run. Compiled module and WXML expressions use the constructor-string ABI above;
raw direct View calls retain ECMAScript behavior. Argument coercion edge cases,
the complete WXS dialect and official observable semantics still need versioned
DevTools evidence. Native JavaScript prototype constructor values remain intact.

The public [WXS datatype reference](https://developers.weixin.qq.com/miniprogram/dev/reference/wxs/06datatype.html)
documents these helpers and the constructor-string behavior. It is a public
reference, not a version-pinned observation of DevTools `2.02.2608080` / SDK
`3.17.3`. Local engine tests exercise UTC getters/setters, RegExp state,
intrinsic replacement, flag rejection and the existing opaque-value boundary;
date-string parsing, local timezones, locale output and exact official errors
remain unverified against that runtime. The official constructor/datatype oracle
is still `unknown`; neither public documentation nor local engine results change
that status.

## Session integration and validation

Both engine crates include the identical contract tests from
`crates/container-core/tests/support/view_engine.rs`, in addition to native
isolation, cancellation, timeout, getter, reset and microtask tests:

```sh
cargo test -p container-engine-quickjs -p container-engine-v8 --locked \
  --features container-engine-quickjs/quickjs-native,container-engine-v8/v8-native

cargo test -p container-runtime --test view_render_conformance --locked \
  --features quickjs-native,v8-native

cargo test -p container-runtime --test session_view --locked \
  --features quickjs-native,v8-native
```

The shared render contract lives in
`crates/container-core/tests/support/view_render.rs`. The runtime's
`tests/view_render_conformance.rs` compares parsed WXML with the current Rust
IR evaluator, including keyed reorders and slot projection. This is an
auxiliary compatibility baseline, not an official semantic oracle. In
particular, the current template-data caller fallback is preserved and named
explicitly in that comparison; it does not prove official scope isolation.
Native JavaScript property access, the WXS language dialect and official
module/call ordering still need versioned DevTools evidence.
Native object spread currently accepts more values than the Rust evaluator.
A bare `wx:key` is a literal own property name on an object item, including
keywords and punctuation; it is not compiled as JavaScript. A primitive item
with a bare key produces a null key; use `*this` for the item value. The existing
dotted loop-scope expression extension is retained and compiled, but is not an
official compatibility claim. Neither input validation nor a retained frame
constitutes script-state rollback.

`pnpm runtime:wxs-dialect:smoke` packs a raw mini-program fixture and reads its
actual WXML dataset on native QuickJS and V8. It compares all eight constructor
names, computed/own reads, native Array methods, inline/external WXS, WXML-global
reads and `for-in` writes. Its report preserves source and executable hashes,
compiler identity and both traces. This remains auxiliary evidence, not an
official oracle, a `weapp-vite` output regression or host/GPU/performance evidence.

Session verifies module content and its declared dependency graph before
AppService startup, and prepares each unchanged View program once. Page roots
and each pending component frontier cross the native boundary as whole-document
batches. Receipts, task identities, ASTs and lexical origins must all validate
before any result ticket is published. Leases are recorded before execution,
including calls that fail after changing native state. Confirmed page/component
disposal releases its exact View scopes; hidden/cached pages retain theirs.
Timeout, cancellation, malformed receipts or uncertain release lock the View
realm until the host replaces the session. Session never silently resets that
heap or falls back to Rust evaluation. The featureless QuickJS protocol test
boundary still uses the explicit Rust evaluator for documents without WXS.

Session retains the latest document work per concrete
page/component occurrence. Preparation and the first frame share that work;
component discovery and lifecycle flags do not create new data inputs. An
A → B → A sequence is three updates, and a failed input remains failed until
its data/program changes or an explicit retry is permitted. Candidate previews
own copies of this work, not copies of the native heap. Managed and declarative components use one
occurrence planner: keyed identities, declaring-component resolution, slot
projection and retained work share the same traversal. Unused light content
does not allocate occurrences; successful plans release removed work. Direct
manifest rendering before `page.push` owns a separate session cache. The
declarative path retains its transparent custom-host representation and does
not run component JavaScript lifecycles. It remains a headless presentation
contract, not evidence of official host geometry or lifecycle equivalence.

Managed reconciliation preserves work and the primary error when recovery
also fails. Confirmed disposal advances the durable checkpoint before relation
publication, so later failures cannot restore detached scopes. Possible scopes
are owned before calling the engine, including calls that mutate JavaScript but
fail before returning snapshots. Complete batch receipts validate unique scope
and instance identities, snapshots and requested-scope coverage. Disposal also
acknowledges every requested scope, including those already absent during retry;
a transport success or partial response alone cannot release ownership.
An unacknowledged mutation or failed cleanup
invalidates that managed page: render/lifecycle discovery cannot replay it,
and the host must restart the session. Ownership is retained for teardown;
AppService is still callable for diagnostics and disposal. This does not roll
back JavaScript state or freeze all AppService inputs.
Teardown order uses stored parent relations and prepared sibling order;
scope identifiers remain opaque, including when a new nested occurrence was
prepared after its parent's siblings.
Successful prepare receipts also retain exact parent binding inputs, separately
from defaulted properties and component-local data. Changed inputs settle in a
batch before descendant discovery, preventing a rejected update's surviving
JavaScript state from transiently recreating an already disposed child.

After successful cleanup of a rejected component frontier, a bounded failure
memo retains the rejected parent input and surviving component snapshots. Idle
discovery returns the original error without recreating disposed transient
components or rerunning their WXS. Changed parent data/program or surviving
component inputs permits a new attempt; no transient native heap is retained.

Compiled View packs require a session restart whenever compiler/ABI identity or
an executable module changes. When WXS state exists, document program, WXML or
lexical binding changes also restart. Without WXS state, changed document
expressions can be validated in an isolated presentation candidate and preserve
the session. Style/asset previews may reuse live cached ASTs;
uncached executable work is rejected. Documents without WXS may evaluate in an
isolated candidate realm. No preview executes speculative code in the live
View heap, and no cache copy claims to clone arbitrary native state.

Live manifest replacement rejects changes to execution/configuration inputs
at the Session boundary as well as in the simulator classifier. Presentation
reload validates before publication. Once `render.commit` publishes a frame,
its response includes `committed: true`; ready-hook/effect failures follow as
error diagnostics and cannot roll the manifest back behind those pixels.
Rejected render responses include `committed: false`. Script effects and
component lifecycle calls are not a rollback transaction.

Local native and Session tests do not establish official DevTools, WXS dialect
equivalence, shared-template WXS HMR,
GPU/device, seven-host, performance or near-parity acceptance.
