# Developer Raster simulator construction and reload

`Simulator::from_dev_raster_pack_dir(path, config)` is an explicit library
factory. It validates the same manifest, blobs, native engine and render target
as `from_pack_dir`, and enables the existing Session `ExplicitDev` policy before
`app.init`. The public `SimulatorConfig` has no additional policy flag. Normal
`from_pack_dir`, headless runs and the current CLI keep synchronous Raster
presentation. This factory does not attach strict HTTP, browser RAF receipts or
input admission by itself.

An exact owner must publish the accepted pixels and the ticket issued by
`Session::prepare_dev_raster_presentation`, then acknowledge that exact ticket
after its presenter succeeds. Factory construction, `run()` success and HTTP
queue acceptance do not prove presentation. Browser routes continue to use
their separate DOM authority; a current WebView page does not disable the
Session's policy for later Raster pages.

`apply_dev_pack` reads `raster_presentation_policy()` from the current Session,
including a pre-init opt-in made through `host_mut`. Both validation and
renumbered restart candidates enable that policy before startup. There is no
second simulator policy, owner ledger or copy of a live lease. In-place updates
keep the original Session and its existing runtime invalidation rules; they do
not transfer an old ticket to a newly rendered frame.

Activation is derived from the existing Session's initialization/pages as well
as completed simulator startup. A caller that activated the runtime through
`dispatch` or `host_mut`, or encountered partial startup, may still reload it.
That replacement is a restart with a fresh session identity even if its pack
only changes presentation or is byte-identical. A truly pristine instance keeps
the original pre-run replacement behavior.

A successful restart runs its isolated candidate first. It then retires the
old explicit runtime through `retire_dev_preview` before replacing the host.
The new Session starts without a presentation lease and awaits its own issued
ticket. Old-session tickets and envelopes cannot acknowledge the replacement.
Every actual restart uses a checked generation increment. Exhaustion returns
`ERR_RENDER` before startup or old-runtime retirement, rather than reusing a
session identifier; this applies to synchronous and explicit policies.

Invalid manifests, blobs, engines or candidate startup preserve the old host and
its authority because retirement has not begun. A failure during old-runtime
retirement also preserves that host and session identifier, but its old input
and presentation authority remain revoked. Consumed callback effects and error
envelopes stay with that Session; a diagnostic request can drain them. The
candidate is not published, and cleanup is not treated as a successful rollback
to an interactive old frame.

ExternalFrame and NativeGpu are not substituted for Raster. The explicit
factory reports unsupported mode/backend errors; an uncompiled engine retains
the `ERR_ENGINE` boundary and never falls back. The existing runtime pre-init
restriction still rejects an attempted upgrade after synchronous initialization.

The source includes native QuickJS/V8 consumers for real Page.onLoad/onReady
data, repeated JS and route/configuration restarts, runtime-issued tickets,
old-ticket rejection, actual software-contact cancellation, timer execution,
in-place reload, pre-init opt-in, rejected candidates, retirement failure,
generation exhaustion, incompatible modes and current WebView pages. These are
test definitions until the exact integrated commit executes them. Rust library
ACKs are test actions, not browser RAF, GPU, platform or DevTools acceptance.
