<a id="会话渲染资源"></a>
# Session render resources

[简体中文](render-resource-store.md) · **English**


Hosts can preload content-addressed render bytes once with `app.init` and reuse
them for subsequent manifest frames. This avoids serializing the portable pack
on every display tick. The resource store belongs to a single runtime `Session`;
it is an immutable Rust `Arc<BTreeMap<String, Vec<u8>>>`. Selecting it clones the
handle, without cloning resource byte buffers or crossing the host bridge again.

```json
{
  "op": "app.init",
  "payload": {
    "modules": [],
    "blobs": {"sha256:<digest>": [123, 125]}
  }
}
```

The shortened examples show envelope `op` and `payload`; actual requests also
include the usual protocol version, session ID, request ID and kind. Each blob
key must match its bytes' SHA-256. The normal View-resource validation also runs
before these bytes enter the store. `modules` uses the existing AppService
module contract and is independent of the render store.

```json
{
  "op": "render.commit",
  "payload": {
    "templateId": "template:pages/index/index.wxml",
    "frameId": 2,
    "viewport": {"width": 390, "height": 844},
    "useSessionResources": true
  }
}
```

Omitting `data` renders the current runtime page data. The reuse flag changes
only the source of render bytes; template, style, View-script, component,
layout and renderer checks still apply. The existing nested
`{"frame":{"templateId":"…","useSessionResources":true}}` form also works.
The flag must appear in the same object as `templateId` or `template_id`.

Selection rules are explicit:

| Request | Result |
| --- | --- |
| Flag omitted or `false`, valid `blobs` | Existing explicit-byte rendering; a successful commit installs its store. |
| Flag omitted or `false`, no `blobs` | `ERR_RENDER`, even if a previous store exists. |
| Flag `true`, verified nonempty store | Render with that session's store. |
| Flag `true`, any `blobs` property | `ERR_INVALID_REQUEST`, including `blobs: null` or `{}`. |
| Flag present with a nonboolean value | `ERR_INVALID_REQUEST`. |
| Flag `true`, empty, unverified or invalidated store | `ERR_RENDER`. |
| Flag `true`, raw frame with no manifest template | `ERR_INVALID_REQUEST`. |

Flag and resource checks precede component hooks and frame publication.
Supplying invalid hashes or an incomplete explicit candidate fails without
falling back to earlier bytes. The previous published frame and accepted store
remain available. Explicit candidate bytes replace the store only after the
renderer accepts their generated frame. As with other render commits, errors
from ready hooks after publication are reported separately with
`committed: true`; the accepted frame and its resource store remain installed.

`replace_manifest` retains the previous frame but invalidates resource reuse
when manifest metadata changes. A successful render with explicit bytes must
revalidate and install resources for the replacement manifest. Replacing the
manifest with an identical value preserves authorization. A failed replacement
does not change authorization. Session destruction releases its store when the
last internal render handle drops; new sessions never inherit authorization.

Development preview uses the candidate session's resource store and never
borrows the live session's authorization. Its first render normally supplies
explicit bytes. A successful preview can reuse its own accepted store for
subsequent preview renders without changing the live store or frame.

`session_render_resources` integration tests exercise the public bridge with
native QuickJS and V8 when enabled: first frame from preload, real Page.setData,
explicit seeding, invalid selections before hooks, failed candidates, session
isolation, manifest replacement and development preview isolation. Internal
tests also reject an unverified nonempty map and assert that selecting a store
retains `Arc` identity. These are runtime contract checks; they do not establish
official DevTools parity, GPU behavior, device behavior or performance budgets.
