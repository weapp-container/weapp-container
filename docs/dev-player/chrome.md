# Mini-program host chrome

The preview.4 Dev Player uses a fullscreen mini-program shell on Android, iOS,
macOS, Windows and Linux. “Fullscreen” fills the client content area while
retaining mobile system bars and desktop window decorations. The active preview
has no Player AppBar, permanent tool strip, fixed aspect ratio or outer padding.

## Navigation and capsule

The runtime resolves verified app `window` configuration and page overrides.
The SDK emits a versioned `chrome` observation, including page/stack, title,
colors, navigation style and configured system tabBar. Flutter does not parse a
second copy of app/page JSON. Dynamic title/color changes belong to page instances.
Tab selection uses runtime `switchTab`; the client does not maintain another
mini-program router.

Normal navigation reserves the system top inset and a host navigation bar.
Custom navigation extends the page beneath the retained system status bar;
the floating capsule stays below the actual top inset. Its translucent backing
contrasts with the configured foreground independently of navigation background.
Custom pages without a system tabBar also paint through the home-indicator area;
the native safe-area observation remains available to the program. Host
diagnostic controls avoid that area independently. Normal navigation and system
tabBar control layouts retain their bottom safe-area handling.
More opens tools,
logs, performance, reload and project information. Close returns to the project
screen and releases the accepted/candidate session and native surfaces while
retaining connection, verified packs and persistent storage. A new generation
does not reopen a closed program. Reopening starts a new instance.

Tools occlusion is separate from application foreground/background. It gates
native preview input and presentation, leaves business timers running and does
not generate a false app lifecycle. Downloads can complete while tools are open;
activation waits until the preview is available.

## Geometry and SDK negotiation

The additive SDK `chrome` capability negotiates protocol `1.0`. `state.chrome`
and `chrome` events are scoped to the actual session and page. The `hostChrome`
command carries schema version, a monotonic layout revision, measured content
rectangle and measured capsule rectangle. Rectangle coordinates are logical
screen pixels; mini-program input remains local to the content surface.
Flutter measurements carry an explicit client-coordinate marker. Native SDK
bindings translate them using the observed native window/view origin before
submitting `hostChrome`; native overlay layout retains client coordinates.

`windowMetrics` remains the authoritative native surface/display observation.
The host does not infer or rebase its safe-area observation from capsule geometry.
Android quantizes the content viewport at the native measurement boundary using
the same physical-pixel rounding as its surface metrics. Capsule coordinates
retain their measured fractional screen positions.
Initial chrome is inspected from a verified pack before starting page code, so
the host can supply initial capsule geometry. Runtime APIs then expose the
measured rectangle. Rotation, window resize and navigation changes update the
host geometry; stale revisions are rejected.

For a configuration-changing restart, the host measures a prospective shell
under the accepted view. `prepareHostChrome` only translates/validates those
rectangles; it does not mutate the accepted session. `initialHostChrome` is
passed into `load`/`applyDevPack` for candidate initialization. A failed startup
keeps accepted geometry and state; success commits the candidate and waits for
matching native surface metrics before authorizing presentation and input.

Ordinary runtime navigation still executes the destination page lifecycle before
the host observes its new navigation layout and submits a resize. Therefore an
`onLoad` geometry query during a normal/custom navigation transition can observe
the preceding content size. The initial-load and pack-restart transaction above
does not prove lifecycle geometry parity for these ordinary transitions.

Android/iOS/macOS use their existing GPU-backed preview composition. Windows
and Linux own native chrome above their child surface. Before Flutter menus or
tools cover a native child preview, that preview is hidden; restoration requires
valid geometry and a matching native frame. No screenshot or CPU raster fallback
substitutes for a native GPU surface.

Linux X11 can observe the screen origin. Wayland compositors do not expose a
global window origin; this screen-coordinate profile therefore rejects that
combination with `ERR_UNSUPPORTED_CAPABILITY` instead of inventing coordinates.
Wayland host execution remains an open platform requirement.

## Reproduction and evidence

```sh
pnpm simulator:dev -- --project examples/apps/player-chrome-app --surface devices
```

Connect a matching preview.4 Player. The fixture exercises default/custom
navigation, dynamic title/color, system tabs, measured capsule geometry, navigation
back, and persistent storage across close/reopen. Verify portrait/landscape,
notches, system bars, long titles, text scaling, input hits and visible errors.

Record host, source/SDK commits, binary hashes and the precise scope of every
result. Unit/widget tests do not execute native UI or GPU presenters. Missing
devices/windows remain blocked; historical preview.3 runs retain their original
source bindings and are not upgraded by this interface change.

The [scenario inventory](chrome-cases-v1.json) fixes 20 scenarios and 97
applicable platform cases. Widget/Rust tests are reported separately from these
actual-window cases. The existing five-platform release gates remain unchanged.

## Preview.4 execution results (2026-10-29)

The [source-bound execution report](../archived-evidence.md)
records the actual Xiaomi Android 16 device and iOS 27 simulator attempts. The
final Player source is `c8d99195`; native runtime binaries were produced from
`bf9b8cf8`. Those identities are deliberately separate.

Fullscreen/default/custom navigation, capsule interaction, runtime tabs,
close/reopen with retained storage, and safe WXSS updates have actual execution
evidence. This is an implementation milestone, not a completed five-host gate.

Two real failures remain open on Android/iOS:

- **C013:** `onResize` can observe the new window dimensions together with the
  preceding orientation's capsule rectangle. Native metrics and post-frame
  chrome currently arrive through separate updates. They need one versioned,
  owner-bound layout transaction before invoking guest callbacks.
- **C018:** a candidate startup error can produce `ERR_DEV_OUTCOME_UNKNOWN` and
  pause the accepted preview. Player currently compares presentation revisions
  when reconciling pack ownership; ordinary accepted-page timers can advance
  those revisions. The SDK needs a separate accepted pack identity. Removing
  the frame comparison alone would misclassify an ambiguous in-place commit.

macOS execution is blocked by the absence of a valid development signing
identity. Windows/Linux actual-window execution and hardware performance/leak
acceptance remain open. A correct screenshot, unit test or native frame ACK
does not discharge these requirements.
