<a id="浏览器-dom-呈现器边界"></a>
# Browser DOM presenter boundary

[简体中文](DOM-PRESENTER.md) · **English**


`dom-presenter.mjs` is an independent presenter for evaluated
`container-ir::ViewDocument` version `1.0` with the explicit `webview` profile.
It creates a separate, script-disabled iframe. The browser lays out real DOM and
CSS; the input contains no Rust bounds, and the presenter rejects RenderFrame
geometry fields. It never evaluates WXML, WXS, modern View code, or HTML strings
from an application.

```js
const presenter = new DomViewPresenter(container, {
  resolveResource: async (descriptor, context) => {
    // The host loads descriptor.sha256, verifies bytes, then owns this lease.
    return { url: verifiedBlobUrl, release: () => URL.revokeObjectURL(verifiedBlobUrl) }
  },
  onEventBatch: batch => host.acceptDomEvents(batch),
  onError: error => diagnostics.push(error),
})
const receipt = await presenter.submit(evaluatedDocument, {
  viewport: { width: 375, height: 667 },
  frameId: 1,
  configGeneration: 0,
  signal,
  isCurrent: () => generationIsCurrent,
})
presenter.dispose()
```

The initial component set is `view`, `text`, bitmap `image`, `scroll-view`, and
text/password `input`. Resolved custom component hosts can retain their already
expanded children and ownership. Native input elements preserve browser focus,
editing, disabled state, and pseudo-class behavior. Image modes are
`scaleToFill`, `aspectFit`, and `aspectFill`; other modes fail explicitly.

WXSS is generated from raw rule IR. Import order, conditional groups and instance
scopes are retained, `rpx` uses the logical viewport's 750-unit grid, and normal
CSS layout remains browser-owned. Selectors use zero-specificity ownership
qualifiers to keep scope boundaries without adding selector specificity. Bitmap
URLs in source attributes or CSS must resolve to an exact manifest resource and
pass through the host resolver. The presenter never authorizes an arbitrary
source URL. The host resolver remains responsible for verifying content hashes,
byte sizes, access policy and resource leases.

Each submission builds a hidden candidate and waits for its images, fonts and
browser layout. It publishes one geometry batch and a correlated receipt only
after preparation succeeds. Failure, cancellation and stale revisions preserve
the accepted surface. Compatible input values, focus/selection and scroll state
are restored across successful replacement. `measure()` returns updated browser
geometry after native scrolling. Call `dispose()` to release the owned iframe,
listeners and resource leases.

Events are collected through document listeners. One batch contains target IDs,
typed dataset values and an ordered capture/bubble listener plan with declaration
ownership. `catch` stops propagation synchronously. The host must validate the
session, page, revision and target IDs before dispatching this batch; it must not
trust a browser-provided handler name as an independent authority.

Unsupported components, events, input modes, image modes, nested/late imports,
CSS nesting, escaped selector syntax, animations/transitions and font-face rules
fail with `ERR_UNSUPPORTED_CAPABILITY`. This subset does not implement complete
WeChat component CSS isolation, native IME/keyboard policy, every touch/default
action, slot declaration discovery, or platform WebView adapters. `slotOwner`
is preserved when supplied, and never inferred from DOM ancestry. Browser CSS
support is checked against the actual iframe environment; it is not an official
WeChat conformance oracle.

Validation commands:

```bash
node --test scripts/dom-presenter.test.mjs
node scripts/dom-presenter-browser-smoke.mjs --out artifacts/dual-renderer/dom-browser-new
```

The browser smoke uses a **synthetic evaluated ViewDocument**. It verifies actual
browser layout, scoped styles, resource decoding, trusted click/input/wheel
interaction, state retention, candidate failure, logical resize and cleanup.
It saves the exact input/source hashes, geometry receipts, JSON report and a
screenshot. Its result is **standalone presenter evidence**, not a runtime
end-to-end test, official WeChat comparison, GPU claim, native WebView/device
acceptance, accessibility audit, or performance gate. Runtime admission must
remain unavailable until its separate DOM session/geometry/event/ACK adapter and
corresponding evidence are implemented.
