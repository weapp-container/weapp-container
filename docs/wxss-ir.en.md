<a id="wxss-ir-和条件级联"></a>
# WXSS IR and conditional cascade

[简体中文](wxss-ir.md) · **English**


Weapp Container stores WXSS in canonical UTF-8 JSON blobs. `wxssIr` references
their SHA-256 content address; the enclosing manifest schema remains version 1.
New packer and Rust parser output uses WXSS IR version 2. Rust decoding and
validation also accept legacy version 1.

<a id="版本-2-源代码结构"></a>
## Version 2 source structure

The shape remains `version`, `imports` and `rules`. Version 2 requires an empty
`imports` array. Each import is a rule at its original source position:

```json
{
  "version": 2,
  "imports": [],
  "rules": [{
    "selectors": [],
    "declarations": [],
    "nested": [],
    "atRule": "@import './theme.wxss' (min-width: 240px)"
  }]
}
```

Nested groups retain their own rule lists; their imports are never hoisted.
Imports cannot carry declarations or nested children. Keyword matching treats
`@imported` as a distinct unknown at-rule. Non-import semicolon at-rules are
preserved too. Declaration bodies such as `@font-face` retain descriptors,
while media, supports and keyframe bodies retain nested rules. Comments outside
quoted strings normalize to one separating space in both parsers.

The shared [parser fixture](../tools/container-manifest/test/fixtures/wxss-v2.json)
checks ordered/nested imports, import-only groups, descriptors, keyframes and
keyword boundaries against both implementations' canonical JSON.

<a id="运行时评估"></a>
## Runtime evaluation

The selected App/page/component style graph defines the ordered root list.
The runtime verifies blobs, resolves local quoted or `url(...)` imports, and
evaluates conditional groups before selector matching. Relative and package-root
paths are supported. Repeated imports expand at each site and keep their cascade
effect. False conditional branches do not traverse their children or load their
imports. A new render commit re-evaluates conditions for its logical viewport.
Expansion is bounded to 128 import/group levels, 16,384 stylesheet visits,
32 MiB of cumulative serialized IR and 65,536 rules/selectors/declarations/imports.
Every repeated import charges its source again, including inactive bodies;
exceeding a budget returns `ERR_RENDER` before frame publication.

Supported media queries use the screen environment with `all`/`screen`,
width, height, orientation and aspect-ratio features. The portable subset
includes min/max forms, numeric range comparisons, boolean combinations and
query lists. Width/height lengths accept `px`, `rpx`, `rem`, `vw`, `vh` and
unitless zero; `rem` uses a 16-pixel root. Orientation treats a square viewport
as portrait. Queries use three-valued MQ4 logic: unknown or invalid features
remain unknown through `not` and become nonmatching at the query boundary.
Another valid query-list member can still match. Invalid viewport dimensions
and resource-limit violations return `ERR_RENDER`.

Only leading top-level imports are executable. An active late or nested import
returns `ERR_UNSUPPORTED_CAPABILITY` because official placement semantics have
not been established. Active `@supports`, import layer/supports qualifiers and
other unsupported at-rules also fail explicitly. Font-face and keyframe
metadata survives resolution but is excluded from the ordinary cascade;
font loading and animation execution are not implemented by this path.
The context-free IR cascade skips all unresolved at-rule subtrees, preventing
false media branches or animation selectors from leaking into element styles.

Import cycles, missing resources, remote/escaping paths and malformed import
syntax return `ERR_RENDER` before frame publication. Failed rendering preserves
the prior committed frame. Local `.wxss` and `.css` style resource IDs are
accepted, matching the packer's style inputs. Unrelated style records do not
enter the selected cascade merely because they share a manifest.

<a id="传统和剩余的边界"></a>
## Legacy and remaining boundaries

Version 1 records imports in a separate list. Its decoder retains that version
and those bytes' meaning: imports expand before the owner's local rules. The
format lost original import sites and enclosing conditions, so neither parser
nor runtime can reconstruct them. Repack source with v2 to preserve that data;
old evidence and content hashes remain unchanged.

The source parser separates declaration-only and rule-list bodies. Mixed bodies
such as `@page` descriptors combined with nested margin at-rules are not supported.
Parsing and retaining an unknown construct is not a claim that its layout,
font, animation or other host behavior works. Local canonical/golden and runtime
tests establish this bounded contract; official DevTools, GPU/device parity
and performance acceptance require their own evidence.

<a id="重现原生示例"></a>
## Reproduce the native sample

The development simulator can load the actual App/Page sample:

```bash
cargo run -p container-simulator -- dev \
  --project examples/apps/style-conditions-app --surface web
```

For deterministic viewport transitions, build both native engines and run the
source-bound smoke with an isolated compiler checkout matching the submodule pin
and its independent dist hash receipt:

```bash
cargo build -p container-simulator --features v8-native --locked
pnpm runtime:wxss:smoke \
  --simulator-bin target/debug/weapp-simulator \
  --compiler-root /path/to/pinned/compiler \
  --compiler-dist-hashes /path/to/compiler-dist-sha256.json \
  --out /path/to/wxss-report.json
```

Use a fresh output path for each run; the smoke preserves prior evidence.

The fixture's real tap handlers update Page data and query geometry through
`wx.createSelectorQuery`. Narrow, wide, square and narrow-again frames must
preserve the lifecycle and counter while changing geometry and RGBA pixels.
The report checks both engine results and retains traces, snapshots, compiler
provenance and content-addressed pack bytes. It uses native software rendering;
it does not establish GPU or official WeChat acceptance.
Condition resolution stays inside the existing batched `render.commit` boundary
and adds no node-level JS/Rust calls. This lane records correctness, with no
performance profile or acceleration budget claim.
