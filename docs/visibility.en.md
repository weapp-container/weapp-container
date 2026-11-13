<a id="wxss-可见性"></a>
# WXSS visibility

[简体中文](visibility.md) · **English**


The runtime resolves `visibility` after component and slot projection. The
accepted node carries the same resolved value in `RenderNode.visibility` and
`computed_style.visibility`; painting, hit testing and native component
presentation consume that value.

| Declaration | Result |
| --- | --- |
| `visible`, `initial` | Visible, including under a hidden ancestor |
| `hidden` | Hide this node's own background, border, text and image |
| Missing, `inherit`, `unset` | Inherit the composed parent's visibility |
| Invalid value | Discard before cascade comparison |
| `collapse`, `revert`, `revert-layer`, valid `var()`/`env()`/`attr()` substitution | Retain the winning declaration, then return `ERR_UNSUPPORTED_CAPABILITY` during scene preparation |

Hidden nodes keep their layout boxes, selector membership and geometry. A
visible descendant retains its ancestor's transform, clip, stacking and group
opacity. It can receive pointer input and bubble through a hidden ancestor;
the hidden node cannot be the direct hit target. A failed replacement retains
the previous accepted frame, render revision and pixels.

The parser retains combined substitutions such as `var(--empty) visible` and
balanced nested fallback tokens until computed-value processing. It does not
evaluate substitutions or decode CSS escapes in property-value identifiers.
Collapse layout and complete CSS visibility support remain outside this scope.

Legacy typed frames that omit `visibility` deserialize as visible. Visible
typed fields remain omitted during serialization; hidden values serialize
explicitly. Direct frame producers supply resolved values for every node,
including visible overrides below hidden parents. Adding the public Rust field
requires external `RenderNode` struct literals to include it. Runtime frame
JSON now includes resolved `computed_style.visibility` values.

CanvasKit validates the typed value and matching computed-style entry. Its
committed paint plan and legacy traversal both preserve hidden contexts while
omitting hidden own ink. Explicit null, unknown values, conflicting style maps,
hidden paint commands and missing visible paint commands are rejected.

Validation covers parser/cascade, SoftwareRenderer, CPU Skia, actual QuickJS
and V8 Page.setData, selector values, pixels, input and failed-frame retention.
The fixed CanvasKit 0.42.0 CPU suite also checks transformed, clipped visible
images inside hidden half-opacity contexts in both paint paths. Sealed native
frames from both engines have been consumed by the real CanvasKit CPU backend.
Official slot cases, native window presentation, WebGL/GPU and seven-host
conformance still require their own execution evidence.

```sh
cargo test -p container-runtime --test visibility \
  --features quickjs-native,v8-native,skia-backend --locked -- --test-threads=1
WEAPP_CONTAINER_TEST_CANVASKIT_DIR=<fixed-0.42.0-package> \
WEAPP_CONTAINER_TEST_CANVASKIT_FONT=<pinned-NotoSansSC.ttf> \
  node --test scripts/canvaskit-presenter.test.mjs
```

The CanvasKit tests verify the exact package, JavaScript, WASM and font hashes
before running the CPU checks.
