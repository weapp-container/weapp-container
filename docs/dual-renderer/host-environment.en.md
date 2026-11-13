<a id="appservice-宿主环境安装"></a>
# Installing the AppService host environment

[简体中文](host-environment.md) · **English**


The runtime installs capabilities, DOM query policy, sync API values and errors, storage, and file mirroring as a versioned installation with version `1.0` of the `HostEnvironmentSnapshot`. QuickJS and V8 retain private installation functions during bootstrap, which are subsequently invoked via the native JSON parser; the installation process bypasses application-writable global functions and does not execute application microtask checkpoints.

The installation function first validates and prepares all replacement fields, then updates the private lexical cells. Using intrinsics and null-prototype descriptors captured during bootstrap, it avoids triggering environment repair that would invoke application-replaceable property accessors or exception string conversions. The original global mirror names are retained as diagnostic aliases; modifications to these aliases do not replace the trusted installation entry point. The types `wx`, App, Page, and Component are not frozen as a result, and the independent realm for WXS/modern View remains unchanged.

<a id="业务状态与效果消费"></a>
## Business State and Effect Consumption

The values `storage: None` and `files: None` indicate retention of the current private business container; `Some` indicates explicit replacement. Geometric repair retains file writes that have not yet been handed over to the host. When a Rust storage revision change requires a storage replacement, the installation replayes the pending intent, preserving set, remove, clear, undefined, and the last write order. This chain only records pending intents and does not constitute a second authoritative storage copy.

Effect drain holds the batch of events and the storage tail. New effects are queued for the next batch. If the native JSON conversion or execution budget fails during consumption, the batch is not processed; upon success, a private token is used to confirm consumption, and only the prefix is retired. Writes generated during serialization and subsequent microtasks are considered part of the suffix. The token is removed from the public `{ events, errors }` result; the dedicated drain and the original `JsEngine::call` global entry point share the same consumption boundary.

<a id="dirty-gate-与失败"></a>
## Dirty Gate and Failures

After a host geometric epoch change, ordinary AppService calls, module registration, effect continuation, and owner turn all perform a full environment check before entering application code. For an owner turn, the original budget is established first, then the repair is executed; if a native fault is detected, entry into application code is prevented. Only upon successful installation is the installed epoch and storage revision updated.

A real native installation failure causes the session to enter a sticky engine fault, and subsequent application calls are explicitly rejected, requiring a new session. No compensation JavaScript, resize, or cleanup callbacks are executed after a failure. For headless protocols lacking a native engine, behavior remains within its original boundaries and cannot serve as proof of JavaScript execution.

This is the precondition for the host image of logical resize. The handling of view candidates, web capacity reservation, co-publishing, actual presentation receipts, and one-time resize hooks are each managed within their respective boundaries; this interface does not rollback application, storage, timer, or View state. Execution results must be separately bound to the tested commit. Source code testing definitions and format checks do not constitute a successful run.
