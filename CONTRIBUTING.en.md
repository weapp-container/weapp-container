<a id="参与贡献"></a>
# Contributing

[简体中文](CONTRIBUTING.md) · **English**


Please read the README in the root directory, the architecture, and the module documentation. Use Node.js 24.x, pnpm 10.15.1, and Rust stable, recursively initialize the fixed submodules, and run `pnpm install --frozen-lockfile`.

Create a short-lived feature or bug fix branch from `main`, for example `feat/<topic>` or `fix/<topic>`. PRs should describe the triggering mechanism, root cause, behavioral changes, and verification results. SDK modifications should first be submitted to a separate repository, then the main repository pointer should be updated. Do not submit cache files, signature materials, runtime archives, or device personal data.

Run the check commands described in README and regression tests for modified modules. Full Rust tests should use `-- --test-threads=1`; avoid time-limited engine tests that may contend for CPU. Official tools, devices, GPUs, and performance validation require additional environments; clearly specify the actual execution scope and reasons for unexecuted cases. Unit tests cannot serve as evidence of real device or full WeChat compatibility.

PRs and pushes to `main` run source policy, API inventory, SDK contracts, Rust lint, complete workspace tests, desktop GPU checks, bilingual documentation, and full-history secret scanning in parallel. Only a nonempty diff containing root README, contributing/conduct/security guides, `docs/**/*.md`, and `documentation.json` may omit Rust and API source inventory checks. Other paths, unavailable comparison history, and manual runs use full coverage. `Source and contract checks` and `Rust workspace` aggregate all applicable jobs; a failure, cancellation, or unexpected skip prevents a successful aggregate.

New commits cancel outdated automatic checks on the same PR or `main`; manual full validation is retained. Rust dependency build caches are separated for lint, tests, and desktop GPU. Only successful jobs on `main` write caches; PRs restore them. Workspace source, release artifacts, and execution evidence are generated afresh each time. `Public native production` runs contracts and all nine target builds in parallel; packaging and offline validation wait for both groups to succeed.

When fixing issues, first understand boundaries, data flows, and lifecycle. For reproducible behavior issues, supplement with meaningful regression tests. Any public CLI, C ABI, or SDK compatibility changes must be explicitly documented.

Contributions are governed by the license of the respective component, and third-party declarations are retained. Only content for which you have the right to distribute should be submitted. [Conduct Guidelines](CODE_OF_CONDUCT.en.md) apply to collaboration. For security issues, report them privately via [SECURITY.md](SECURITY.en.md).
