<a id="sdk-集成"></a>
# SDK integration

[简体中文](README.md) · **English**


The six SDK source repositories are pinned Git submodules: `contract`, `android`, `ios`, `desktop`, `flutter` and `react-native`. All remain private during the preview.2 migration.

See [repository boundaries and binary installation](../docs/sdk-repositories.en.md) and each submodule README for independent builds. Runtime and C ABI implementation remain in the proprietary core. Wrapper source is Apache-2.0; distributed runtime binaries have a separate proprietary license and third-party notices.

Core scripts in `scripts/sdk-*` orchestrate binary production and standalone wrapper packaging. `sdk/build` and `sdk/licenses` are private build inputs, not exported implementation.

The original integration documentation is retained byte-for-byte in [docs/history/sdk-pre-split](../docs/archived-evidence.en.md). Its historical validation claims do not validate new revisions.
