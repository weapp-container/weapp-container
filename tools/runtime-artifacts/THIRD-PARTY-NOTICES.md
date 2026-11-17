# Public contract materials

The packaging tools and tests were migrated from `weapp-container/runtime-artifacts`
commit `f50e26252b43c13ea68821154d5ebaaa40527b75` under Apache-2.0.
`manifest.schema.json` follows the current `weapp-container/sdk-contract` schema;
the header fixture is byte-identical to contract `0.1.0-preview.5.7`. These public declarations
and schema retain the Apache License 2.0 in `LICENSE-APACHE-2.0`. The reviewed
header SHA-256 is `2a4761c0650c72ccd8d0a791fb66ee48888e1ce182ba99f0c92673a2c44a8e9b`.
The fixture header contains declarations only; tests do not embed implementation
source or a production runtime binary.
Every generated runtime/SDK archive includes the same reviewed Apache bytes as
`SDK-CONTRACT-LICENSE` (SHA-256
`a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2`),
with their public contract origin in `SDK-CONTRACT-NOTICE.json` and provenance.

Current core source uses Apache-2.0 except separately identified components.
Historical binary distributions retain their original `RUNTIME-LICENSE` and
complete third-party notices; migration does not relicense or republish them.
Node.js and Python standard
libraries are used from the packaging host, without vendoring them here.
