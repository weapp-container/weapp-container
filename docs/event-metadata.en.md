<a id="dataset-与事件-mark"></a>
# Dataset and event mark

[简体中文](event-metadata.md) · **English**


WXML string `attrs` and binding result `boundValues` are two different data channels.
Event metadata reads the evaluated `boundValues` first, and only unbound properties use the original string.
The same projection is used for the native rendering tree and the component event tree, `data-*` goes into `dataset`,
`mark:*` / `mark-*` Enter `mark`. Keys follow the existing hyphen conversion rules.

Ordinary JSON’s number, boolean, string, array, object and null are retained value by value.
Literal attributes `data-count="7"`, `data-enabled="false"`, `data-value="null"`
and text that looks like JSON is still a string; its type is not guessed via JSON.parse.
Mixed text binding continues to use WXML evaluated string results.

SelectorQuery of `fields({dataset:true, mark:true})`, IntersectionObserver
dataset, `target.dataset` of coordinate events and `currentTarget.dataset` of each propagation stage
Both read the committed tree. Event mark merges by root to target, and closer nodes overwrite keys with the same name.
Touch with identifier captures the metadata snapshot of this route in touchstart; follow-up setData
and relayout will not redirect that touch to the new metadata. New touches read newly submitted values.

The Rust types for `RenderNode.dataset` and `RenderNode.mark` are
`BTreeMap<String, serde_json::Value>`. Rust callers that construct nodes directly need to use
JSON value; string entries of the old JSON frame are still read as strings, and omitted fields are still empty maps.
New frames can contain non-string entries, so legacy strict string consumers cannot read all of the new output.
This is a directional input compatibility, not a guarantee for consumers of mixed versions.
Deserialization errors for this explicit frame in the old runtime would return `ERR_RENDER`; plain JSON
Forwarders may ignore this type of metadata. CanvasKit only draws the frame and is not responsible for verifying the semantics of the dataset.

This time, manifest schema 1, WXML IR 1 and bridge 1.0 are used, without adding envelopes or operations.
Existing minor negotiation and API capabilities are not feature-by-function access to event fields; cannot be claimed accordingly
Old consumers support these values. The caller and consumer should be fixed to the same warehouse version.

The existing IR normalizes missing / undefined results into JSON null, which cannot be proven to be consistent with
Explicit null behaves the same as presence in the official runtime. No sentinels or guessing omission rules are introduced this time.
Object identity, reference sharing between duplicate bindings, case edge rules and all official type semantics still need to be fixed
Actual differential evidence for DevTools `2.02.2608080` / base library `3.17.3`.

The existing number of nodes and text budget do not limit the number of bytes and depth of nested metadata JSON; there is no increase this time
Separate metadata quotas and no claims that memory or performance thresholds for large objects have been passed.

Partial validation through real Page / Component handler function, selector and touch route observation value,
and run the same fixture in QuickJS, V8. These validations constrain data consistency within the container;
The event and selector support levels of API inventory remain at `partial`, and the host, GPU, and
Real device or official conformance status.

The development example can be started directly:

```sh
pnpm simulator:dev -- --project examples/apps/dataset-values-app --viewport 320x480
```

Dual engine regression using built simulator and fixed version compiler:

```sh
pnpm runtime:dataset-values:smoke -- \
  --simulator-bin /absolute/path/weapp-simulator \
  --compiler-root /absolute/path/pinned-compiler \
  --compiler-dist-hashes /absolute/path/compiler-dist-sha256.json \
  --out artifacts/dataset-values.json
```

The script checks that the compiler source files are consistent with the submodule gitlink and verifies the previously generated dist hash manifest.
It saves original compilation products, independent repack comparisons, HTTP/SSE, actual JS observations, and full RGBA;
The type is asserted only after the two engines complete collection and resource cleanup, and the failure report is also retained.
It reuses the existing batch bridge and development supervisor, does not add node-by-node cross-language calls, and does not modify the compilation sub-packaging or chunk.
