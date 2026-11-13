<a id="dom-准备消耗输入元数据"></a>
# DOM preparation consumed-input metadata

[简体中文](dom-consumed-input.md) · **English**


A successful final bridge `view.prepare` response may include an optional
`scheduling` field next to the unchanged `submission`:

```json
{
  "ok": true,
  "submission": { "...": "existing BrowserViewSubmission v1" },
  "scheduling": {
    "version": "1.0",
    "key": { "...": "exact submission.key" },
    "consumedInput": {
      "pageId": "1",
      "routePath": "pages/home",
      "templateRevision": "42",
      "viewport": { "x": 0, "y": 0, "width": 375, "height": 667 }
    }
  }
}
```

The runtime reads `Session::browser_page_input(&submission.key)` immediately
after preparation. That candidate already holds the root-data clone-boundary
snapshot; component hooks, later effects, geometry and ACK cannot replace what
it consumed. Page/template IDs stay canonical u64 decimal strings. The full
`Rect` is retained because nonzero x/y are accepted. Its f32 values are promoted
to f64 on the wire, matching the exact actual submission width/height.

Explicit render data produces `consumedInput: null`, including data equal to
the current page. Detached development preparation has no authoritative page
snapshot and cannot produce consumed proof. Absence of the entire scheduling
field remains compatible with existing clients/servers; it does not mean a
preparation consumed the current page. A future product scheduler must require
an advertised scheduling capability before relying on this optional metadata.
This patch does not add such product negotiation or enable a Worker product.

`DomSessionClient` validates the metadata version, exact full presentation key,
canonical IDs, route against `submission.document.routePath`, and width/height
against `submission.viewport`. It retains finite x/y and returns an independent,
frozen `scheduling` object from `present()`. Missing/null proof stays missing/null;
metadata on a later ACK is ignored. Invalid metadata fails before presenter
preparation and aborts the exact runtime candidate.

These are scheduling facts, separate from presentation/input authority. They do
not enter the permit, ACK payload, application data or DOM observation lease.
The existing `prepare → commit → presented` transaction still controls input.
They are not screenshot, physical-display, browser or performance evidence.

External Skia frame consumed-input provenance remains unimplemented. A complete
change must carry `ManifestViewInput.page_input` through `PreparedViewFrame` and
commit publication, bind it to the exact render revision, preserve it for
retained scroll/scale paints, return no proof for explicit frames and detached
previews, and retire it on manifest/session replacement. Sampling runtime state
after frame/ACK would lose the clone-boundary guarantee. That wider runtime/host
change is deliberately outside this independent DOM patch.
