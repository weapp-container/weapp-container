<a id="运行库发行入口迁移"></a>
# Runtime library release entrance migration

[简体中文](runtime-artifacts-migration.md) · **English**


On 2026-11-12, the distribution tool was moved from `weapp-container/runtime-artifacts` to `f50e26252b43c13ea68821154d5ebaaa40527b75` into the core warehouse. The downloader of the independent SDK supports accurate release of the core repository, and the old repository only retains nine existing historical versions. The root project no longer depends on the submodules of the old repository.

New builds use [Runtime Release Tool](../tools/runtime-artifacts/README.en.md). There are no new builds of native binaries this time, and no changes to published assets, old lock files, or `ORIGIN.json`. The source Apache-2.0 license, historical binary license, repository visibility, and read permissions are retained separately.

After the open source organization, the complete old warehouse was renamed `runtime-artifacts-private-archive` and remains a private archive.
The original GitHub warehouse ID, Release and asset identity are retained; the new `runtime-artifacts` with the same name only saves the approved ones
Stop updating tool source code. The new downloaders for the six SDKs target private archives for the frozen nine older versions, retaining the original lock hashes.
The old version of the downloader needs to be upgraded and does not rely on the redirection of the warehouse with the same name; the new runtime version is only released to the core warehouse.

<a id="历史-pin-审计"></a>
## Historical pin audit

Read 9 released runtime prereleases and 1 Dev Player draft through GitHub API before archiving, totaling 139 assets. Generate a snapshot based on the release ID, tag, draft status, and each asset's ID, name, size, and server summary. Its SHA-256 is `408be85b389237e338932294d48ef77c2bc8480477e8177b0fa6cbef389e8fe9`. Local evidence is stored in `artifacts/runtime-artifacts-migration/`, and the same fields are reviewed after archiving.

GitHub no longer returns drafts via the Release API after being archived in the repository. Temporarily unarchive to confirm that the original draft and APK still exist, and back up the draft metadata and original APK to the local `artifacts/runtime-artifacts-migration/draft-backup/` according to the original summary, and then restore the archive. 138 assets across nine released versions remain intact; a preview.5.3 Android archive of the old lock completes the real download, SHA-256 checksum and clean install after archiving. The draft was not changed to public release.

The comparison results between the default lock before migration and the GitHub assets at that time are as follows. The quantity includes all entries in the lock and does not mean that the corresponding SDK version or device verification has passed.

| SDK | Default lock version | Consistent with current remote assets | Existing issues |
| --- | --- | --- | --- |
| Contract | preview.5.3 | 10 / 10 | The current contract source code is preview.5.7, and the old lock cannot serve as the current generation runtime library |
| Android | preview.6.0 | 0/2 | The size and hash of two runtime assets with the same name no longer match the old pin |
| iOS | preview.6.0 | 3 / 3 | Only confirms that the identity of the lock is consistent with the asset, and does not add a physical device acceptance conclusion |
| Desktop | preview.6.0 | 0 / 12 | Four SDK archives are missing and the remaining runtime assets with the same name do not match the old pin |
| Flutter | preview.6.0 | 1 / 12 | Three SDK archives are missing, eight runtime pins do not match the assets with the same name |
| React Native | preview.5.3 | 10 / 10 | The required native version of the source code is preview.6.0, old locks will be rejected |

These differences occurred before this migration. The downloader continues to reject missing or changed bytes according to the original pin, and does not write the remote current hash back to the old lock to mask the difference. When these platforms are required, build from matching clean source, or explicitly select a manifest that has been independently verified and matches the target SDK. New publishers refuse to overwrite existing tag/release to avoid further replacement of releases under the same version name.
