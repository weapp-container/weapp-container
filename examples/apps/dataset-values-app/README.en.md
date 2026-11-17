<a id="数据集和标记固定装置"></a>
# Dataset and mark fixture

[简体中文](README.md) · **English**


```sh
pnpm simulator:dev -- --project examples/apps/dataset-values-app --viewport 320x480
```

Tap `(24, 40)` for ordinary Page events and `(24, 136)` for component-internal
native events. The controls at `(184, 136)` and `(24, 392)` save component-scoped
and page-scoped selector results, real handler events, Page data and lifecycle
history to `dataset-values:component` and `dataset-values:page` storage keys.

An identified touch starting at `(24, 264)` runs the actual Page handler,
changes nested object/array metadata and moves the green target 160 px right.
Releasing the same contact at the old coordinates checks captured target and
ancestor snapshots instead of retargeting to the red underlay. A standalone
coordinate tap has no contact identifier; a captured gesture begins with
`touchstart` and carries the same identifier through its release.

Pure bindings carry JSON values; literal number/boolean/null/JSON spellings,
empty strings and mixed interpolations stay strings. Parent and target mark
values deliberately conflict: event mark uses the nearest node, while selector
`fields({dataset:true, mark:true})` returns each node's own values.

The dual-engine runner is `pnpm runtime:dataset-values:smoke`; its required
compiler/binary arguments and limits are documented in
[`docs/event-metadata.md`](../../../docs/event-metadata.en.md). This is a local
container consistency fixture. The tourist AppID does not establish official
DevTools behavior, object identity, undefined/presence semantics, GPU, device
or performance acceptance.
