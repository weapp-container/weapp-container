<a id="资料手机号授权撤回与迟到结果隔离"></a>
# Data, Phone Number Authorization Revocation and Late Result Isolation

[简体中文](consent-revocation-design.md) · **English**


Status: **Backend v2 atomic authorization has been implemented; shared host fence, SDK integration, and real UI/product flow pathways pending implementation and acceptance**.
`tools/host-services-reference/src/consent-v2.mjs` and service/server have provided the v2 path, trusted persistent domain, monotonic TEXT revision, challenge/CAS, decision idempotency, and strict legacy gating.
Real HTTP/SQLite testing has set gates before submission and after response generation; this does not indicate that the SDK has implemented late result isolation, and this document does not elevate any complete API acceptance status.

Diagnosis baseline is the main repository `1c95746ef789303e08387c1d5ba671d6263a601b`, Desktop SDK `2bf1e3adc0ff5f59e974440201c3171833c34965`. Errors in error projection and refresh fixes after failure for other SDKs belong to separate batches; this document describes the authorization lifecycle boundaries that these fixes do not replace.

Need to implement two mutually coordinated boundaries: the backend, using transactions, prevents re-granting of previously revoked permissions via old acknowledgment requests; the host, using shared authorization generations, blocks newly generated data, phone number code, and snapshots from entering still-living old calls. Canceling HTTP requests or checking account epoch only resolves part of the issue.

<a id="现有根因和已有边界"></a>
## Existing Root Causes and Existing Boundaries

[Desktop adapter](../../sdk/desktop/src/host_services_adapter.cpp)'s `current(call)` validates account, installation, session, and cancellation states, with no generational authorization for missing profile or phone number. `disclosure()` invokes `refresh_call()` after a successful response; the latter refreshes a synchronized snapshot and unconditionally proceeds with the original call. Thus, the following can be constructed:

1. Authorized `/v1/host/profile` generates profile on the server; response is not delivered yet.
2. Host `HostServices::revoke(Profile)` completes, snapshot becomes `profileAuthorized:false`.
3. Old profile response arrives, account and session remain the same. On refresh, even if unauthorized, the saved `userInfo` is still returned to JS.

Phone number code, concurrent `HostServices::refresh()` also lacks corresponding checks. `revoke()` does not invalidate existing authorization popups; the "allow" callback from the old popup can still submit `granted:true`. Failure paths also have two related issues: `consent_required` does not necessarily refresh the old snapshot; after initial rejection, a refresh failure may occur, possibly replacing the user's rejection with a second error. Error refresh should be attempted, cannot override original rejection, and cannot bypass authorization checks.

The `setConsent()` of [Host Service](../../tools/host-services-reference/src/service.mjs) only compares the current `purpose` and `permissionVersion`, and generates a random `revision` on each write. The `authorizationVersion` is a hash of the status of the data and phone number, an opaque version that cannot be sorted and is not a write condition. Older `granted:true` requests that are processed by the backend after a subsequent `granted:false` will still succeed. A client's disconnection cannot prove that the backend did not perform the write.

The following mechanisms already exist and should continue to be used:

- [Account Manager](../../crates/container-sdk/src/account.rs) increments the epoch before account switching; the [call completion path](../../crates/container-sdk/src/lib.rs) first revokes the accurate application scope upon successful application exit, then handles guest subsequent execution. Sibling versions in the same scope are retired, while other apps, publishers, and environments are retained.
- native snapshot owner context prevents old sessions, old accounts, or old installations from writing to a new owner; it does not define the order of authorization revocation within the same owner.
- [Web reference client](../../examples/hosts/web-wasm/reference-identity-client.mjs) already includes generational data/phone number information within client instances, as well as pre- and post-disclosure checks. [BrowserHostServices](../../examples/hosts/web-wasm/browser-host-services.mjs) differentiates between external host notifications and internal refreshes, preventing delayed refreshes from overriding notifications, and re-reading on opaque version conflicts. These protections do not constitute backend atomic writes, nor do they establish a persistent authorization domain shared across all client instances.

<a id="持久授权域与执行-owner"></a>
## Persistent Authorization Domain and Execution Owner

The persistent authorization domain is recommended to be defined as:

```text
D = (hostAppId, tenantId, publisherId, principalId, appId, environment)
C = (D, kind)                  kind = profile | phone
E = (D, principalEpoch, sessionId, incarnation/ownerRevision)
```

`C` is the authorization domain shared by all instances within the same host and recorded by the backend; `E` is the ownership of a execution and its asynchronous results. `purpose` and `permissionVersion` are part of the authorization contract, determined by the backend's current policy and saved, validated along with the authorization record. When they change, the original authorization is revoked and the revision of that kind is incremented.

Persistent authorization defaults to not binding `principalEpoch`. When the same user logs in again or updates credentials, all data, including phone number authorization, should not be lost as a result. The epoch must be bound to the host bearer, challenge confirmation, phone number code, and execution context; requests from old epochs are always rejected. A new epoch for the same user can read valid persistent authorizations, but old requests, old challenges, and old codes cannot be reused. Upon application exit, persistent consent is retained; upon account deletion, all authorizations and challenges for the user are cleared.

`version`、`packRoot` are not included in `D` or `C`; legitimate upgrades retain authorization. Each request must still verify that the current package is in the trusted installation record; the hash itself does not prove issuer identity. Authorizations across different publisher, user, app, tenant, or environment must never be merged across generations.

Currently, the `consentKey()` of the reference service reuses the epoch-aware `ownerKey()`, and the registry lacks an independent publisher field; `miniAppId` is globally unique within a service instance. These are current choices, not equivalent to new domain implementation. Migration must be reviewed separately:

- New registry entries must register a trusted `publisherId` and verify the publisher from the native context; guest self-reported publishers are not accepted. Existing appId rebindings must be explicitly rejected or migrated.
- Old consent hash keys and records lack a complete, recoverable authorization domain and cannot be inferred by appId, latest logged-in account, or existing package hash. Without host validation of mappings and migration entry points, v2 reauthorization is required.
- Whether to migrate previously confirmed grants from the same user's old epoch and how to prove their ownership remains unimplemented and pending batch determination. Cross-account imports are not automatically supported, and existing pairwise app user IDs are not altered during migration.

<a id="协议版本和旧客户端门禁"></a>
## Protocol Version and Old Client Gatekeeping

Current HTTP `/health` only returns a health status; there is no independent identity protocol negotiation. The `/v1/host/consents` endpoint will not reject requests due to unknown JSON fields. **Adding an optional `revision` field is unsafe**: new clients may be ignored by old services, while old clients might continue to grant unconditionally.

Suggest adding the following independent contracts, all named as proposals:

| Layer | Proposed Gate | Behavior when not met |
| --- | --- | --- |
| Backend | `/v2/host/identity-capabilities` returns `identityProtocol:"2.0"`, `consentRevision:"1.0"`, `scopeSchema:"2.0"` | New client initialization fails, does not fallback to `/v1` authorization or disclosure |
| app registration | `identityProtocol:"2.0"` strict mode; recommended as default for new registrations | v1 grants, profile disclosure, SMS code issuance/swap returns `426 identity_protocol_required` |
| runtime | `capabilities.hostServices.consentRevocation === "1.0"`; Web runtime entry provides equivalent capabilities | No capability can claim to have the new revocation semantics, nor load a configuration that requires that capability |
| Configuration/Archival | `hostServices.requirements:{consentRevocation:"1.0"}`, SDK and runtime are built in the same submission series and locked with a digest | Terminate on check or configuration failure, do not continue without deleting requirements |

base host services `1.0`、C ABI `1` can be retained, new JSON capabilities and command expression extensions are added. [Existing `HostServicesConfig`](../../crates/container-runtime/src/host_services.rs) uses `deny_unknown_fields`; old runtime will reject if it receives a new `requirements` field, and cannot simply hide the requirements inside the `syncValues` that the old runtime accepts. New runtime, all SDKs, and preflight/rebuild configuration replay must preserve and validate this field. The existing schema is not modified.

Strict mode must also cover trusted process-intrinsic calls. Direct service calls such as `setConsent()`, `profile()`, `hostProfile()`, `phoneCode()`, `exchangePhone()` cannot serve as bypass entry points without revision outside of HTTP v2. Old signatures are only available for explicitly identified legacy apps; strict apps must use v2 methods or obtain `identity_protocol_required`.

During migration, legacy apps are temporarily allowed to continue using v1, but they lack the rollback guarantees of this design and cannot be used for new capability acceptance. Strict apps' v1 **rollback/rejection** can retain a deny-only compatibility entry: internally, the same transaction rollback must be invoked, the v2 revision must be promoted, and a rollback event must be issued; the old pattern must not be called. v1 login, session lookup, and app exit can maintain the original contract; these operations cannot grant profile or phone number information.

A new client accessing an old service's v2 path returns 404, or receives a 2xx response with missing protocol details or missing fields—all should be treated as protocol not supported/invalid responses. The new service must not return a non-2xx response for grants lacking revision/challenge, and it should not first grant access before issuing compatibility warnings. HTTP version, package version, and runtime capabilities are not mutually substitutable proofs.

<a id="后端原子-revision-与确认-challenge"></a>
## Backend atomic revision and confirmation challenge

<a id="数据和有效期"></a>
### Data and Validity Period

Each `C` saves a durable, monotonically increasing revision. Online transmission uses a standardized decimal u64 string, initialized to `"0"`; no conversion via JSON number, double, or SQLite floating-point types is allowed. SQLite stores it as TEXT, compared and incremented using `BigInt` within an `BEGIN IMMEDIATE` transaction; writes are rejected if exceeding the u64 upper limit, and no wraparound is permitted. `authorizationVersion` remains an opaque public snapshot identifier and must not be treated as this counter.

The suggested data objects are as follows, specific table names can be adjusted during implementation, but semantics must not be omitted:

| Object | Required Data |
| --- | --- |
| consent state | `C`、revision、granted、purpose、permissionVersion、policyDigest、expiresAt |
| challenge | Store only the hash of a random token; `C`, host session ID, principalEpoch, expectedRevision, policyDigest, expiresAt, consumed flag |
| decision | `(C, decisionId)` unique, request summary, used challenge, submitted revision and result; used for idempotency verification after lost responses |
| change record | `C`、revision、granted、source decisionId、recoverable event sequence number; excludes data, number, bearer |

challenge suggests a validity period of 60 seconds and must not exceed the parent host session; token must be at least 256 bits of random. It delivers only a trusted host authorization to the executor and cannot access guest, Worker, URL, or logs. The backend still trusts the host to present a real UI; the challenge cannot prove that the user clicked a button.

policy updates, deletions, and grant expirations must become atomic state transitions during checks: revoke authorizations, increment only the corresponding kind's revision, and invalidate the old challenge. The current version of the policy must also belong to the same transactionally visible data, and it must not simultaneously validate the old policy in memory while writing the new state. Reconfiguration or restart must not reset the revision to zero.

<a id="v2-路径和字段"></a>
### v2 paths and fields

Except for the business entry point, the following paths use the host bearer with POST JSON. Retain the `miniAppId,packRoot,expectedPrincipalId,expectedPrincipalEpoch` from the trusted selection, and add `expectedPublisherId`. The backend obtains authoritative identities from the bearer, the registration table, and the trusted installation record, then validates these expected values; it does not select a different user or publisher from the body. v2 requests must reject unknown fields, and 2xx responses must include an exact `identityProtocol:"2.0"`; retain the original 256 KiB request/response limit.

| Path | Request Increment | Response Contract |
| --- | --- | --- |
| `/v2/host/identity-capabilities` | Trusted selection | Three-party precise protocol; supported kind and server-side request/response limitations |
| `/v2/host/authorization-policy` | `kind` | `identityProtocol:"2.0",kind,purpose,permissionVersion,revision,challengeId,expiresIn` |
| `/v2/host/consents` | `kind,granted,decisionId`; grant additionally requires `challengeId,expectedRevision,purpose,permissionVersion` | `identityProtocol:"2.0",kind,granted,revision,decisionId`; grant with remaining authorization validity period |
| `/v2/host/identity-state` | Trusted selection | Four boolean values, opaque `authorizationVersion`, `consentRevisions` per kind, and remaining validity period; includes public `userInfo` only when data is valid |
| `/v2/host/profile` | `expectedConsentRevision` | `identityProtocol:"2.0",kind:"profile",revision,userInfo`，information contains only public fields |
| `/v2/host/phone-codes` | `expectedConsentRevision` | `identityProtocol:"2.0",kind:"phone",revision,code,expiresIn` |
| `/v2/apps/profile` | app bearer; `expectedConsentRevision`, scope obtained from the session and trusted registry | Same revision and public data contract as the host profile; cannot circumvent v1 app profile |
| `/v2/apps/exchange-phone` | business confidential client; `code,appAccessToken` | verified phone number; checks code ownership, epoch, current phone revision, and grant within the transaction |

`decisionId` uses a randomly generated, opaque identifier created by the host, with a length of at least 128 bits, and accepts `[A-Za-z0-9_-]{22,128}`. challengeId uses the base64url-encoded, unpadded 32-byte random token; neither contains account or package information. All revision fields accept the normalized decimal string `0..18446744073709551615`, rejecting digits, symbols, leading zeros, and overflow.

Expected revision of phone number request must equal the current value and the kind must be authorized. Conflict returns `409 consent_revision_changed`, unauthorized returns `403 consent_required`. The phone number code issued is simultaneously bound to v2 tag, `C`, principalEpoch, phone revision, and package installation identity; it cannot be redeemed across applications, across accounts, across epochs, upon revocation, reauthorization, or policy change. Strict app's old phone number code without revision is explicitly denied and cannot be upgraded to "current revision". Errors attributed to a user do not consume other user's codes.

`consentRevisions` are check data of the host protocol. Each SDK must project the guest snapshot whitelisted, and must not pass the entire backend object verbatim to JS. The guest public schema remains four authorization states, opaque version, and authorized public data; host token, challenge, decision, and internal owner information are not part of the snapshot.

<a id="grant-事务"></a>
### grant transaction

The following steps are within the same transaction; if they fail midway, authorization is not altered, and no other party's challenge is consumed:

1. Validate host session, current principalEpoch, publisher, application, and installation; normalize `C`, handle policy/expiration state transition for this kind.
2. Look up `(C, decisionId)`. For different requests with the same ID, return `409 consent_decision_conflict`. A successfully replayed request only succeeds if the current revision still equals the submitted revision; otherwise, if it has been superseded by a subsequent decision, return `409 consent_decision_superseded`, and no old granted:true success credential may be returned.
3. Validate that the challenge is not expired or used, and that its `C`, host session, principalEpoch, policyDigest, and request are completely identical, and that `expectedRevision` matches exactly with the challenge and current state revision. Other calls cannot reuse this challenge.
4. Compare the purpose/version confirmed by the UI with the current policy. Perform an atomic write of `granted:true` and `revision + 1`, consume the challenge, record the decision and change record, then commit.

Missing challenge/revision for `428 consent_precondition_required`; invalid or expired or mismatched challenge for `401 invalid_consent_challenge`; policy changed to `409 authorization_policy_changed`. Clients must not silently refresh the revision and re-submit "allow" after these errors; a new decision must be obtained by re-presenting the current policy.

Response loss can be recovered by querying/retrieving the original decision using the same decisionId and same body; a new ID must not be created to automatically reassign. Replay does not guarantee continued authorization and must be processed according to the above superseded rules and current state.

<a id="revoke--deny-事务"></a>
### revoke / deny transaction

`granted:false` No requirement for old challenge or old revision; can still revoke when policy is deleted. After transaction verification of the currently trusted account/application, promote the kind revision, write false, record the decision and change record. The old challenge becomes invalid due to mismatched expected revision, and "successful request after revocation" of old allowance is not permitted.

Same decisionId replay strictly adheres to the request summary and superseded rules. Subsequent genuine new authorizations require a new UI, challenge, and decisionId. Profile revocation does not increment phone revision; phone revocation does not alter profile, app login, other users, or other applications; it also does not revoke already completed payment transactions.

The guarantee at the backend submission point is: old grants cannot be written anymore, and subsequent reads/claims are rejected based on the new revision. Responses that have been generated and cached on a host require isolation as described in the next section.

<a id="宿主异步检查与一次结算"></a>
## Host Asynchronous Checks and One-Time Settlement

The shared authorization coordinator should belong to an existing host/tenant account domain and store, per `C`, the local generation, current backend revision, and authoritative notification generation. It is authorization coordination state, not a second set of account epoch registry. All sessions within the same scope, different versions, and different client objects must connect to the same coordinator; different `C` values are separated. Native callbacks are enqueued and executed by the owning thread.

A disclosure call captures `E`, kind generation, and backend revision at entry, then rechecks at the following locations: before request enqueueing, after each await/platform callback, after popup decision, before sending a grant, before app snapshot, before entering native completion queue, and finally before entering JS. Adding only a judgment at the return data location leaves old snapshots and old grants written.

When the host initiates a revoke, it first increments the local generation of the corresponding kind to block old requests, old popups, and queued old results; then it submits a backend revoke, publishing a new revision and snapshot. The native revoke future must succeed only after the relevant owner has installed isolation boundaries, the backend has submitted, and local state projection has completed. If the backend or cleanup fails, it must return a queryable failure/pending cleanup status; old requests cannot be recovered; retries are only performed for incomplete stages.

Its own grant will also advance the revision. A call initiator can only accept the submission as its new authorization if the decisionId/challenge matches its own, the call generation has not been revoked or changed, and the result revision remains the current revision acknowledged by the coordinator. It is not permissible to "update the expected revision" merely because an HTTP response returns 2xx, thereby bypassing revocations that occurred during that period.

External host retraction notifications are authoritative events; ordinary state queries are observations. Ordinary refresh cannot promote authoritative notification generation, nor can it override a later authoritative retraction. Each decimal revision of kind can be precisely compared; opaque `authorizationVersion` cannot be compared for size. When concurrent reads conflict, a limited number of retries are allowed within the original deadline; if conflicts persist, the current call is rejected without infinite retries.

Must distinguish between two results:

- **owner retired**: Swap number, application exit or closure triggers cancellation and clearing along the existing path; old results do not enter new JS.
- **owner still alive but authorization expired**: On the owner's last settlement, cancellation/permission denial triggers budget release for the release call; callback fail → complete → Promise rejection maintains existing order. Generation failure cannot be silently returned after `current()`, nor can cancellation be initiated to `fail()` itself if it cannot send the final state.

User rejection, backend raw errors, and public `errCode/errMsg` are retained. Failure to refresh state is recorded as a second diagnostic entry and cannot replace the original rejection. Native popups, HTTP, and subscription teardowns still require draining; resources that have not yet been torn down are not considered released merely because JS has rejected them. Native `refresh()` / `revoke()` futures must also have success, failure, or cancellation states.

New runtime extension requires the definition of authorization fence and authoritative updates on the existing command/context channel, with full SDK transparency and runtime final validation at completion. The ordinary `updateHostServiceSnapshots` cannot serve as an authorization command to advance shared authorization generations; old runtimes are also not considered to support fences merely by accepting four boolean values. The specific command schema and context extension are the frozen outcomes required prior to implementation, and this document does not consider any undefined commands to be callable APIs.

All owners associated within the same host fall within the guaranteed scope of this batch's shared fence. Backend retraction requests from other processes or devices require the host to provide authentication notification/recovery mechanisms. If it does not receive such notification, data cached there cannot be simply "retracted" based on the server's revision alone. To guarantee no delayed delivery after successful cross-process retraction, backend owner leases, event replay, and fence ACK are required: unACKed live owners keep retractions pending; disconnected owners must locally block disclosure upon lease expiration, and reconnection must first synchronize before resuming. This notification/lease contract has not yet been established, and polling or a single HTTP 200 response cannot be considered valid cross-device immediate retraction acceptance.

<a id="受影响的客户端路径"></a>
## Affected client paths

The following table lists the scope to be modified, not the implementation or acceptance completion table.

| Client | Current Path | Missing Boundary |
| --- | --- | --- |
| Web direct / Worker | `reference-identity-client.mjs`'s `authorize/disclose/run`; `browser-host-services.mjs`'s handler/refresh/external state; `browser-host-account-manager.mjs` | v2 negotiation, challenge/CAS, per kind revision, cross-client/owner shared fence; retain current owner/external notification protection. host token/challenge stays in host realm and cannot be passed to Worker; custom identity provider must still check fence even if getState is not available |
| Android | [HostServicesClient.kt](../../sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/HostServicesClient.kt) transport, `AndroidHostIdentity.install/refreshState/prepareAccountState`, native AlertDialog | transport currently only accepts `/v1/` and requires explicit addition of precise v2 path; exposes native future, handler, UI decision, snapshot/event, and completion queue for inspection; retains original error on rejection. Cannot modify only the error branch |
| iOS | [HostServicesClient.swift](../../sdk/ios/Sources/WeappContainer/HostServicesClient.swift)'s `WeappHostIdentity.install/refresh/confirm`, `WeappHostIdentitySnapshot` | transport has the same limitation on `/v1/`, must add precise v2 paths; check after each await and UIAlertController continuation; shared domain and revision/CAS; avoid refresh overwrite or secondary failure replacement of original rejection; strict replay required upon reconstruction |
| Harmony | `HarmonyReferenceIdentity.invoke/profile/refresh` in [ReferenceHostServices.ts](../../examples/hosts/harmony/entry/src/main/ets/session/ReferenceHostServices.ts); completion queue in `HostServices.ts` | Current refreshSequence only represents the request order of the current instance and cannot serve as backend authorization revision; adds v2 challenge, shared fence, post-disclosure checks, and real button event isolation |
| Desktop Endpoints | client/parser in `sdk/desktop/src/host_services.cpp`; `disclosure/authorize/refresh_call/refresh/revoke` in `host_services_adapter.cpp`; platform consent presenter | Fix the root cause described in this document, distinguish between owner and authorization checks; preserve wire context, native futures, and mailbox throughout with fence; macOS/Windows/Linux share the same semantics, native UIs each perform their own clearing |
| Flutter / React Native | Corresponding public API handler, native transport, preflight, and reconstruction configuration replay; Flutter desktop registry and its referenced Desktop source code | Cannot update only the lower-layer SDK lock and discard requirements, context, or authorization final states; actual source code within the archive and public cross-language linkage must both be verified. Custom host business implementations must adhere to the same v2 contract |

Synchronous identity snapshot must still be prepared before loading and cannot fake the synchronous interface by waiting for UI/network. Phone number verification must retain the real `button open-type="getPhoneNumber"` → runtime binding → native authorization → `bindgetphonenumber` flow, without introducing a fictitious `wx.getPhoneNumber`.

<a id="验收在真实响应生成后设置-gate"></a>
## Acceptance: Set the gate after real response generation is completed

Existing Desktop `run-host-services-reference.mjs` has a simple delay that waits *before* executing the handler, which cannot prove a "late response after data generated/code issued". The Web standalone fixture already has a gate completed after login-code processing, but has not yet completed profile, phone, state, or stale grant acceptance for this design. New fixtures should provide two separate gates and must not be mixed:

1. **Post-generation response gate**: The actual HTTP handler has completed authentication, SQLite operations, and response generation, and then only pauses transmission; state queries return only sequence, stage, pending/issued booleans or counts, and never return intercepted data, code, or credentials. Releases are made on exact sequence; error sequences return a conflict. Used for delayed disclosure, code, state, and grant receipt.
2. **Pre-submission request gate**: The actual HTTP request has been received and parsed, but the grant transaction has not yet been executed; allows revoke to submit first, then restores the old grant, proving CAS rejects the old decision on the server side. Mocking of the service is not allowed, and the first gate cannot be used as proof of transaction contention.

gate must be bounded, supporting original call cancellation, timeout, and service shutdown. Cleanup should first release/terminate the gate, then wait for the own HTTP server to close; do not leave pending requests for test passing. The fixture's control, host bearer, client secret, and business app bearer do not log or enter guest. Error assertions output only the stage, status code, count, or boolean value.

| Mandatory Scenarios | Pass Criteria |
| --- | --- |
| Old profile / phone response generated, then revoked, then released | Active owner once rejected; no userInfo/code success, old event, or old snapshot; phone number backend exchange also rejected |
| Old consent request is paused before transaction, revoke first then release | backend CAS not 2xx; grant remains false; old UI decides reauthorization is not possible |
| grant submitted but receipt paused, during which it is withdrawn | receipt not adopted as new revision; grant or disclosure cannot be recovered; repeated decision cannot replay previous success |
| Rollback at each stage of popup, refresh, and completion queue | Respects each await and queue boundary; budget released after native UI/HTTP termination, pending resources explicitly marked |
| Concurrency of two refreshes, version/response order reversed | Converges on exact revision and authoritative generation per kind; does not sort by opaque string; does not retry indefinitely |
| Two owners/clients within the same scope, valid upgrade packages | Revoke all instances of the same kind; retain instances of other kinds; instances with different publisher/app/user/env are unaffected |
| New epoch to user, different user, app exit, account deletion | Persistent authorization handled according to final migration strategy; old epoch challenge/code/request rejected; exit retains consent; deletion cleans up durable domain |
| challenge and decision replay, expiration, reuse, or request summary modification | single, ownership, policy, idempotency all validated by SQLite transaction; erroneous requests do not consume another's challenge/code |
| policy change/deletion, grant expiration, service restart | corresponding kind revision monotonically increases, old authorizations expire, revision is not reset due to restart; the other kind is unaffected |
| New/old services, new/old clients, new/old runtime combinations | Strict app without revision grant never succeeds; old backend/old product explicitly not supported; cannot automatically rollback to v1 |
| After rejection, withdrawal, or validation failure, state refresh also fails | Original rejection/business error is retained; both native future and JS Promise are terminated; no old successful snapshot is left |
| Continuous reversion/reauthorization, number change, closure, and reload failure | Latest decision is valid; previous calls are not inherited by the new owner; cleanup failure can be retried but old identity cannot be recovered |

Acceptance layering records, not mutually replaceable:

- Backend: Node.js 24, real loopback HTTP, SQLite transactions and reopen, covering the above CAS/old client access control; authentication secrets are retained only on the server side.
- Return of limited client: public native future, callback/Promise ordering, cancellation, and bounded queue. Controlled consent presenter only proves lifecycle and cannot prove system authorization UI.
- Real SDK flow: from installable archive to fresh installation, via public SDK → native transport → QuickJS/V8 → actual completion/events → JS, bound with SDK, runtime digest, and OS. Web direct/Worker separately recorded.
- Component and platform UI: Desktop current complete reference fixture creates only Session; actual View is not attached. Records of skipping the phone number step cannot be considered component presentation success. A real native View, normal layout/presentation, and button input must be provided before acceptance. Android/iOS/Harmony require real buttons and host UI; when platform conditions are missing, retention for acceptance is required.

Execute commands and add new gate/mode names must be documented with evidence after implementation; pre-filled "passed" is not allowed. Existing entry points include reference services `node --test test/*.test.mjs`, Desktop CMake's `desktop_host_services_reference`, `desktop_host_services_backend_errors`, and existing identity integration tests on each end; existing error projection tests passing does not imply this design is complete.

Each record is bound to API, kind/parameter range, source code commit, installation artifact digest, OS/browser, SDK, actual command, assertion result, and cleanup record. Entries lacking external notifications, system UI, device, or archival conditions remain pending acceptance; this document does not alter their status.

<a id="实施依赖与待决项"></a>
## Implementation Dependencies and Pending Items

Persistent domain and v2 HTTP fields have been frozen and implemented; `/v2/apps/profile` is POST, with validity period fields of `consentExpiresIn:{profile,phone}`. Old epoch/v1 consent does not auto-migrate; v2 reauthorization is required; application trust domain rebinding and strict→legacy downgrade are both denied. Next, freeze the new runtime command/context schema, then integrate with the shared coordinator and each SDK. Sync example batches, documentation, and strict artifact manifests, and use new archival acceptance; historical artifacts and old evidence are retained.

Still need to clarify the specific wire schema for shared fence in native/runtime, as well as whether lease/ACK and their recovery contracts are required for cross-process/device notifications. Reauthorize when old authorization lacks a trustworthy mapping; provide an explicit trustworthy migration entry point if migration is needed.
The entire revocation contract cannot be marked as implemented, nor can the goal be marked complete, until shared fence, SDK, and acceptance on all ends are finished.
