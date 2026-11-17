# Native ESM conformance inputs

The checked-in `compiled*.cjs`, source maps and `unit*.json` are produced by
the pinned public Rolldown compiler through `buildManifest`, without edits.
`modern-view.test.mjs` recompiles both variants and compares every output byte,
metadata hash and retained source hash. Native QuickJS/V8 tests consume these
same CJS files, rather than handwritten equivalents.

`container.config.json` uses `raw/` and exports `page.wxml` aliases `tools` and
`shared`. The graph includes TS enum, a class/private field, iterator/generator,
an initialized safe ESM cycle and a shared mutable `export let`:

```js
tools.exercise()    // before=0;after=1;sum=6;unit=points;cycle=a:b:a
shared.counter      // 1
shared.bump()       // 2
tools.readImported() // 2
tools.exercise()    // before=2;after=3;sum=6;unit=points;cycle=a:b:a
shared.counter      // 3
```

`container-tdz.config.json` uses `raw-tdz/` and exports the `tools` alias.
`tdz-a.ts` and `tdz-b.ts` immediately read each other's uninitialized `const`.
Evaluating that unit throws `ReferenceError`; a native lazy loader must throw
when initializing the alias, rather than returning an undefined export.

These are compiler/native language contracts, not official WXS, DevTools,
device, GPU or performance evidence.
