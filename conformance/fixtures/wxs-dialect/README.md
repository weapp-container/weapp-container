# WXS property dialect probe

This raw WeChat mini-program fixture exercises versioned WXS/WXML property
lowering in Weapp Container. The unchanged input can be packed directly; this
fixture does not represent a `weapp-vite` build regression.

The external WXS module observes all eight standard constructor names, computed
property access, own constructor and `for-in` target overrides, and native Array
`map/filter/slice/concat/splice`. Inline WXS and WXML expressions independently
observe constructor reads. Actual results are read from `#probe`'s dataset by
the native QuickJS and V8 simulator engines.

Run `node scripts/wxs-dialect-smoke.mjs --simulator-bin <fresh-dual-engine-bin>`.
The report preserves source/executable hashes, compiler ABI and both actual
datasets. Source blobs remain unchanged and executable blobs are independent.

Passing this fixture proves only the listed auxiliary native observations. It
does not prove official DevTools equivalence, all WXS language semantics,
cross-host/GPU/device acceptance, browser behavior or performance gates. A
separate official oracle run is still required.
