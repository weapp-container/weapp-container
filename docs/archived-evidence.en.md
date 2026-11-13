<a id="历史证据与公开源码"></a>
# Historical Evidence and Public Source Code

[简体中文](archived-evidence.md) · **English**


Public source code begins with curated snapshots. Original development history, device logs, screenshots, observation records, build archives, duplicate source code, and internal task handoffs are retained in private archives and are not distributed alongside the public Git history.

The original repositories for core, website, and runtime-artifacts are separately isolated under the same organization as:
- `weapp-container-private-archive`, `website-private-archive`, and
- `runtime-artifacts-private-archive`,
maintained in private and read-only status. Public repositories with the same names use a new GitHub identity and accept only approved main branch history. Full policy details are available in [Public Source Code Distribution Boundaries](public-source-policy.en.md).

Pre-publication curated snapshot history is preserved in `weapp-container-publication-private-archive` and remains in private archival storage.

Original records are tied to the source code, tools, inputs, and output hashes at the time of generation. Document consolidation and re-creation do not constitute valid evidence for accepting prior submissions as verified. Conclusions lacking original evidence are considered part of historical records and cannot serve as official proof of current compatibility, device, GPU, performance, or release approval.

Public repositories retain protocols, capability matrices, test suites, and necessary minimal fixtures. Anonymized or synthetic evidence inputs are validated only against evidence processing contracts. The public ledger includes only distributable summary records; complete original records remain in private archives. Full evidence validation continues to report unmet conditions when input data is missing.

New test outputs are by default written to the ignored `artifacts/`. When new conclusions are published, source code commits, tool versions, input and output hashes, methods, results, and limitations are re-recorded, and the distributability and personal data compliance are verified.

The 172 official tool use cases in the open-source snapshot are uniformly marked as `unknown`: original evidence has not been made publicly available and must be re-collected before being eligible for review and validation. Pre-archival indexing count is recorded as `{"passed": 23, "unknown": 149}`; this count reflects only private history and does not constitute proof of current source code approval.
