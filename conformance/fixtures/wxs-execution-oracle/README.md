# WXS execution oracle

This is an observation fixture for the explicitly selected WeChat DevTools
`2.02.2608080`, SDK `3.17.3`, configured `webview` renderer. Its checked-in status
is **unknown**. The fixture and local structural tests do not prove official
runtime behavior, GPU rendering, device parity, or a near-parity release gate.

The page records AppService lifecycle/observer/setData-callback events separately
from text produced by View WXS. Every `mark` has a module-local counter and a
shared dependency counter. Read-only `history` bindings expose whatever the
official view actually renders. They are samples, not a complete call trace:
dependency caching can leave a history binding stale, and instrumentation may
affect evaluation. No expected counter, evaluation order, scope isolation, slot
fallback behavior, or unused-light-child behavior has been invented.

The scenarios cover the first stable frame after `onReady` (with initial
`BEFORE_ONLOAD` data retained in the lifecycle record), same-value updates with no
hidden view stamp, A → B → A, branches, keyed row changes, page/import/include/
nested-include aliases, multiple component instances, named/default slots,
fallback and unused light children, a component without slots, data-bound style
changes, reLaunch, and an actual WXSS file edit. A missing pre-onLoad WXS sample
does not prove that WXS never ran before onLoad. Query errors are recorded as
errors rather than interpreted as absent nodes.

Run only on a cold, available host after verifying resource ownership:

```bash
node --import ./vendor/weapp-vite/node_modules/tsx/dist/loader.mjs scripts/wxs-execution-oracle.ts --run
```

Use `--out <new-directory>` and `--cli <selected-cli>` to choose output and the
CLI. Without `--run` the runner prints its scope and exits without querying or
starting tooling. A real AppID is read from the existing upstream E2E project
config, or `WEAPP_CONTAINER_ORACLE_APPID`; it is never checked into this fixture.
The runner synchronizes generated project/private condition configs, queries
the official stable channel, records the fixed-version exception if necessary,
claims a cold host under the machine lease, and opens one automator session.
It never connects to or terminates a manual/foreign/unknown IDE.

The runner saves source/effective-project SHA-256 maps, actual IDE/SDK reports,
AppService trace, rendered text, layout style, screenshots, console/exception
events, and per-step transport status. A controlled WXSS edit is considered
delivered only when the computed border width changes; a timeout is blocked,
and there is no force-compile fallback labelled HMR. All observation calls are
read-only. The original task-copy WXSS is restored during cleanup.

`observed` means this fixture's observations were collected against the checked
baseline, not that any semantic expectation passed. Missing baseline evidence,
runtime exceptions, failed capture, failed style delivery, or incomplete cleanup
retain a blocked/cleanup-failed status. Automator capture begins after launch;
the fixture's App lifecycle trace also retains early errors, but no complete
prelaunch console coverage is claimed. The actual renderer is only reported if
the tool/environment supplies it; configured renderer is not substituted for it.

Pure local structural validation (does not start DevTools):

```bash
node --test scripts/wxs-execution-oracle.test.mjs
```

The original execution page and its 16 ordered steps remain unchanged. After
those captures, the same automator serially opens the independent
`pages/datatypes/index` route once per entry in `datatype-cases.json`. These 18
cases observe eight constructor types, computed reads, own overrides, user
prototype overrides (or the actual absence of `Object.create`), Array methods,
fixed UTC Date operations, RegExp captures/state, and invalid pattern/flag
boundaries. Every case launches a new page instance; this does not assume that
the official renderer recreates its WXS module cache. Error probes do not use
`try/catch` to assume unverified WXS exception syntax or hide renderer errors.
No case has a checked-in official expected value or error.

`datatypes.observations` retains the case-local AppService errors, tool
exceptions/console, raw selector dataset, and a versioned normalized record.
A value requires a fresh dataset whose `case` matches the requested case.
Missing values without reported errors remain `unresolved`; transport failures
are blocked. A value accompanied by errors remains `value-with-errors`.
Console messages alone are not interpreted as proof that a renderer failed.
The original execution suite's exception check still runs before these isolated
error probes. `observed` remains collection status, never a semantic pass.

Collect the **same raw fixture** through a freshly built dual-engine simulator:

```bash
node scripts/wxs-datatype-differential.mjs \
  --simulator-bin /absolute/path/to/weapp-simulator \
  --out /absolute/path/to/native-observations.json
```

The explicit binary is required. This collector does not run Cargo, start an
IDE, open a browser, or bind a port. It verifies every packed blob, records the
binary/source/fixture hashes, and executes each case in a separate native
QuickJS and V8 process. It sends a complete startup/render/selector bridge
sequence and retains correlated responses, including render errors. Native
matching values are auxiliary evidence and do not change the official
`unknown` statuses in the case inventory.

After an actual official run, add `--official-report <run>/report.json`. The
collector requires recorded actual IDE/SDK versions, a completed baseline
capture, byte-identical fixture hashes, per-case SDK/readiness/identity, and
normalized values derived from the retained raw data. It rejects mismatched or
unverified inputs. Comparisons report `matched`, `different`, or
`incomparable` per case. Two failed renders are **incomparable** until their
error shapes have been reviewed; they cannot silently count as equivalent.
An overall `observed` report therefore can still contain an incomplete error
comparison. A differing value fails the collector command. Neither this
collector nor a local VM supplies missing official evidence.
