<a id="consent-revocation-10下一批运行时与-sdk-wire-提案"></a>
# Consent revocation 1.0: Next Runtime and SDK wire proposal

[简体中文](consent-runtime-wire-proposal.md) · **English**


Status: **Design proposal, contract revision in progress, implementation not complete, not yet accepted, does not advertise capabilities**. Only supplements the runtime contract of the existing `docs/host-services/consent-revocation-design.md`, without altering the complete API matrix or any acceptance status. The following capability is proposed for the contract and shall not be considered a current availability declaration.

Source code baseline is the main repository `281070dc6c28f07228017d9e98e600633d617c23`. The shared working directory is still changing; verify references with final clean commits prior to implementation. This revision includes 5 contract amendments from the [independent review record](../archived-evidence.en.md); the record reviews the original proposal, not the approval record of this revision. No new runtime tests were executed, no browser operations performed, no commits or pushes made.

<a id="0-下一次最小完整实现批次先不改各-sdk-版本"></a>
## 0. Next smallest complete implementation batch (do not change any SDK versions yet)

Suggest limiting the next batch to **runtime schema + shared fence from existing Rust manager + async final claim and sequential synchronous identity gate from core/ two engines + actual QuickJS/V8 validation**, including necessary `container-sdk` Rust command routing/manager plumbing; do not update Android/iOS/Desktop/Flutter/RN release versions, locks, archives, or consumers simultaneously. Web/Worker final broker, platform-specific HTTP v2/UI/future, product installation, and actual SDK acceptance are to be addressed in subsequent batches and their acceptance status must not be elevated due to limited testing in this batch.

The complete boundary for this batch is: protected calls from runtime enqueuing, shared retraction, native completion, settling, microtask claim, single terminal state, and owner retirement form a fully executable end-to-end chain; strict wire behavior and old-runtime rejection behavior are frozen, manager operations are queryable and cleanup failures remain blocked. The protocol schema can be fully frozen first, but incomplete transport combinations reject strict configuration and cannot advertise enabled features in advance. Evidence and main push gatekeeping remain active until this proposal is finalized; no modifications to the product documents of the previous batch's source closure are permitted.

The current work branch has begun implementing the native foundation layer: `NativeConsentAuthority`, bounded
`NativeConsentDelivery`, and the final claim hook for QuickJS/V8. They have not yet received Session,
shared account manager, synchronized identity read, phone number component, or SDK command. The JSON commands,
requirements, and capability in this article remain proposals; limited testing with these primitives cannot infer that the public flow is available.
The old C/T acceptance ledger has been preserved byte-for-byte; new source code will be registered after true execution is archived in a new archive.

<a id="1-必须保持的边界"></a>
## 1. Must-maintained boundaries

- Retain C ABI `1`, host-services base `1.0`; add JSON requirement, context, commands, and internal continuation; do not modify existing C symbol signatures or structure layout.
- Reuse existing `HostAccountManager::for_domain(hostAppId, tenantId, account)`. The authorization coordinator belongs to this shared account domain and does not establish a second set of account epoch registration tables.
- Within the same host/tenant, profiles/phone for the same user, publisher, app, and environment share a fence; valid version/package upgrades preserve this persistent domain, and ownership transitions still verify the complete accepted package, epoch, session, and incarnation.
- The authorization of an active owner's expiration must be settled in one go as fail → complete → Promise rejection; for retired owners, continue with existing silent cancellation and resource cleanup, without running old JS.
- Ordinary snapshot updates are not authorization commands and cannot grant, advance generation, or lift holdbacks. The runtime's final check cannot solely trust the JSON fence forwarded by the SDK.
- The return value of revoke distinguishes "received" and "revoke completed". The native revoke future only succeeds when the shared access is closed, all associated owner boundaries/projections are installed, backend submission and actual resource termination are completed.

<a id="2-现有源码归属与为什么不能只修改-current"></a>
## 2. Existing Code Ownership and Why Modifying Only current() Is Inadequate

The following paths are relative to `/path/to/weapp-container`:

| Location | Current Facts | Required Changes to Fall |
| --- | --- | --- |
| `crates/container-runtime/src/host_services.rs:98` | `HostServicesConfig`, `HostApiCallContext` use `deny_unknown_fields`; current configuration only includes application/account/apis/syncValues | Add precise requirements, consent context; retain old runtime's rejection of unknown requirements |
| `crates/container-runtime/src/host_services.rs:1552` | configure is allowed to execute only before app.init, verifies that pack root has been accepted and installs provider | Requires authorization coordinator to be bound; strict mode starts as unknown/blocked and cannot be injected with old syncValues userInfo |
| `crates/container-runtime/src/host_services.rs:1608` | snapshot update can directly override replay config.syncValues | Use independent, observation/fence-enabled commands for protected identity projections; regular entries must not override them |
| `crates/container-runtime/src/host_services.rs:1743` | call context is constructed from the runtime's actual pending call, containing trusted application/account/session/callId | Captures the consent fence generated by the coordinator and stores it in pending, without using guest parameters |
| `crates/container-runtime/src/async_host.rs:435` | finish Remove pending first, then publish API_RESULT and call engine resolver/phone event | Separate "native completion" from "guest session termination delivery"; live revoke can also replace queued but unclaimed successful entries |
| `crates/container-runtime/src/async_host.rs:564` | rich completion verifies resources and materializes binary **before** owner turn | Check fence before materialization; sensitive results retain native status before terminal claim, bounded preservation with revocability |
| `crates/container-engine-quickjs/src/lib.rs:1515` / `crates/container-engine-v8/src/lib.rs:1444` | resolver removes JS pending then uses `Promise.resolve().then(...)` to defer execution of success/fail, complete, resolve/reject | Must override this microtask window; checking only before Rust finishes is insufficient |
| `crates/container-core/src/host-bridge.js:435` | wrapper decodes native before calling the original resolver | Enforces strict protection of the result returned by terminal claim, then decodes; does not prematurely expand expired binaries into JS |
| `crates/container-runtime/src/engine_turn.rs:163` | owner turn has nested execution budgets and fault boundaries, but no shared consent admission | The lifecycle of the admission permit covers the actual disclosure microtask until the current execution segment ends; fault/retirement releases the permit and does not continue the old JS |
| `crates/container-sdk/src/account.rs:15`、`:114`、`:218` | Share AccountState, host/tenant registry, accurate application scope revocation of existing | Add authorization status by durable scope/kind, associated owner, operation; retain existing account/app retirement |
| `crates/container-sdk/src/lib.rs:1134` | app logout successful first revokes application scope, then polls owner replacement | Do not attach kind revoke to this retirement path; kind revoke should retain owner and other permissions |
| `crates/container-sdk/src/lib.rs:2103`、`:2572` | native snapshot has trustworthy owner check, but no consent order from the same owner | Retain owner verification, add non-optional observation/fence; does not require old call to still be pending |
| `crates/container-sdk-ffi/src/lib.rs:19`、`:262` | ABI_VERSION=1; session_command now supports op/payload JSON | Reuse the channel, add command routing and pure query whitelists |
| `crates/container-host-web/src/lib.rs:472`、`:492`、`:563` | Web directly calls runtime without going through container-sdk; completion schema likewise denies_unknown_fields | Explicitly supports adding new schema/commands, cannot modify native SDK only |
| `examples/hosts/web-wasm/worker-runtime.mjs:22`、`:1431`、`:1451` | HOST_OPS whitelist, owner serial lane, native.complete/native.snapshots | Add host-only consent operations and quota controls separately; guest bridge cannot mint fence |
| `examples/hosts/web-wasm/browser-host-account-manager.mjs:52` | Stable controller already exists, replaceable owner, and synchronized account revocation | Add cross-origin consent coordinator, associate all direct/Worker owners, no longer use per-client generational as the overall boundary |

Here, the most easily overlooked state is **Rust is complete, but the JS callback is still in the microtask queue**. The new contract must cover `pending → settling → claimed → terminal`, not just `pending → removed`.

<a id="3-版本协商与严格配置"></a>
## 3. Version Negotiation and Strict Configuration

New capability:

```json
{
  "hostServices": {
    "protocolVersion": "1.0",
    "consentRevocation": "1.0",
    "consentRevocationScope": "associatedOwners",
    "consentDeliveryClaim": "1.0"
  }
}
```

Meaning: `associatedOwners` covers all actual owners of the same D across the entire host/tenant root registry, including different versions, candidate owners, legacy/old runtime, and direct/Worker; the set cannot be reduced based on whether hooks are implemented. Each owner must register prior to app.init; strict configuration must first verify all existing owners of the D: owners unable to participate in sync gate, final claim, or real ACK must be retired and physically evacuated before being rebuilt under new contracts; previous strict admission denials. The absence of complete owner registration/audit itself also prevents enabling strict configuration. Legacy fixtures may be retained in a clearly isolated legacy domain without gaining new guarantees.

This scope does not equal any other process/device's immediate retraction. The SDK should also expose the current runtime/transport actual enabled state; a combination of unbound, incremental sync gate, final claim, or full owner gate that is not completed cannot advertise availability. A regular asynchronous Worker broker does not satisfy this proposal's `consentDeliveryClaim:"1.0"`, see §9.

Strict configuration only adds:

```json
{
  "application": "<既有完整 TrustedApplication 对象>",
  "account": "<既有 HostAccount 对象>",
  "apis": [],
  "syncValues": {},
  "requirements": { "consentRevocation": "1.0" }
}
```

- The strings in the example are used only for omitting existing objects; they are not valid production configurations.
- The new `HostServicesRequirements` also has `deny_unknown_fields`; currently it only accepts the exact string `"1.0"`, and unknown versions or requirements fail.
- The requirement retains historical contracts by default. Enabling strict reference identity provider requires this requirement; fields cannot be retried or removed due to failure from an old runtime, and v1 backend rollback is not allowed.
- Old runtime rejects unknown fields in `requirements` with fail closed; do not remove fields during SDK pre-processing. The C ABI version does not imply that the extension is passed.
- During configure, check supported low-level hooks, synchronously sync identity gates, coordinator binding, and full owner gate with D; if any are missing, report `ERR_PROTOCOL_VERSION`, and it is not allowed to first allow app.init before adding a fence. Legacy owners that are registered but unable to participate are rejected before retirement.
- `syncValues` does not carry generation/revision/challenge. In strict mode, identity profile/phone authorization and userInfo projection can only be established through the following protected entry points; misconfigured settings are explicitly denied, and silent truncation of userInfo followed by treating it as a successful configuration is not allowed.

<a id="4-域数字与-runtime-内部-authority"></a>
## 4. Domains, Numbers, and runtime Internal Authority

```text
D = (hostAppId, tenantId, publisherId, principalId, appId, environment)
C = (D, kind)                       kind = profile | phone
E = (accepted TrustedApplication, account.epoch, sessionId, ownerRevision)
```

- A consent C cannot be established with an authorized C when the principal is null; a "not logged in" error is returned upon disclosure.
- `scopeId = lowercaseHex(SHA256(UTF8(JSON.stringify(["consent-scope-v1",hostAppId,tenantId,publisherId,principalId,appId,environment]))))`, which serves only as an association identifier and is not a permission token. D is derived from the manager's trusted configuration and the current account; no command can use a passed-in scopeId to select a different domain.
- `generation` is the locally monotonic generation revocation epoch maintained by the coordinator per C; `revision` is the persistent version per C in the v2 backend; the two are not interchangeable. The scope state cannot be reset after deletion while the associated owner is alive; a new coordinator binding/owner registration is required to reestablish the state.
- All generation, revision, ownerRevision, and counters use `"0"` or decimal u64 strings without leading zeros; JSON numbers, doubles, and wraparound are prohibited. After generation exhaustion, the binding is permanently blocked, requiring a new coordinator/owner, and pending cleanup is retained.
- `authorizationVersion` remains an opaque guest state identifier and is never sorted, used as a CAS, or as a generation.
- Runtime defines a lightweight `ConsentAuthority` trait/handle (runtime cannot depend on SDK); the SDK manager provides the implementation. The handle provides restricted operations such as register-owner, capture, begin-revoke, claim-delivery, claim-identity-snapshot, release-turn, and owner-ack. The runtime holds the binding handle; JSON cannot substitute this association.
- The shared manager's Mutex protects only short state transitions and does not hold locks during JS, UI, HTTP, await, resource cancellation, or owner ACK periods. Cross-thread barriers are achieved via logical admission permits and owner lanes, without holding write locks that would block JS returns.

Each C state must contain at least: `generation, backendRevision?, granted, authorityStatus, activeRevocation?, latestRevocation?, cleanupPending, owners, admittedTurns`. `authorityStatus` is `uninitialized | current | fenced | reconciliationRequired`. Sensitive disclosures are not allowed when the backend revision is not initialized; synchronous interfaces immediately generate a secure snapshot as specified in §7.2, without waiting for network/UI.

Local undo and reauthorization adopt the following unique transition, without allowing derivation of additional transitions by generation/revision equality:

| Original State | Acceptance Criteria | New State and Admission Criteria |
| --- | --- | --- |
| `uninitialized` | First trustworthy initialization as specified in §6.1, during which no local revocation | `current`; only valid grants may be disclosed |
| Any state | new begin revoke | generation incremented, `fenced`, false, disclosure closure and new grant decision admission |
| `fenced` | The latest revocation backend commit, all owner-boundary/safety-projection ACKs, admitted permits, and actual resource draining have completed | Atomically record the latest operation/attempt as complete, clear activeRevocation, and enter `current(false)`; generation never rolls back |
| `fenced` | backend, owner, or cleanup failure; or some item still pending | keep `fenced(false)`, checkable and retriable; do not prepare/commit grant |
| `current` | no outstanding revoke, no cleanup debt; if revoked, the latest revoke has been fully completed; the current user's new attempt is recorded after this boundary | upon commit, revalidate the same condition and E/generation/revision, before entering `current(true)` |

Updated revoke can take over control from the old operation, but the cleanup debt of the old operation's permit/resource/owner must be accounted for in the latest completed barrier and cannot be discarded via superseded. The completion or late receipt of the old operation cannot cause the latest fenced state to enter current. `reconciliationRequired`, policy expiration, and liveness cannot serve as entry points to bypass grants; confirmed denials/policy revocations still follow the same fence/ACK barrier. External grants pushed do not belong to the strict 1.0 grant pathway.

The barrier must also account for all backend decisions made prior to C, including management operations without a live owner.
Network failure only ends one attempt and does not prove that a deny transaction was not executed. New revokes cannot be completed or allowed when the old HTTP may still execute; a trusted provider must recheck or re-submit the old decisionId with an idempotent transaction receipt for the decision. The execution order of different denials may differ from the local begin order; denials do not use a CAS with expectedRevision+1 of the grant; only trusted receipts with revisions higher than the known revision at the start of the decision are accepted, and shared authority retains the highest verified revision. The receipt revision of an operation is recorded separately from the current authority revision; out-of-order receipts cannot rollback authority. Retrying a previously failed decision only clears the debt and does not restore control over the latest operation; the original error from the first attempt of the same failed attempt remains unchanged.

<a id="5-call-contextprotected-api-与-completion-wire"></a>
## 5. Call context, protected API, and completion wire

Append an optional `consent` to existing `HostApiCallContext`; present only when extensions are enabled and the call is protected:

```json
{
  "consent": {
    "protocolVersion": "1.0",
    "scopeId": "<64 lowercase hex>",
    "kind": "profile",
    "generation": "7",
    "revision": "12",
    "ownerRevision": "41"
  }
}
```

This object is created by the runtime and preserved in Rust pending. The SDK must fully transparently pass through the data without reassembling it from the current snapshot. The platform must fail when encountering an unrecognized strict context, rather than ignoring it and continuing with the old implementation.

The first batch of protection lists are explicit internal policies, not reported by guest:

- profile：`wx.getUserProfile`, and the profile portion of registered `wx.getUserInfo`; applicable identity state/userInfo projections and notifications.
- phone: authorization within runtime via `weappContainer.identity.authorizePhone` / `button open-type="getPhoneNumber"`, and the success event of `bindgetphonenumber`.
- `wx.authorize({scope:"scope.userInfo"})` remains an actual entry point, and must still enter the profile grant decision contract; other scopes should not be misassigned to profile.
- Login code, app login authorization, payment, and another kind are not canceled due to kind revocation. No public `wx.getPhoneNumber`.

Extend the existing `completeHostCall` and Web Completion JSON; legacy calls retain existing result/error. Strictly protected success must carry metadata:

```json
{
  "callId": "<原 callId>",
  "result": { "userInfo": "<白名单公开资料>" },
  "consent": {
    "protocolVersion": "1.0",
    "kind": "profile",
    "generation": "7",
    "revision": "12"
  }
}
```

metadata does not enter guest result. runtime verifies the original pending E/C/generation, shared authority current revision/grant; missing, across kind, old revision, or extra fields are protocol errors/withdrawal failures and are never treated as ordinary success. Error completion does not fabricate grant metadata; it still checks owner/terminal status and retains the original provider `errCode/errMsg/details`.

Your grant will increment the revision, and you cannot simply require "always equal to entry revision". Use the registered decision attempt in the next section: only this call can update its acceptedRevision from expectedRevision to the new revision accepted by the coordinator; generation must remain completely unchanged. Automatic synchronization to shared state based solely on HTTP 2xx or a new revision in the result is not permitted. Previous calls with old revisions become invalid; new calls must reacquire as needed.

<a id="6-最小新增-host-only-命令合同"></a>
## 6. Minimum new host-only command contract

All objects strictly reject unknown fields. The following naming is suggested frozen name, not yet an existing entry; transmitted via existing session_command JSON and equivalent Web exports/Worker `native.consent.*`.

The specification fields for shared objects are as follows (`?` indicates optional fields; all others are required, additional fields are rejected):

```text
ConsentState = { revision: CanonicalU64, granted: boolean, expiresIn: u32-seconds }
ConsentStates = { profile: ConsentState, phone: ConsentState }
IdentityProjection = {
  hostLoggedIn: boolean, appLoggedIn: boolean,
  profileAuthorized: boolean, phoneAuthorized: boolean,
  authorizationVersion?: nonempty-string(max 512 UTF8 bytes),
  userInfo?: public-profile-object(max 256 KiB JSON)
}
```

`expiresIn` uses a precise u32 integer number of seconds; 0 when denied; granted if remaining is 0, disclosure is not allowed. The runtime anchors the duration to the local monotonic clock at the time of observation/decision-attempt capture, not at the time of receiving a late response; replay of the same revision may only shorten the existing duration, not extend it. The complete v2 backend object is first mapped by host whitelisting, `consentExpiresIn` is separately mapped to the two kinds of states; no other fields are copied. The specific publicly disclosed fields in userInfo follow the existing profile whitelisting, and phone numbers, tokens, or any backend extensions are not allowed.

<a id="61-初始化与-observation"></a>
### 6.1 Initialization and observation

`captureConsentObservation { "kinds":["profile","phone"] }` Return:

```json
{
  "observationId": "<runtime minted opaque id>",
  "owner": { "application":"<完整可信对象>", "account":"<完整账号>", "sessionId":"<实际 session>", "ownerRevision":"41" },
  "fences": {
    "profile": {"generation":"7","revision":"12"},
    "phone": {"generation":"3","revision":"8"}
  }
}
```

runtime preserves the true owner/fences/deadline of observation; up to 64 observations per owner, acquired and released upon use/expiry. Initialization allows revision=null; this does not imply permission to disclose. native refresh captures before HTTP, and cannot capture the current fence after the response arrives.

`initializeConsentAuthority {observationId, identityProtocol:"2.0", states:ConsentStates, identityState}`: A baseline authority can be established only when C is uninitialized, and no local revoke or owner/epoch change occurs after observation. v2 capabilities/HTTP validation is performed by a trusted host provider; runtime validation of schema, scope, generation, and security projection. The bearer, challenge, decision body, or original backend object is not sent to Worker/guest. Existing configurations in known domains or new owners cannot be reinitialized, reset, or unfenced.

`applyConsentObservation {observationId, identityProtocol:"2.0", states:{...}, identityState}`: Only projections consistent with the coordinator's current generation/revision/grant may be published, and authority advancement is not permitted. Previous observations are rejected and sensitive temporary results are cleared. Returns `ERR_CONSENT_RECONCILIATION_REQUIRED` when a higher revision/state conflict is observed, maintains a secure projection, and prevents this disclosure; an explicit authority sync is initiated by a trusted provider, and sorting by opaque authorizationVersion or infinite refresh is not allowed.

`reconcileConsentAuthority {observationId, identityProtocol:"2.0", states:{...}}` is an **explicit** authority synchronization command, cannot be confused with ordinary snapshot API: accepts exact monotonic revision; higher revision denials/policy failures propagate the kind generation and proceed with the same owner fence/ACK; conflicts on the same revision reject state. In strict 1.0, a revoked/blocked false→true only accepts the following locally registered grant decision; ordinary queries/rebuilds do not lift the block. To support push from authorization granted by other processes, a separate freeze of authentication event contract must be established; it is not permissible to elevate a refresh into an arbitrary grant authority.

`identityState` must conform to the above IdentityProjection. The runtime verifies the grant validity of the corresponding profile in profileAuthorized and the phone in phoneAuthorized; userInfo must be removed in unauthorized states. Expiry and replay are handled according to the common ConsentState rules.

<a id="62-本次-ui-grant-的登记与接纳"></a>
### 6.2 Registration and Acceptance of This UI Grant

`prepareConsentDecision {callId, decisionId, expectedRevision}`: the call must still belong to the current E/C/generation, the kind is retrieved from pending, expectedRevision equals the shared current value. authority must be current, with no pending revoke or cleanup debt; if historical revokes exist, the latest operation must have been fully completed. explicit rejection during fenced/reconciliationRequired periods and upon failure to revoke must not be registered, and a new "authorization" cannot be created merely by new generation to override a revoke. Save the fenced attempt and return a runtime-minted `decisionAttemptId`, while binding to the latest revoke boundary completed at registration time. The decisionId must satisfy the backend v2 contract, and the challenge is retained only for a trusted host client. Popups, decisions, and before HTTP transmission must each validate the attempt; expired or revoked decisions require re-displaying and obtaining a new decision, and cannot automatically re-allow with a new revision.

`commitConsentDecision {decisionAttemptId, identityProtocol:"2.0", decisionId, granted:true, revision, expiresIn}`: Validate that the attempt is unused/expired, E is current, generation has not changed, backend expectedRevision → revision strictly increments by one, decisionId matches; and atomically verify that authority remains current, no pending revoke/cleanup, and the latest complete revocation boundary at registration remains unchanged. Any revocation start invalidates the old grant attempt; a new decision must be presented and registered only after the latest revocation completes fully, and grants cannot override ongoing or failed pending revokes. Only if conditions are met, atomically accept authority and the acceptedRevision of this call, then publish snapshot/return disclosure. If response is lost, query/resent using the original decisionId; no new decisions may be created. Late receipts, superseded, or erroneous results are not accepted. False decisions use revoke/deny contract and do not bypass the generation fence.

<a id="63-撤回与可查询终态"></a>
### 6.3 Undo and Queryable Final State

`beginConsentRevocation {kind, decisionId, context}`: context reuses the existing native SnapshotOwner's full application/account/session ownership verification; scope is derived from the binding. The corresponding typed API of the shared manager also allows native management operations without a live owner, but still requires a trusted installation scope and does not accept guest domain selection.

Before any HTTP/await, the coordinator atomically closes the newly disclosed admission of C, increments generation, sets granted=false, and records operation. At this point, all associated owners (including different versions, direct/Worker, and newly elected candidate owners) will read the new generation during the final claim and will not wait for individual owner commands to arrive before beginning blocking. The command immediately returns a received receipt, containing a runtime-minted `operationId` and the first opaque `attemptId`; backend denial can be executed concurrently with local fence ACK/resource cancellation.

Repeat the same decisionId, return the original operation for requests belonging to the same request; reject different kind/scope/request summary under the same ID. Truly new revoke raises generation; retrying the same operation does not re-raise generation, nor does it create a new backend decision.

`commitConsentRevocation {operationId, attemptId, identityProtocol:"2.0", decisionId, revision, granted:false}`: attemptId must be the exact opaque identifier crafted for the current active attempt of the operation in runtime, and must be bound to the registered scope, generation, and decisionId; missing, cross-operation, terminated, or outdated attempt commands explicitly reject and cannot modify the current attempt or projection. Backend receipt is accepted only under this condition; revision is monotonically increasing and conforms to transactional return; local generation retains its original fence or a higher value and does not roll back due to an old receipt. If an updated revoke is present, the trusted resources of a previous operation can only satisfy the cleanup obligations inherited by the latest operation and cannot override the latest projection.

Original backend failure uses `failConsentRevocation {operationId,attemptId,error}`, accepting only the currently active attempt and retaining the original error and closed fence. All host-only progress entry points that can alter attempt stages/final states must carry attemptId. Errors from late old attempts are always rejected; even if the old backend succeeds, it is not directly merged into the success of a new attempt. A trustworthy host must recheck or resubmit the same decisionId under the current attempt, verify the current backend state, and then recommit. ACKs for completion/cancellation of old real resources are still cleaned up according to internal resource/tombstone identities, but do not alter the immutable final state of the old attempt nor terminate the new attempt.

`queryConsentOperation {operationId}` returns a secure receipt without entering JS, without requiring app health or the current page; remains readable during account switching/failure recovery. Example:

```json
{
  "operationId":"<opaque>", "kind":"profile", "generation":"8",
  "attempt":"1", "attemptId":"<runtime minted opaque attempt>",
  "status":"pending", "phase":"draining",
  "backend":"committed", "revision":"13",
  "owners":[{"ownerRevision":"41","status":"acknowledged"}],
  "cleanup":{"pending":"1"}, "error":null
}
```

Status: `pending | complete | failed | superseded`; phase: `fencing | backend | draining | publishing | complete`. Do not expose userInfo, phone number, code, challenge, bearer. `retryConsentOperation {operationId}` creates an opaque attemptId and increments the attempt number for retryable failed operations at runtime, retries only incomplete phases, returns a new attempt receipt; at most one active attempt per operation. If a retry is issued while an active attempt is still executing, return the existing active receipt; for completed operations, return the existing terminal state without creating a new attempt. The terminal receipt of the original attempt cannot be overwritten; all subsequent commit/fail operations must use a new attemptId. Operations superseded by a revoke update cannot regain control via retry; incomplete debt cleanup is managed by the barrier of the latest operation. Failures remain fenced closed; the latest epoch/operation is never recovered by an older retry.

public native `revoke(kind)` future waits for **actual terminal receipt**, success must have status=complete, failure throws a structured error retaining the operationId. public `refresh()` must also succeed/fail/cancel, no stale returns that never settle. canceling native waiting only cancels the waiter and returns operationId; does not revoke already started revoke, does not rollback fence, does not imply backend has not committed. query remains valid, backend/cleanup continues. future must not block waiting its own drain within the owner's current JS handler, use receipt, host events, and asynchronous continuation.

At most 64 ongoing operations per domain; new operations are rejected if full, and pending operations are not dropped. Received receipts are retained for the last 64 entries, or explicitly persisted by the host; evicted IDs return explicit not-found, not pretending completion. Native tombstone resource counts are also subject to the same bounded budget constraint of MAX_PENDING.

<a id="7-最终交付-claim微任务与原子性"></a>
## 7. Final Delivery Claim, Microtasks, and Atomicity

The fundamental fix is the runtime `ConsentDelivery`, not putting generation conditions into the adapter `current()`:

```text
pending(native I/O)
  -> settling(native result held; JS continuation queued)
  -> claimed(one authoritative disclosure or one failure)
  -> terminal(guest settled; real native drain separately tracked)
```

1. strict protected completion first checks the real pending owner/fence, then validates payload. Sensitive binaries denied are not materialized; handles and buffer ownership are released. The result is saved in a bounded settling record of the runtime; it still occupies the call/result budget.
2. `finish_host_call` does not prematurely publish an API_RESULT containing success data, nor does it pass the result to JS. It records an opaque delivery ticket minted by the runtime and queues a continuation without sensitive payload for the resolver. PhoneButton follows this mechanism and cannot have a separate, unclaimed success component event.
3. Two engine resolvers add an optional fourth parameter, delivery ticket (legacy path unchanged); during actual Promise microtask execution, a synchronous native hook claims the ticket. **At this point**, the core atomically binds E, shared generation, accepted revision, grant, validity period, and terminal winner. Copying the JSON fence completely cannot make an invalid ticket valid.
4. If revoke closes admission first, claim obtains a revocation/permission failure without sensitive data; if claim acquires permit first, disclosure happens linearized at this atomic point before revoke. The permit is released in the finally/owner turn guard of the execution segment, and revoke future waits until it and owner ACK are drained. JS calls must not be made while holding a Mutex, and no synchronous waiting for write lock return from owner thread is performed.
5. Only results after claim are decoded and executed via decodeNative and success/fail → complete → resolve/reject. Guests can cache disclosed information, and revocation cannot erase it; it guarantees that queue items not claimed after revocation fence are no longer considered successful, and no old termination callbacks continue after revoke completion. Synchronous execution segments already granted permit are pre-disclosed and cannot claim revocation to interrupt already-started JS statements.
6. Active permit/claim must have structured RAII cleanup. JS throw errors, microtask timeouts, engine faults, or owner retirement do not leave behind blocking permanent permits; normal errors continue using existing callback exception handling order. V8/QuickJS must test the same state diagram and does not accept a one-side pre-finish check.
7. Live owner's revoke sweep includes pending and settling; corresponding successful results are replaced with a single revocation failure, a termination microtask is scheduled, and old successful data/binary is discarded. Cancellation, timeout, user original rejection, and revocation use a single terminal winner: completed ones are not re-opened; those already failed due to deadline/cancel are not converted to success; existing original provider rejections are not overridden by subsequent refresh failures.
8. Removing old results does not equal releasing real HTTP/UI/device resources. Resources enter native-draining tombstone until real completion/cancellation ACK; new slot calls and native resource budgets are separately counted, and cannot treat un-terminated resources as released due to guest rejection. Repeat/late completion only performs tombstone cleanup and does not generate a second JS final state.
9. Tickets of an owner who has retired (replaced/app exit/close/fault) become invalid across the entire lifecycle boundary and are canceled and drained via `revoke_host_services()`, **not** re-entering old guest to satisfy kind's live rules. Live-to-retired transition during settling is treated as retired.

The native foundation layer acquires a terminal reservation shared by owner/kind upon entering settling,
thus preventing premature rollback completion for successful, rejected, and timeout callbacks that have not yet been executed. This reservation does not grant data reading; each success is individually validated at the real microtask entry point with its own stamp. The checkpoint end only releases a reservation if there are neither unconsumed tickets nor callbacks currently being executed at the checkpoint; the count of callbacks currently being executed must not be decremented when tickets are dropped from the queue or when an owner is retired. Pending I/O, actual resource exhaustion, and projection ACKs require separate session access and cannot be substituted by the settling reservation.

The session's resolver call and the subsequent checkpoint currently share a Result. If the resolver has accepted the ticket, but another microtask in the same checkpoint throws an error, the final error cannot prove that the ticket was not enqueued. Only a definite return of false allows direct discarding; when the acceptance status is unclear, the reservation must be retained, or the owner must be properly retired before cleanup. Integrating a checkpoint finalizer cannot introduce an additional pump to read host-event/environment entry points that originally had no checkpoint.

Linearization points must be written into the implementation test: not HTTP end, SDK enqueue, or Rust pending deletion, but the final guest delivery of the claim. A simple "compare once more before the resolver call" still fails to cover the microtask of the two current engines.

<a id="71-已核对的-turncheckpoint-可复用性与死锁约束"></a>
### 7.1 Reusability and Deadlock Constraints of Verified turn/checkpoint

This source search found no function literally named `run_on_owner_thread`. The actual boundaries are `call_engine_with_error_code` (`crates/container-runtime/src/lib.rs:7209`) and `with_engine_host_turn_deadline` (`engine_turn.rs:163`). Both engines run drain_microtasks after JsEngine::call; ordinary throws also checkpoint, while a faulted QuickJS skips it. The QuickJS checkpoint at `container-engine-quickjs/src/lib.rs:3757` explicitly requires execute_pending_job outside Context::with because the latter holds the runtime lock. V8 `:3383` performs its explicit checkpoint under the isolate lock.

Conclusion: **Reusability of an existing outer owner turn/call checkpoint as a permit's drain/RAII lifetime boundary is feasible; it is not possible to authorize all subsequent micro-tasks within a turn solely by acquiring a permit at the entry of the turn.** Micro-tasks occurring earlier within the same checkpoint may initiate revocation, and previous successes must still be read from the latest generation upon each claim. A turn only retains the in-flight counter disclosed through claims and does not grant subsequent claims the right to cross a fence.

Specific security implementation:

1. native claim hook captures only independent `Arc<ConsentAuthority/DeliveryLedger>`, performs short lock validation/withdrawal of ticket data, increments in-flight count, and immediately unlocks. It must not capture `&mut Session`, nor make recursive FFI calls to session.command. The independent hook follows the non-reentrant boundary of existing SyncHostApi (`container-core/src/lib.rs:417`), but is a runtime-private termination protocol and is not included in the list of wx-synchronous APIs registrable by the host.
2. `call_engine_with_error_code`/outer turn releases the permits obtained in the current execution segment after the call + checkpoint returns (including errors); panic or guard abandonment is released purely via Rust Drop. Drop only updates the count and wakes the owner mailbox, without running JS, UI, or waiting for backend. Permits do not cross async await, and the manager MutexGuard is not passed through engine calls or checkpoint.
3. When a callback internally invokes a trusted native hook to initiate revoke, the manager can immediately short-lock, increment generation, and return **received/pending receipt**. It cannot synchronously wait for the current turn's permit or its own owner's ACK; the owner ACKs after checkpoint or turn exit, then asynchronously completes the native future. Subsequent old delivery claims in the same checkpoint immediately fail; a currently active callback that has successfully claimed can complete its prior terminal state.
4. The existing FFI `SdkSession::enter` (`crates/container-sdk-ffi/src/lib.rs:56`) already uses a busy bit to reject `ERR_REENTRANT`; no reentrant mutex should be added for this purpose, nor should the same Session be re-borrowed by bypassing the busy flag. If the host adapter callback can only invoke session_command, it must be queued until the owner's next drain; available synchronous shared gates should be completed via an independent manager authority handle, and not through recursive entry into the VM.
5. Tests must include "success callback internally triggers revoke via a trusted native test hook; in the same checkpoint, another pending profile for delivery is successfully rejected; revoke waiter does not block and terminates after turn ends", along with throw/interrupt cleanup. This test must use two real engines to prove lock ordering and final claim, and cannot rely solely on a Rust coordinator unit test.

Therefore, it is not possible to treat the existing rquickjs Context lock/V8 isolate lock as a cross-owner authorization lock, nor to hold an account manager Mutex until the JS session ends. Shared authority is linearized only within a short critical section; the owner lane and independent counter permits are responsible for enforcing barriers.

<a id="72-strict-同步身份快照的逐次原生-gate"></a>
### 7.2 strict sequential native gate for strict synchronous snapshot identity

`weappContainer.identity.getState()` is a synchronous disclosure entry, and does not gain permission for subsequent reads even if a snapshot has already been loaded in the current turn. Currently, `container-core/src/host-bridge.js:86,357` calls `__container_sync_api`; QuickJS `src/lib.rs:224` and V8 `src/lib.rs:152` directly clone the per-turn cache from JS. In strict mode, the runtime-private synchronous `claim-identity-snapshot` hook must be used; synchronization of snapshots on regular devices and legacy contracts are unaffected by this private entry.

Each read is performed by a hook through an independent `Arc<ConsentAuthority/ProjectionLedger>`, within a short critical section, retrieving E/D from the real binding, atomically checking the current owner/epoch, generation/revision of two kinds, authorityStatus, grant, and monotonic expiry, and verifying against the native-stored whitelist projection. A safe projection immediately returns false for revoked/expired/ uninitialized kinds; when a profile expires, the userInfo must be removed, while another kind and trusted app login are retained with current values. If the owner has retired, lifecycle error handling is applied and the old account projection is not returned.

Only when the gate accepts public data is it converted into a JS object upon unlocking; a kind disclosed as true simultaneously acquires an execution segment permit and releases it via the call + checkpoint guard as specified in §7.1. If revoke closes the gate first, the current session can only return a safe projection; if read acquisition obtains a permit first, it belongs to disclosure prior to revocation, and revoke future awaits the actual owner's ACK for the execution segment. Within a callback, even if an old permit already exists, a subsequent getState must still pass through the gate and cannot reuse the old permit. Objects previously saved by the guest are not retroactively erased.

strict userInfo must remain in the managed native projection and cannot be pre-populated into ordinary `__container_sync_api_values` or any JS cache that can be directly cloned by the snapshot facade. turn entry refresh, snapshot update, and owner-lane ACKs only maintain the projection/completion barrier and cannot replace per-frame checks. hook does not capture `&mut Session`, does not recursively enter session.command, does not wait for HTTP/UI/owner threads, and does not cross JS lock. If any engine, SDK, or transport is not connected to this synchronization hook, strict configure rejects at app.init with `ERR_PROTOCOL_VERSION`; it cannot fall back to ordinary cache, nor can it advertise consentRevocation/consentDeliveryClaim 1.0.

<a id="8-owner-ack-与-snapshotevent-清理"></a>
## 8. owner ACK and snapshot/event cleanup

host/tenant root registry must register all actual owners of D, and registration cannot be filtered based on whether new hooks are supported. Legacy/old runtime owners who cannot participate in strict admission must first be officially retired and drained; prior to this, strict admission for the entire D must be denied, and no owner shall be deleted or omitted from the ACK set. Candidate owners and regular asynchronous Workers also follow this rule.

The coordinator registers owner records with at least `ownerRevision, E, installedGeneration[kind], activePermits, cleanupPending`. Each owner has its fence installed by the thread to which it belongs; during the waiting period of the sequential sync gate in §7.2, a safe projection is returned via shared authority:

- Prevents successful new requests of this kind, old UI decisions, old grant attempts, old observations, and old delivery tickets.
- Synchronously replaces the owner's security identity snapshot and replay state, removing userInfo for revoked profiles; the other kind and app login remain unchanged.
- Clears successfully queued but unclaimed old identity events, and rebuilds at most one change notification based on current state; ordinary event entry must carry a protected native context and use the same claim, and must not broadcast the entire backend object to the guest.
- Generates a failure for a live pending settlement call; waits for the arrival execution segment, actual native resource termination, and confirms installedGeneration to the manager. ACK is an internal trusted owner lane product; host cannot arbitrarily mark ownerRevision as confirmed.
- Upon owner retirement, confirms retirement via existing close/drain barriers; retirement cannot be considered confirmed merely by removing it from a set. A new owner, upon registration, includes the latest fence, is blocked prior to initialization; owners created during operation must not fall outside the target snapshot.

Only after the latest generation of secure projection is installed, all D-related owners confirm, the backend submission is completed, and the inherited old cleanup debts are actually resolved, will the latest operation/attempt atomically enter complete and allow authority to transition to current(false). Errors can be queried and retried, but authorization is not restored. Queries from closed/engine fault route to Rust manager state and do not list mutating commands together as passive. `queryConsentOperation` should include the account replacement allowance list in the SDK and an exact whitelist for FFI passive command failures.

<a id="9-重建与sdkworker重放"></a>
## 9. Reconstruction and SDK/Worker Replay

- The public controller remains stable; each new owner obtains a fresh ownerRevision and current per-kind state from the manager, binds authority first, then validates requirements, installs a security snapshot, and finally performs app.init/input. It is not permissible to copy grant/userInfo from old config.syncValues to bypass initialization.
- `services_for_pack`, preload candidates, hot-update failure recovery, and account switching reconstruction all replay requirements and adapter registration; accepted version/root changes do not modify D, but observations/attempts/tickets from old E must not be inherited.
- On app exit, existing application retirement is reused, and persistent consent is retained; for a new epoch by the same user, current durable grant can be restored, but only after validating the new host bearer and backend revision; requests/challenges/codes from old epochs remain invalid. After account deletion, the backend clears D and destroys the corresponding local coordination state; legacy authorizations without trusted mappings are not migrated.
- Android/iOS/Desktop/Harmony, Flutter/RN bridges must pass through consent context/completion metadata and requirements verbatim; they cannot update only the lowest-level Rust lock. After each native handler's await/UI, further checks are performed, and the final runtime claim serves as the last line of defense, not replacing host-side blocking of old grant HTTP.
- Web direct and Worker share the host-realm coordinator in BrowserHostAccountManager. Requests for host bearer/challenge/initial decision must not enter the Worker. The Worker receives only non-secret fences/receipts/tickets and whitelisted projections.
- Suggested incremental names for Worker lane: `native.consent.capture`, `.initialize`, `.observe`, `.reconcile`, `.prepareDecision`, `.commitDecision`, `.beginRevoke`, `.commitRevoke`, `.failRevoke`, `.query`, `.retry`. Revoke/fence/ACK use separate control quotas and are not starved by ordinary completion accumulation; they still only touch JS in the owner lane.
- **Ordinary asynchronous Worker broker does not support `consentDeliveryClaim:"1.0"`.** Each Worker's independent WASM memory cannot read the native shared authority of the main realm; synchronous hooks in Promise microtasks cannot wait for postMessage and continue processing revocation messages for the same Worker. Proactively requesting and caching a permit from the broker advances the linearization point and cannot equivalently replace the final synchronous claim in §7 or the sequential synchronous identity gate in §7.2. Only recording issued permit as active and waiting for ACK can delay revoke future, but the synchronous hook cannot know that the permit has been revoked by the main realm.
- Therefore, Worker transport that has not obtained a validated equivalent final atomic check and synchronous gate must reject strict requirements prior to app.init and cannot advertise consentRevocation/consentDeliveryClaim 1.0, nor can it skip due to the presence of a coordinator or control queue in the main realm. Such Workers that are already running under the same D must be blocked from strict admission according to §3/§8 until their actual retirement is fully cleared; they cannot be excluded from the owner set.
- Future Worker support requires prior freezing of executable protocols and capability negotiation: the shared atomic authority path should define cross-memory read/commit linearization, owner ownership, permit/expiry and release; the asynchronous delivery path must explicitly define a state diagram for request, grant/commit, revoke, ACK loss, queue overflow, terminate/rebuild, and resolve the same boundary for synchronous identity snapshot. The protocol must specify how to satisfy §7/§7.2, or express differences through a clear new contract; it cannot claim 1.0. The ordinary broker remains unsupported before freezing, implementation, and actual verification; postMessage, a single main realm check, or a local generation map is not an atomic shared check.

<a id="10-最小保持系统边界的实现顺序"></a>
## 10. Minimum, ordered implementation sequence preserving system boundaries

1. **Type/Protocol/Reject Priority**: runtime creates a new consent module and strict schema; capability, requirements, context/completion, and owner-only commands; test for old runtime rejection, new runtime binding-free rejection, and old backend rejection first. At this stage, do not advertise availability.
2. **Shared Manager Authority**: Add C/kind state in existing AccountState, register owner and bounded operations; runtime trait implementation, monotonic numbers/overflow, account/app retirement interoperability. First prove isolation and legitimate pack upgrades across different publishers/users/apps/environments with shared authority.
3. **Fundamental Fix for Terminal Claim**: pending/settling/tombstone, binary materialization ordering, QuickJS/V8 real microtask claim, sequential sync of identity native gate, PhoneButton events, raw errors/one-time settlement; native simulation of multiple owner threads for precise gate. Must test the window of "Rust completes pending microtask, revoke then occurs" and "long turn with sibling owner revokes and then resync read again".
4. **Authority and Projection Commands**: observation/decision/revoke operations, retry with attemptId commit/fail, native future/query/cancel wait, native snapshot/event-safe projection, full owner ACK and rebuild replay. Ordinary snapshot channel attempts to override authorization must fail; no grant is accepted before the latest revoke is fully completed.
5. Distinguish one complete vertical path per SDK: first Desktop with shared adapter/across three ends and existing reference HTTP v2, then Android/iOS/Harmony/Web direct/Worker, followed by Flutter/RN. Native UI and all await points connect to the same attempt/fence; do not create private generation per end as a shared implementation.
6. **Output and Real Evidence**: Strictly archive the list and include new modules and platform source code; build runtime/SDK from a clean, pristine commit, update locks, and archive a fresh installation. Layered separation of limited engine/HTTP regression and real system UI/SDK paths, with platform readiness pending acceptance.

Cannot first claim completion with a narrow patch on the adapter end, and then later add the final JS boundary: this will retain the existing settling microtask vulnerability and force each SDK to independently implement its own termination rules.

<a id="11-此批必须写出的可复现断言"></a>
## 11. Assertions That Must Be Written in This Batch Are Reproducible

- profile/phone real response generation after gate; two live owners with the same D, one is revoked first, the other queue is successfully replaced with a single fail/complete/rejection; no userInfo/code/old snapshot/old event.
- Rust completes by entering settling first, QuickJS/V8 microtasks not yet executed, then begin revoke; failure is determined by final claim. Reverse order: claim acquires permit first, revoke remains pending before permit/owner ACK, and after completion, no old callback is started.
- UI has been displayed and allowed but HTTP not yet sent; before HTTP transaction; receipt paused after grant submission; before and after snapshot refresh; after native enqueue, each gate is precise. Old attempt cannot be re-granted or accepted for new revision.
- Repeated completion, repeated revoke/notification, same decisionId with modified body, timeout and revoke contention, provider rejection followed by refresh failure; exactly one settlement and original error not lost.
- phone real button flow; live kind revoke does not retire page; app exit/account switch/close occurring during settling does not invoke old page.
- Native resource late arrival, cancellation without response, cleanup failure and retry, queue/settling/tombstone overflow, engine fault; budget bounded, query reachable, no false reporting of resource release.
- New epoch for same user, different user, two apps/issuers/environments, legal upgrade/preload/failure recovery; config and adapter replay, old snapshot/ticket cannot be written to new owner.
- Strict matrix requirements for new and old runtime/transport/SDK, failure if any capability is missing; ordinary snapshot, guest bridge, any metadata cannot mint or advance authority.
- Latest revoke in backend, if still pending/failed at any stage of owner ACK, permit, or cleanup, prepare/commit grant is rejected; only new presentation and registered decisions are accepted upon full completion. Old revoke receipt cannot lift new fence, superseded does not lose cleanup debt.
- After attempt 1 failure, retry creates attempt 2; late commit/fail of old attempt is explicitly rejected, new attempt receipt and original error are not contaminated. Real resource late ACK only clears tombstone, does not rewrite terminal receipt.
- In long turn/checkpoint of two real engines, after brothers owner begins revoke, subsequent sync getState yields only safe projection; strict configure fails without sync hook, JS ordinary snapshot cache lacks unclaimed userInfo.
- When same D has legacy/old runtime owner or candidate Worker, their registration/ACK cannot be omitted; strict admission fails, real retirement only after emptying can be enabled. Different explicit legacy domains maintain historical contracts.
- Ordinary asynchronous Worker broker explicitly does not support 1.0, strict configuration fails and does not advertise; subsequent frozen protocol only allows verification of old completion queue, control of queue saturation, rebuild/terminate/ACK loss. No support path may succeed revoke without final owner confirmation. Record resource closure and failure cleanup for this task.

All evidence remains bound to API/parameter kind, clean source code commit, installed artifact digest, OS/browser/SDK, actual command, results, and cleanup. This document does not pre-fill approval and does not substitute system UI or real platform acceptance.

<a id="12-明确保留的跨进程设备范围"></a>
## 12. Guaranteed Preservation Across Process/Device Scope

This extension is enabled only within the guaranteed boundary of the same host/tenant root registry; all actual owners of D must be associated and possess shared coordination, sequential sync gate, final claim, and ACK, or have been genuinely retired and evacuated. The capability of an owner cannot be used to filter out still-active owners to claim global revocation completion. Data cached by another process/device cannot be automatically reclaimed due to SQLite revision changes; cancelling the current HTTP request does not revoke previously submitted grants or previously generated data.

To provide rollback completion semantics across processes/devices, it is still necessary to independently freeze and implement: backend authentication of owner lease, a change log ordered by C and replayable, local cessation of disclosure upon lease expiration, generation/revision fencing ACK per owner, offline recovery first synchronizing then admitting, pending and lease timeout semantics for unACKed/disconnected owners, and authorization and resource reclamation upon account deletion. A server HTTP 200, a single polling, a WebSocket send success, or a local event being enqueued is not an owner fence ACK.

This proposal does not define these remote lease fields, does not advertise cross-device immediate revocation, nor treats missing notifications/credentials/device registration as platform inapplicability. Backend v2, associated owner runtime/SDK, and three-layer lease acceptance across devices are retained; the goal cannot be achieved until all applicable features and authentic evidence are present.
