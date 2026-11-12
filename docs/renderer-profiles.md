# Renderer profiles and layout-independent View documents

Renderer selection is separate from the JavaScript engine and from legacy WXS
versus modern View language profiles. The supported profile names are `skia`,
`webview`, and `skyline-compat`. `skyline-compat` identifies the container's
compatibility path; it does not claim that the official Skyline implementation
is included or that its conformance gates have passed.

The packer maps emitted app/page JSON `renderer: "webview"` to `webview` and
`renderer: "skyline"` to `skyline-compat`. Missing declarations retain the
container's existing `skia` default. Source JSON and all `wv` output bytes stay
unchanged. A source project may override selection in `container.config.json`:

```json
{
  "renderer": {
    "default": "skia",
    "pages": {
      "pages/home/index": "webview"
    }
  }
}
```

Keys are emitted route paths, with no `.wxml` or `.json` extension. Precedence
is configured page, source page, configured default, source app, then `skia`.
Unknown routes, profile names, source renderer values, and configuration fields
fail packing with `ERR_RENDERER_CONFIG`. Configuration files participate in dev
watch dependencies even when no modern View modules are configured.

Any explicit selection emits schema v3 with `rendering.version: "1.0"`, a
`default`, and a resolved `pages` map. Schema v3 can also contain `modernView`.
Unconfigured legacy packs retain their existing v1/v2 representation. The
integrity root covers renderer selection, and changing it requires a session
restart. Older runtimes reject v3; current hosts must negotiate the renderer
profile version and required profiles before initializing a page. The v3 schema
is in `schemas/container-manifest-v3.schema.json`.

`container-ir::ViewDocument` describes evaluated content before layout. It
preserves stable occurrence IDs, component/event/slot ownership, typed
attributes, event capture/catch policies, ordered WXSS roots and raw rule IR,
and content-addressed resource references. A `typedAttrs` entry is authoritative
over the legacy `attrs` string projection; neither is an instruction to evaluate
an expression again. Geometry fields are rejected by the document wire type.
One stylesheet source may be applied to multiple component instances by
repeating its source ID with distinct `scopeId` values; all scoped copies must
retain identical IR. `slotOwner` is optional: producers must preserve the
declaration owner when known and must not infer it from physical render ancestry.

The runtime projection consumes the already evaluated component graph. Resolved
component documents and listener declaration documents are retained separately
from lexical import/include provenance, including components whose transparent
host is removed. Component stylesheet imports inherit the originating instance
scope. Raw conditional imports are preserved; an undeclared inactive reference
is not fabricated into a loaded sheet. Declared blobs are verified. The document
does not certify browser CSS isolation or that all conditional imports were
executed. Source sheets currently repeat per instance scope under explicit
count/byte limits; a future renderer can intern source IR independently of scope
applications.

Skia and Skyline compatibility profiles use Rust as layout authority. WebView
uses the browser. A ViewDocument alone proves neither successful presentation
nor browser/GPU capability: those require a matching presenter receipt and
separate runtime conformance evidence. No backend may silently substitute
Skia when a required WebView profile is unavailable.
