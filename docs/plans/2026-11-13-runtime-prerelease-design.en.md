# GitHub prerelease automation design

[简体中文](2026-11-13-runtime-prerelease-design.md) · **English**

## Goal

Manually start native production on main. With prepare_release enabled, pin core and SDK sources and create a complete 14-archive Release draft. The owner clicks Publish manually.

## Implementation

Preflight checks candidate versions, reviewed SDK inventories and an unused tag, then saves the candidate receipt. The follow-up workflow accepts only successful production from the designated workflow on this repository's main branch, waiting for source, documentation and security checks at the same core commit. Android, iOS and three Desktop hosts use that production's runtime and license inputs with existing build and consumer checks. Linux combines nine runtimes and five SDK archives, verifying them with the existing packager and independent Contract offline installer.

The policy separately records runtimeVersion, publishedRuntimeVersion and contractVersion. Candidate compilation does not require public locks that have not yet been generated; all six published locks must still agree. Draft upload uses minimal write permission, per-version serialization and server digest verification, refusing existing drafts and tags. The publisher adds draft-only while preserving local verification and explicit direct publication.

Generated iOS SwiftPM packages reference their local XCFramework to avoid downloading the previous public version during validation. Source SwiftPM URLs remain public pins, while generated-package hashes bind the actual candidate bytes.

## Validation

Cover failed or foreign production, wrong source, pinned SDK commits, independent candidate and published versions, the complete 14-target set, incorrect hashes, failed consumers, duplicate releases and interrupted uploads. Run actionlint, runtime tooling, SDK contracts and bilingual documentation checks. The new-version end-to-end run remains a draft. After manual Publish, anonymously download all 17 assets, recheck 14 offline installs and export the manifest for follow-up lock updates in all six SDKs.
