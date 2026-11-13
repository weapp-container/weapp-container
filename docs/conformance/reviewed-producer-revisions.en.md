<a id="已审核的生产者修订版本"></a>
# Reviewed producer revisions

[简体中文](reviewed-producer-revisions.md) · **English**


A reviewed producer revision is an ordered tuple of eight exact source identities: compiler-use recorder, compiler-use preload, fixture-build recorder, fixture packer preload, macro producer, macro insertion manifest, macro observer, and macro validator. Snapshot fixtures additionally require their exact ordered module closure. Current sources bind the GitHub producer, WXML producer, shared snapshot transport, shared temporary-project producer, and issue1034 producer, with exact module paths. Fixed r5b/r5c receipts retain their actual three-module closure; modules absent from those executions are never fabricated. Each identity includes SHA-256 and byte length. A macro or snapshot profile describes semantics; it does not identify a source revision.

New production uses the current CJS v4 implementation. Fixed historical revisions are `sealed-esm-v2-r3-reviewed-v1` for the independently reviewed 1058 and 1185 receipts, `cjs-v4-r5b-reviewed-v1` for the frozen r5b source policy, `cjs-v4-r5c-reviewed-v1` for the completed r5c 1012 execution, and `cjs-v4-r5f-reviewed-v1` for the completed r5f 1034 execution. Multiple exact source tuples can share a profile. Each fixed revision has inert source copies and review provenance protected by a fixed metadata digest. The readers never import, evaluate, or execute historical JavaScript. Unknown, intermediate, mixed, reordered, missing, or changed source groups remain rejected.

The r5b policy binds exact case ID, pinned source hash, source path, and conditional snapshot profile. It is an execution/read scope, not passed-case evidence: only its referenced 1072 receipt had completed the actual full-reader review at freeze time. Failed or unrun GitHub/WXML cases are not promoted by registry inclusion. The original r5b 1012 receipt remains unusable as a complete positive oracle. The distinct r5c revision has exactly one source scope, 1012, with its actual full-reader and dual-engine review provenance. It grants no scope or completed execution to1034 or the six unexecuted cases. Portable synthetic tests cover both old snapshot profiles without representing new official execution.

The r5f revision admits only `ide-issue-1034-auto-routes-runtime`, its pinned
source hash and path, and `issue1034-static-snapshot-v1`. Its eight primary and
five snapshot source members match the actual receipt CAS and frozen source
copies. Its provenance includes the actual complete official reader and root
review. The template integration re-read all five unchanged official receipts
through the current complete reader and rejected matching-hash mutations of
snapshot order, closure size, source revision, case path and recorder summary.
This revision grants no scope to earlier failed attempts or other cases.

The fixed `cjs-v4-r6-v2-reviewed-v1` revision admits only the completed 1014 and
1013 original case/source/path identities. Its complete fifteen-member tuple
contains the primary eight, conditional snapshot five and ordered static helpers
two. All three static helper references (macro, consumer and fixture) match the
archived bytes. The blocked native template and unexecuted WXML/subpackage cases
receive no historical scope. Current and fixed interpretations collapse only
when the complete ordered fifteen-source bytes and profile are identical.
After the SFC helper change, unchanged r6 receipts select the fixed revision.
Root independently re-read those two and the five older actual receipts through
the combined current strict reader.

Current template receipts additionally bind both static helper modules and the
exact formatter package closure. Historical receipts retain their actual
shapes; absent fields are not synthesized to select a current producer.

The macro reader selects an insertion manifest using all four actual helper identities. The consumer reader checks the recorder pair against the same group and carries an opaque internal selection. The fixture reader then closes all eight identities and, where present, the exact ordered snapshot closure for that source revision, selecting exactly one complete source tuple. Its second opaque token is bound to the same case, source hash, path, and snapshot profile. Snapshot transaction and final-cleanup readers require that complete token to authorize historical producer bytes; a caller-supplied ID, profile, copied token, or earlier consumer token grants no authorization.

Identity selection runs before checkpoint/final semantic validation so those strict readers can select historical producer bytes. It is not fixture admission. All current event, build, case, source, process, helper-transform, snapshot, physical-directory, candidate-ledger, cleanup, packer, and resource checks still run. Historical ESM v2 events use the current strict legacy-v2 validator. The current-source path without a macro observation retains its original boundary; fixed revisions require their actual explicit macro observation. Public manifests stay unchanged. The internal fixture provenance schema adds the distinct issue1034 snapshot profile while retaining the old profile values.

Before changing any admitted producer component, including a change that keeps the same profile, preserve the previous complete source tuple and its conditional snapshot closure as a fixed reviewed revision. Independently verify its source freeze, original CAS identities, pinned case scope, and review provenance. Add the fixed metadata digest and inert copies, then run the full current oracle reader against unchanged historical receipts and meaningful strict-validator mutations. Keep portable synthetic admission/rejection tests in the default suite and archive raw receipt audits separately.

Adding cases or changing current producer code must preserve admitted official receipts. Profile-only branches, arbitrary path allowlists, receipt-supplied executable modules, dynamically trusted digests, old-reader fallbacks, and copied `passed` fields do not establish reviewed revisions. Changes requiring new semantics need a separately reviewed validator change; source identity alone never grants it.

The registry module and every fixed metadata, source, and provenance fixture belong to `REVIEWED_PRODUCER_INPUTS`, binding the full selection closure in official source freezes. Current sources use the normal source freeze; before a later edit they must first become a fixed previous revision.

The issue1034 and WXML producers share temporary-project transaction validation while retaining distinct exact source/helper identities, temporary path patterns, profiles and cleanup kinds. Source/config identity, generated output bytes, runtime snapshot bytes and physical directories remain independently bound. A root-dot runtime snapshot is not admitted as a source build root. The auto-routes cache is accepted only at its exact generated data path for the guarded1034 producer. Nested Vue macro extraction binds the nearest causal extraction before validating its source and effective snapshot; a matching distant source cannot replace a foreign nearest owner.
