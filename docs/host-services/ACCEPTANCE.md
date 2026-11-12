# API responsibilities and acceptance ledger

The fixed input remains WeChat base library 3.17.3 and all 1265 catalog names.
`owner` and `kind` retain their transport/security meaning. The separate
`responsibility` field identifies runtime, device adapter, host business service
or ecosystem work; it never grants registration permission or proves support.

## Implementation and acceptance are separate

`implementationState` records `missing`, `partial`, `available`, or
`requiresHostService`. Source references distinguish `runtimeImplementation`,
`runtimeBridge`, `jsFacade`, `protectedBoundary`, and `platformProvider`.
For example, `getDeviceInfo` has a synchronous core snapshot bridge. The
`StrictHostProvider` accepts snapshots supplied by its caller; it does not
measure the device. A core bridge with no installed native data source is
`partial`. The deterministic SandboxProvider cannot fill that gap.

The public acceptance statuses remain `implementedAndAccepted`,
`pendingAcceptance`, and `platformNotApplicable`. A restriction needs the
existing official-source record and must not conflict with a concrete
implementation. Missing credentials, hardware or code leave a cell pending.

## Files

- `api-responsibilities.json` contains every exact name once and binds its
  ordered-name digest and base library to the locked catalog.
- `acceptance-contracts.json` defines reviewed finite API/host scopes. A `completeApplicableScope`
  contract can promote an API only after every declared SDK/engine chain has a sealed report;
  `partialScope` records evidence without promoting the whole API.
- `acceptance-ledger.json` references only sealed real SDK-chain reports by path and SHA-256;
  historical build, simulator and source evidence is never imported automatically.
- `scripts/host-api-matrix.mjs` validates reports and builds cells without
  executing report content.

## Contract scopes

A reviewed contract identifies one API and host. Every required public SDK
chain for that host must occur in at least one finite profile:

| Host | Required chains |
| --- | --- |
| Android | native, Flutter, React Native |
| iOS | SwiftPM, CocoaPods, Flutter, React Native |
| Harmony | native |
| Web | direct, Worker |
| macOS, Windows, Linux | native, Flutter |

Each profile states parameters, platform conditions, SDKs, applicable actual
engines (`quickjs` or `v8`), semantic/lifecycle checks, source closure and any
required physical hardware or merchant transaction. Review must enumerate
meaningful denial, revocation, cancellation, cleanup, multi-account and late
result cases for the capability. A single happy path does not establish all
parameter or lifecycle behavior. Both engine semantics must be covered by the
appropriate runtime acceptance work; a platform profile must use engines the
delivered platform actually supports.

Each contract explicitly records `baselineCoverage: completeApplicableScope`
or `partialScope`. A reviewed subset may accept its individual profile chains,
but leaves the whole API pending. Reviewers may claim complete scope only after
covering every applicable parameter and condition in the locked declaration;
an official restriction must justify any excluded platform scope.

The matrix includes each profile and SDK/engine chain. A missing contract or
any missing chain leaves acceptance pending. The accepted status applies only
to the explicit recorded parameter and platform conditions.

## Report sealing and provenance

A report has `kind: real-sdk-chain` and claims one API/host/profile/SDK/engine.
It records the exact profile parameter and platform scope; named OS and
version; browser and version for Web; actual command, zero exit status and
digest-bound raw output; successful public SDK, native transport, real JS and
completion/event-to-JS checks, plus all profile-specific checks.

Source records use repository-relative paths. A source record binds repository,
commit and SHA-256; validation checks the commit is reachable and both the git
object and current source have those bytes. Profiles declare the reviewed
source closure, including core and SDK/adapter/transport inputs. An unrelated
documentation commit need not invalidate evidence; any changed source input
does. Submodule sources bind the corresponding SDK repository commit.

Runtime and SDK artifacts each bind file digest, source repository/commit,
preview version, host, architecture, feature set and capability protocol. A
digest-bound build receipt must match those fields and state a release build
from clean sources. SDK artifacts also bind the public SDK chain. This new
ledger does not replace historical ORIGIN or archived evidence.

The cleanup receipt lists created and borrowed resources. Created resources
must be closed. Borrowed resources remain preserved and need a recorded
reason. Missing or failed cleanup leaves the report invalid. A hardware or
merchant requirement cannot be replaced by a simulator/harness report.

The generator computes acceptance only after all references and scope checks
pass; callers cannot set accepted status directly. Existing build, limited
test, simulator, hardware and merchant evidence remain distinct categories.

## Current baseline

The formal ledger currently promotes two Web codec API cells (`wx.arrayBufferToBase64` and
`wx.base64ToArrayBuffer`) across direct/Worker QuickJS chains. It also records finite partial
scope for `wx.canIUse`, `wx.getWindowInfo`, `wx.getSystemSetting`, `wx.getAppBaseInfo`,
`wx.getDeviceInfo`, and `wx.getAppAuthorizeSetting`; those APIs remain pending until all
declared parameters and conditions are covered. `wx.getNetworkType` has a separate Web
`partialScope` contract covering the finite online/Network Information mapping and its
direct/Worker callback chain; the API remains pending outside that scope. All other cells
remain pending or platform restricted according to the generated matrix. Source inventory
and the validator regression suite establish accounting integrity; they do not claim platform
acceptance.
