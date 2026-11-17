# Isolated View render fixture

This fixture exercises the real portable packer and the isolated native View
render API. `raw/` is a complete emitted-style one-page mini program, with
separate AppService JavaScript and View-only external/inline WXS modules.
`render-case.json` supplies the document, plain data and expected text for one
fresh View scope. `golden-program.json` contains the complete canonical manifest,
every content-addressed UTF-8 blob and that render case.

The fixture covers relative WXS dependencies; page, imported template and nested
include declarations with their own `tools` alias; lossless inline raw text;
keyed loops; loop-local conditions; and lazy boolean/conditional expressions.
The WXS call counter must run only for visible rows, in their source order.
The WXML uses ordinary raw `&&` expressions. The current pack parser preserves
`&amp;` literally inside attributes; entity decoding is an unverified boundary
which still needs dedicated pack-parser coverage and an official runtime oracle.
This fixture does not resolve or certify that behavior.
`hostOnly()` checks that `wx`, `App`, `Page`, `getApp` and the AppService sentinel
remain absent from the View realm. AppService sources are packed for boundary
validation; the isolated View tests must not execute those modules.

Run the deterministic packer check from the repository root:

```sh
node --test tools/container-manifest/test/view-render-pack.test.mjs
```

The Node test rebuilds the pack and compares it with the committed golden. It
never rewrites the golden. Native tests independently verify the manifest root,
all blob hashes and WXML decoding before loading only `manifest.viewScripts`
and rendering the entire document with its lexical bindings.

This is auxiliary isolated View evidence. The expected text is a local contract,
not a result recorded from WeChat DevTools. It does not certify the WXS dialect,
production Session support, host surfaces, GPU rendering or device parity.
Packing must not advertise WXS as a supported capability; production integration
and near-parity publication remain subject to their existing evidence gates.
