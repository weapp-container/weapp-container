# WXS graph fixture

This raw WeChat-shaped package exercises grammar-aware dependency extraction
and real native View loading. It contains division, regular expressions whose
character classes resemble comments, regular-expression/string decoy requires,
and an escaped `require` identifier. Only `view/dep.wxs` is a real dependency.

`scripts/wxs-graph-smoke.mjs` packs these unchanged bytes and checks the actual
WXML-bound dataset in QuickJS and V8. Expected dataset: `8|true|true|dep`.

This is auxiliary pack/runtime conformance. It is not weapp-vite build output
or official DevTools evidence, and does not certify the WXS language dialect.
