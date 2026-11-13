<a id="公开源码发行边界"></a>
# Open source distribution boundaries

[简体中文](public-source-policy.md) · **English**


The external warehouse only accepts the approved main history, source code, documents and anonymized regression input.
Full history of original core, website and runtime-artifacts, PR citations, Releases, Actions
Logs and attachments are saved in `weapp-container-private-archive`,
`website-private-archive`, `runtime-artifacts-private-archive` are in private archives.
These files do not belong to the public collection and should not be mirror pushed back to the public repository in subsequent migrations.

The old history of snapshots organized before public is saved in `weapp-container-publication-private-archive`,
Also keep the archive private. The public core repository starts with a final approved source code snapshot.

Source code is distributed according to the actual license of each directory; third-party licenses are retained. The old proprietary runtime library will not be updated due to the current source code
Licensing changes to adopt Apache-2.0. New public binaries should be built from matching clean sources, with complete
License, build source, target platform and hash, released with new tag.

<a id="提交检查"></a>
## Submit for inspection

Publication security workflow for each source code repository uses SHA-256 fixed Gitleaks 8.30.1,
Scan the complete Git history, and also check the local user path, signature file, private evidence directory and LFS pointer.
Available locally `node scripts/scan-public-source.mjs --root . --scanner /absolute/gitleaks --mode source`
Check the core working tree; entrances to other repositories are at `tools/`. Check the candidate repository with `--mode history` after submission.
Submodules are scanned independently and are not replaced by the scan results of the parent warehouse.

Exceptions only accept verified fixtures bound by files, rules and content digests in `.public-source-policy.json`;
Not ignored by the entire directory. The report does not output matching original text, and the temporary original report is deleted after execution. any new or changed
Candidates need to be re-examined, and the true credentials cannot be concealed by updating the allowlist.

Verify the identity of the new warehouse, all remote references, submodules, Releases and Actions before making it public; only main
The approval of the working tree does not mean that the entire original warehouse can be made public. See [SECURITY.md](../SECURITY.en.md) for the private vulnerability reporting process.
