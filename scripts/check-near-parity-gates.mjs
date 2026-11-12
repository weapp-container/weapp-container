#!/usr/bin/env node
/**
 * Aggregate the evidence required before calling a build near-parity.
 *
 * This is an audit command. It never upgrades headless, shell reachability or
 * software-fallback evidence to a runtime pass. Missing artifacts are reported
 * as incomplete and the command exits non-zero unless every required gate is
 * authoritative and complete.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { inspectEvidenceSource } from './evidence-source.mjs'
import { inspectMobileModuleExecution } from './mobile-module-evidence.mjs'
import { inspectPackExecutionMatrix, EXECUTION_HOSTS, MOBILE_EXECUTION_HOSTS } from './pack-execution-evidence.mjs'
import { inspectConformanceEvidence } from './conformance-evidence.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXPECTED_HOSTS = ['web', 'macos', 'windows', 'linux', 'android', 'ios', 'harmony']
const EXPECTED_ENGINES = ['quickjs', 'v8']
const EXPECTED_MATRIX = ['weapp', 'alipay', 'swan', 'tt', 'jd', 'xhs']
const sourceChecks = new Map()

function sourceRevision(sourceCommit, expectedCommit) {
  const key = `${sourceCommit}/${expectedCommit}`
  if (!sourceChecks.has(key)) sourceChecks.set(key, inspectEvidenceSource(ROOT, sourceCommit, expectedCommit))
  return sourceChecks.get(key)
}

function parseArgs(argv) {
  const options = {
    index: 'docs/conformance/case-index-v1.json',
    conformanceReport: null,
    matrix: 'artifacts/weapp-vite-matrix.json',
    mobile: null,
    hostBridge: null,
    hostExecution: [],
    performance: [],
    performanceIndex: null,
    ledger: 'docs/evidence-ledger.json',
    out: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--index') options.index = argv[++i]
    else if (arg === '--conformance-report') options.conformanceReport = argv[++i]
    else if (arg === '--matrix') options.matrix = argv[++i]
    else if (arg === '--mobile') options.mobile = argv[++i]
    else if (arg === '--host-bridge') options.hostBridge = argv[++i]
    else if (arg === '--host-execution') options.hostExecution.push(argv[++i])
    else if (arg === '--performance') options.performance.push(argv[++i])
    else if (arg === '--performance-index') options.performanceIndex = argv[++i]
    else if (arg === '--ledger') options.ledger = argv[++i]
    else if (arg === '--out') options.out = argv[++i]
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

function absolute(path) { return resolve(ROOT, path) }

function readJson(path) {
  const absolutePath = absolute(path)
  if (!existsSync(absolutePath)) return { path: absolutePath, value: null, error: 'missing file' }
  try {
    return { path: absolutePath, value: JSON.parse(readFileSync(absolutePath, 'utf8')), error: null }
  } catch (error) {
    return { path: absolutePath, value: null, error: error.message || String(error) }
  }
}

/**
 * Discover matrix indexes without trusting a generated, ignored working-tree
 * directory.  Versioned evidence under docs/performance-evidence is searched
 * as well as local artifacts, then the newest index by its recorded
 * generatedAt/commit is selected deterministically.  The selected index is
 * still checked against HEAD below; only intervening evidence archive/index
 * commits may reuse a source measurement.
 */
function discoverPerformanceIndex(expectedCommit, explicitIndex = null) {
  const candidates = []
  const add = (path, source) => {
    const file = readJson(path)
    if (file.error || !file.value || !Array.isArray(file.value.reports)) return
    candidates.push({
      path: file.path,
      source,
      commit: typeof file.value.commit === 'string' ? file.value.commit : null,
      generatedAt: typeof file.value.generatedAt === 'string' ? file.value.generatedAt : '',
      reports: file.value.reports,
    })
  }

  if (explicitIndex) add(explicitIndex, 'explicit')
  // Keep the conventional generated location first for readability, but do
  // not let its order override an exact current-commit match.
  add('artifacts/performance-matrix/index.json', 'artifact')
  add('artifacts/performance-matrix-current/index.json', 'artifact-current')
  for (const root of ['artifacts', 'docs/performance-evidence']) {
    const rootPath = absolute(root)
    if (!existsSync(rootPath)) continue
    let entries = []
    try { entries = readdirSync(rootPath, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      const isArtifact = root === 'artifacts' && (name.startsWith('performance-matrix-') || name.startsWith('performance-current-'))
      const isVersioned = root === 'docs/performance-evidence' && name.length > 0
      if (!isArtifact && !isVersioned) continue
      // `perf:matrix` writes index.json directly beneath its --out-dir,
      // while the published evidence layout keeps the index under matrix/.
      // Discover both shapes so a fresh current-commit run is not hidden by
      // an older conventional artifacts/performance-matrix-current index.
      const source = root === 'docs/performance-evidence' ? 'versioned' : 'artifact-versioned'
      add(`${root}/${name}/index.json`, source)
      add(`${root}/${name}/matrix/index.json`, source)
    }
  }

  const unique = new Map(candidates.map(candidate => [candidate.path, candidate]))
  const all = [...unique.values()].sort((a, b) => {
    const byTime = b.generatedAt.localeCompare(a.generatedAt)
    return byTime || b.path.localeCompare(a.path)
  })
  const exact = all.filter(candidate => candidate.commit === expectedCommit)
  const reusable = all.filter(candidate => sourceRevision(candidate.commit, expectedCommit).compatible)
  const explicitCandidate = explicitIndex
    ? all.find(candidate => candidate.path === absolute(explicitIndex))
    : null
  const selected = explicitCandidate || exact[0] || reusable[0] || all[0] || null
  const resolveReportPath = (indexPath, report) => {
    if (typeof report?.path !== 'string' || report.path.length === 0) return null
    const direct = absolute(report.path)
    // Published evidence indexes historically pointed at ignored artifact
    // directories.  Prefer the tracked matrix sibling when present so a
    // fresh checkout can reproduce the gate without those directories.
    const sibling = resolve(dirname(indexPath), report.path.split(/[\\/]/).pop())
    if (existsSync(sibling) && (!existsSync(direct) || indexPath.includes(`${ROOT}/docs/performance-evidence/`))) return sibling
    return direct
  }
  const performancePaths = selected
    ? selected.reports.map(report => resolveReportPath(selected.path, report)).filter(Boolean)
    : []
  return {
    selectedIndex: selected?.path || null,
    selectedCommit: selected?.commit || null,
    selectedGeneratedAt: selected?.generatedAt || null,
    selectedSource: selected?.source || null,
    currentCommit: expectedCommit,
    currentCommitMatch: Boolean(selected && selected.commit === expectedCommit),
    sourceRevision: sourceRevision(selected?.commit, expectedCommit),
    candidateIndexes: all.map(candidate => ({
      path: candidate.path,
      source: candidate.source,
      commit: candidate.commit,
      generatedAt: candidate.generatedAt || null,
      currentCommitMatch: candidate.commit === expectedCommit,
      sourceCompatible: sourceRevision(candidate.commit, expectedCommit).compatible,
    })),
    performancePaths,
    reason: selected
      ? sourceRevision(selected.commit, expectedCommit).compatible
        ? sourceRevision(selected.commit, expectedCommit).reason
        : `selected performance matrix is stale for HEAD ${expectedCommit}`
      : 'no performance matrix index was found',
  }
}

/**
 * Discover the newest tracked host-bridge report while preferring an exact
 * source-commit match.  Host smoke reports are archived under
 * docs/host-evidence/<revision>/, whereas local runs commonly write one of
 * the conventional artifacts paths.  Looking in both places keeps the audit
 * reproducible after ignored artifacts are removed from a fresh checkout.
 */
function discoverHostBridge(expectedCommit, explicitPath = null) {
  const candidates = []
  const add = (path, source) => {
    const file = readJson(path)
    if (file.error || !file.value || typeof file.value !== 'object') return
    candidates.push({
      path: file.path,
      source,
      commit: typeof file.value.commit === 'string' ? file.value.commit : null,
      generatedAt: typeof file.value.generatedAt === 'string' ? file.value.generatedAt : '',
    })
  }

  if (explicitPath) add(explicitPath, 'explicit')
  add('artifacts/host-bridge-smoke-current.json', 'artifact-current')
  add('artifacts/host-bridge-smoke.json', 'artifact')
  const root = absolute('docs/host-evidence')
  if (existsSync(root)) {
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { entries = [] }
    for (const entry of entries) {
      if (entry.isDirectory()) add(`docs/host-evidence/${entry.name}/host-bridge-smoke.json`, 'versioned')
    }
  }

  const unique = new Map(candidates.map(candidate => [candidate.path, candidate]))
  const all = [...unique.values()].sort((a, b) => {
    const byTime = b.generatedAt.localeCompare(a.generatedAt)
    return byTime || b.path.localeCompare(a.path)
  })
  const exact = all.filter(candidate => candidate.commit === expectedCommit)
  const reusable = all.filter(candidate => sourceRevision(candidate.commit, expectedCommit).compatible)
  const explicitCandidate = explicitPath
    ? all.find(candidate => candidate.path === absolute(explicitPath))
    : null
  // An explicitly requested path is authoritative even when it is missing;
  // readJson() then reports the missing artifact instead of silently selecting
  // an unrelated versioned run.
  const selected = explicitCandidate || (explicitPath
    ? {
        path: absolute(explicitPath),
        source: 'explicit',
        commit: null,
        generatedAt: '',
        requireAll: false,
      }
    : exact[0] || reusable[0] || all[0] || null)
  return {
    selectedPath: selected?.path || absolute(explicitPath || 'artifacts/host-bridge-smoke-current.json'),
    selectedCommit: selected?.commit || null,
    selectedGeneratedAt: selected?.generatedAt || null,
    selectedSource: selected?.source || null,
    currentCommit: expectedCommit,
    currentCommitMatch: Boolean(selected && selected.commit === expectedCommit),
    sourceRevision: sourceRevision(selected?.commit, expectedCommit),
    candidates: all.map(candidate => ({
      path: candidate.path,
      source: candidate.source,
      commit: candidate.commit,
      generatedAt: candidate.generatedAt || null,
      currentCommitMatch: candidate.commit === expectedCommit,
      sourceCompatible: sourceRevision(candidate.commit, expectedCommit).compatible,
    })),
    reason: selected
      ? sourceRevision(selected.commit, expectedCommit).compatible
        ? sourceRevision(selected.commit, expectedCommit).reason
        : `selected host bridge evidence is stale for HEAD ${expectedCommit}`
      : 'no host bridge evidence was found',
  }
}

/**
 * Discover versioned mobile runtime reports in the same way as host bridge
 * and performance evidence.  The conventional ignored artifact is useful
 * during a local run, but a fresh checkout must select a tracked report and
 * reject one produced by a different source revision.
 */
function discoverMobileReport(expectedCommit, explicitPath = null) {
  const candidates = []
  const add = (path, source) => {
    const file = readJson(path)
    if (file.error || !file.value || typeof file.value !== 'object') return
    candidates.push({
      path: file.path,
      source,
      commit: typeof file.value.sourceCommit === 'string'
        ? file.value.sourceCommit
        : typeof file.value.commit === 'string' ? file.value.commit : null,
      generatedAt: typeof file.value.generatedAt === 'string' ? file.value.generatedAt : '',
      requireAll: file.value.requireAll === true,
    })
  }

  if (explicitPath) add(explicitPath, 'explicit')
  add('artifacts/mobile-runtime-smoke-required-current.json', 'artifact-current')
  add('artifacts/mobile-runtime-smoke-required.json', 'artifact')
  const root = absolute('docs/mobile-gpu-evidence')
  if (existsSync(root)) {
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { entries = [] }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        add(`docs/mobile-gpu-evidence/${entry.name}/mobile-runtime-required.json`, 'versioned')
      }
    }
  }

  const unique = new Map(candidates.map(candidate => [candidate.path, candidate]))
  const all = [...unique.values()].sort((a, b) => {
    const byTime = b.generatedAt.localeCompare(a.generatedAt)
    return byTime || b.path.localeCompare(a.path)
  })
  const exact = all.filter(candidate => candidate.commit === expectedCommit && candidate.requireAll)
  const reusable = all.filter(candidate => candidate.requireAll && sourceRevision(candidate.commit, expectedCommit).compatible)
  const explicitCandidate = explicitPath
    ? all.find(candidate => candidate.path === absolute(explicitPath))
    : null
  // An explicitly requested path is authoritative even when it is missing;
  // readJson() then reports the missing artifact instead of silently selecting
  // an unrelated versioned run.
  const selected = explicitCandidate || (explicitPath
    ? {
        path: absolute(explicitPath),
        source: 'explicit',
        commit: null,
        generatedAt: '',
        requireAll: false,
      }
    : exact[0] || reusable[0] || all[0] || null)
  return {
    selectedPath: selected?.path || absolute(explicitPath || 'artifacts/mobile-runtime-smoke-required.json'),
    selectedCommit: selected?.commit || null,
    selectedGeneratedAt: selected?.generatedAt || null,
    selectedSource: selected?.source || null,
    selectedRequireAll: selected?.requireAll ?? null,
    currentCommit: expectedCommit,
    currentCommitMatch: Boolean(selected && selected.commit === expectedCommit),
    sourceRevision: sourceRevision(selected?.commit, expectedCommit),
    candidates: all.map(candidate => ({
      path: candidate.path,
      source: candidate.source,
      commit: candidate.commit,
      generatedAt: candidate.generatedAt || null,
      requireAll: candidate.requireAll,
      currentCommitMatch: candidate.commit === expectedCommit,
      sourceCompatible: sourceRevision(candidate.commit, expectedCommit).compatible,
    })),
    reason: selected
      ? sourceRevision(selected.commit, expectedCommit).compatible
        ? sourceRevision(selected.commit, expectedCommit).reason
        : `selected mobile runtime evidence is stale for HEAD ${expectedCommit}`
      : 'no mobile runtime evidence was found',
  }
}

function status(ok, reason, extra = {}) {
  return { status: ok ? 'passed' : 'incomplete', reason, ...extra }
}

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch { return null }
}

function workingTreeDirty() {
  try {
    return Boolean(execFileSync('git', ['status', '--short'], { cwd: ROOT, encoding: 'utf8' }).trim())
  } catch { return null }
}

function checkMatrix(matrixFile) {
  if (matrixFile.error) return status(false, matrixFile.error)
  const report = matrixFile.value
  const actual = new Map((report.targets || []).map(target => [target.id, target.status]))
  const missing = EXPECTED_MATRIX.filter(target => actual.get(target) !== 'passed')
  const complete = report?.submodule?.matches === true && missing.length === 0
  return status(complete, complete ? 'all pinned weapp-vite build targets passed' : 'platform build matrix is incomplete', {
    submodule: report.submodule || null,
    targets: Object.fromEntries(EXPECTED_MATRIX.map(target => [target, actual.get(target) || 'missing'])),
    missing,
  })
}

function checkMobile(mobileFile, expectedCommit) {
  if (mobileFile.error) return status(false, mobileFile.error)
  const report = mobileFile.value
  const sourceCommit = typeof report?.sourceCommit === 'string'
    ? report.sourceCommit
    : typeof report?.commit === 'string' ? report.commit : null
  const commitMatches = Boolean(expectedCommit && sourceCommit === expectedCommit)
  const sourceCheck = sourceRevision(sourceCommit, expectedCommit)
  const entries = new Map((report.platforms || []).map(platform => [platform.platform, platform]))
  const missing = EXPECTED_HOSTS.filter(host => ['android', 'ios', 'harmony'].includes(host) && entries.get(host)?.status !== 'passed')
  const backendFromEvidence = (entry) => {
    if (entry?.rendererBackend) return entry.rendererBackend
    const evidence = (entry?.probes || []).map(probe => `${probe.stdout || ''}\n${probe.stderr || ''}`).join('\n')
    // Accept JSON and line-oriented host logs (`"backend":"..."`,
    // `backend=...`, or `rendererBackend: ...`) so future GPU adapters are
    // audited instead of being collapsed into an unknown value.
    const match = evidence.match(/["']?(?:rendererBackend|backend)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/)
    return match?.[1] || null
  }
  const nonGpuBackend = ['android', 'ios', 'harmony'].filter(host => {
    const backend = backendFromEvidence(entries.get(host))
    return !backend || backend === 'software-fallback' || backend === 'skia-raster' || !backend.startsWith('skia-gpu')
  })
  const nativeSurfaceMissing = ['android', 'ios', 'harmony'].filter(host => entries.get(host)?.nativeSurface !== true)
  // A direct surface probe is stronger than an independent device-context
  // probe: it proves that the container renderer owns the platform surface and
  // submitted a GPU frame. Keep the independent probe in the report for
  // diagnostics, but do not require it when the runtime surface evidence is
  // complete. This matters for ArkUI, where the XComponent EGL context is
  // created inside the app lifecycle and there is no separate probe API.
  const surfaceProbe = Object.fromEntries(['android', 'ios', 'harmony'].map(host => {
    const probe = entries.get(host)?.surfaceProbe
    return [host, probe && typeof probe === 'object'
      ? {
          status: probe.status || 'unknown',
          source: probe.source || null,
          hostSurfaceAttached: probe.hostSurfaceAttached === true,
          containerSurfaceAttached: probe.containerSurfaceAttached === true,
          gpuSurface: probe.gpuSurface === true,
          rendererBackend: probe.rendererBackend || probe.backend || null,
          evidenceBoundary: probe.evidenceBoundary || 'unknown',
        }
      : {
          status: 'missing',
          source: null,
          hostSurfaceAttached: false,
          containerSurfaceAttached: false,
          gpuSurface: false,
          rendererBackend: null,
          evidenceBoundary: 'unknown',
        }]
  }))
  const directSurface = Object.fromEntries(['android', 'ios', 'harmony'].map(host => {
    const probe = surfaceProbe[host]
    return [host, probe.status === 'passed'
      && probe.hostSurfaceAttached
      && probe.containerSurfaceAttached
      && probe.gpuSurface
      && typeof probe.rendererBackend === 'string'
      && probe.rendererBackend.startsWith('skia-gpu')]
  }))
  const gpuProbe = Object.fromEntries(['android', 'ios', 'harmony'].map(host => {
    const probe = entries.get(host)?.gpuProbe
    return [host, probe && typeof probe === 'object'
      ? {
          status: probe.status || 'unknown',
          source: probe.source || null,
          contextCreated: probe.contextCreated === true,
          hardwareAccelerated: probe.hardwareAccelerated === true,
          // A device probe must never be treated as container-surface proof.
          containerSurfaceAttached: probe.containerSurfaceAttached === true,
          evidenceBoundary: probe.evidenceBoundary || 'unknown',
        }
      : {
          status: 'missing',
          source: null,
          contextCreated: false,
          hardwareAccelerated: false,
          containerSurfaceAttached: false,
          evidenceBoundary: 'unknown',
        }]
  }))
  const gpuProbeMissing = ['android', 'ios', 'harmony'].filter(host => {
    const probe = gpuProbe[host]
    return probe.status !== 'passed' || probe.contextCreated !== true
  })
  const gpuProbeSoftware = ['android', 'ios', 'harmony'].filter(host => {
    const probe = gpuProbe[host]
    return probe.status === 'passed' && probe.hardwareAccelerated !== true
  })
  const gpuProbeOverclaims = ['android', 'ios', 'harmony'].filter(host => gpuProbe[host].containerSurfaceAttached)
  const gpuGateMissing = ['android', 'ios', 'harmony'].filter(host => {
    if (directSurface[host]) return false
    const probe = gpuProbe[host]
    return probe.status !== 'passed' || probe.contextCreated !== true
  })
  const gpuGateSoftware = ['android', 'ios', 'harmony'].filter(host => {
    if (directSurface[host]) return false
    const probe = gpuProbe[host]
    return probe.status === 'passed' && probe.hardwareAccelerated !== true
  })
  const blockedReasons = Object.fromEntries(['android', 'ios', 'harmony']
    .map(host => [host, entries.get(host)?.reason || null])
    .filter(([, reason]) => reason))
  const complete = report?.requireAll === true
    && sourceCheck.compatible
    && missing.length === 0
    && nonGpuBackend.length === 0
    && nativeSurfaceMissing.length === 0
    && gpuGateMissing.length === 0
    && gpuGateSoftware.length === 0
    && gpuProbeOverclaims.length === 0
  return status(complete, complete ? 'mobile surface fixture and native GPU renderer evidence passed' : 'mobile surface fixture is blocked, failed, stale or lacks an attached GPU surface', {
    scope: 'mobile-surface-fixture',
    sourceCommit,
    commitMatches,
    sourceRevision: sourceCheck,
    requireAll: report?.requireAll ?? null,
    platforms: Object.fromEntries(['android', 'ios', 'harmony'].map(host => [host, entries.get(host)?.status || 'missing'])),
    rendererBackends: Object.fromEntries(['android', 'ios', 'harmony'].map(host => [host, backendFromEvidence(entries.get(host)) || 'unknown'])),
    nativeSurface: Object.fromEntries(['android', 'ios', 'harmony'].map(host => [host, entries.get(host)?.nativeSurface === true])),
    missing,
    // Keep the historical field for report consumers while making the
    // broader condition explicit: a raster/unknown/backend from another
    // renderer is equally insufficient for a native GPU gate.
    softwareFallback: nonGpuBackend,
    nonGpuBackend,
    nativeSurfaceMissing,
    gpuProbe,
    surfaceProbe,
    directSurface,
    gpuProbeMissing,
    gpuProbeSoftware,
    gpuProbeOverclaims,
    gpuGateMissing,
    gpuGateSoftware,
    blockedReasons,
  })
}

function checkMobileModules(mobileFile, executionFiles, expectedCommit, expectedCompilerCommit) {
  const report = mobileFile.value
  const entries = new Map((report?.platforms || []).map(platform => [platform.platform, platform]))
  // Old reports expose at most one implicit/default engine and cannot bind
  // their first app.init log to a fixture, binary or presented surface. Keep
  // those observations for diagnostics without upgrading them to a pair.
  const legacyPlatforms = Object.fromEntries(MOBILE_EXECUTION_HOSTS.map(host => [
    host, inspectMobileModuleExecution(entries.get(host), report?.expectedEngine || 'quickjs'),
  ]))
  const matrix = inspectPackExecutionMatrix(executionFiles, {
    root: ROOT, expectedCommit, expectedCompilerCommit, hosts: MOBILE_EXECUTION_HOSTS,
  })
  return {
    ...matrix,
    scope: 'mobile-module-execution',
    legacyPlatforms,
  }
}

function checkHostBridge(hostBridgeFile, expectedCommit) {
  if (hostBridgeFile.error) return status(false, hostBridgeFile.error)
  const report = hostBridgeFile.value
  const hostEntries = new Map((report?.hosts || []).map(host => [host.platform, host]))
  const missingHosts = EXPECTED_HOSTS.filter(host => hostEntries.get(host)?.bridgeBatch !== 'passed')
  const commitMatches = Boolean(expectedCommit && report?.commit === expectedCommit)
  const sourceCheck = sourceRevision(report?.commit, expectedCommit)
  const staleCommit = !sourceCheck.compatible
  const bridgePassed = report?.gates?.bridge === 'passed' && report?.status === 'passed'
  const engineProvidersPassed = report?.gates?.engineProviders === 'passed'
  const complete = bridgePassed && engineProvidersPassed && missingHosts.length === 0 && sourceCheck.compatible
  return status(
    complete,
    complete
      ? 'all host bridge batches and dual-engine provider matrices passed'
      : 'host bridge or dual-engine provider evidence is incomplete',
    {
      commit: report?.commit || null,
      commitMatches,
      sourceRevision: sourceCheck,
      staleCommit,
      bridge: report?.gates?.bridge || 'missing',
      engineProviders: report?.gates?.engineProviders || 'missing',
      hosts: Object.fromEntries(EXPECTED_HOSTS.map(host => [host, hostEntries.get(host)?.bridgeBatch || 'missing'])),
      missingHosts,
      // Keep this protocol gate independent from GPU/device evidence.  The
      // bridge report itself must continue to label those surfaces explicitly.
      nativeGpu: report?.gates?.nativeGpu || 'missing',
      performance: report?.gates?.performance || 'missing',
    },
  )
}

function checkPerformance(files, expectedCommit) {
  const validateCompleteReport = (reportPath) => {
    try {
      execFileSync(process.execPath, [
        resolve(ROOT, 'scripts/check-performance-report.mjs'),
        reportPath,
        '--require-complete',
      ], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { status: 'passed', reason: 'performance-report checker accepted the complete report' }
    } catch (error) {
      const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : ''
      const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
      return {
        status: 'failed',
        reason: (stderr || stdout || error?.message || 'performance-report checker rejected the report').slice(-1000),
      }
    }
  }
  const reports = []
  for (const path of files) {
    const file = readJson(path)
    if (file.error) reports.push({ path: file.path, status: 'incomplete', reason: file.error })
    else {
      const report = file.value
      // A report without a verifiable source revision is stale evidence.
      // Only evidence archive/index descendants can reuse the measurement;
      // runtime, build, fixture, tool and gate changes require a fresh run.
      const sourceCheck = sourceRevision(report?.commit, expectedCommit)
      const stale = !sourceCheck.compatible
      // Aggregate release evidence must state an explicit host availability
      // boundary. Missing availability is equivalent to unavailable; legacy
      // reports without this field are diagnostics, never a host pass.
      const unavailable = report?.availability?.status !== 'available'
      // Re-run the canonical report checker for every candidate that claims
      // `passed`.  Aggregation must not trust a hand-written status field or
      // skip metric/threshold/schema validation when selecting release
      // evidence.
      const validation = report?.status === 'passed'
        ? validateCompleteReport(file.path)
        : { status: 'not_run', reason: 'report status is not passed' }
      const statusValue = report?.status === 'passed'
        && report?.evidence?.nativeHost === 'passed'
        && validation.status === 'passed'
        && !stale
        && !unavailable
        ? 'passed'
        : 'incomplete'
      reports.push({
        path: file.path,
        status: statusValue,
        host: report?.host || null,
        engine: report?.engine || null,
        commit: report?.commit || null,
        reportStatus: report?.status || null,
        availability: report?.availability?.status || 'legacy-unspecified',
        staleCommit: stale,
        sourceRevision: sourceCheck,
        validation,
      })
    }
  }
  const completePairs = new Set(reports.filter(item => item.status === 'passed').map(item => `${item.host}/${item.engine}`))
  const expectedPairs = new Set(EXPECTED_HOSTS.flatMap(host => EXPECTED_ENGINES.map(engine => `${host}/${engine}`)))
  const allPairs = reports
    .map(item => `${item.host || '<missing-host>'}/${item.engine || '<missing-engine>'}`)
  const duplicatePairs = [...new Set(allPairs.filter((pair, index) => allPairs.indexOf(pair) !== index))]
  const unexpectedPairs = [...new Set(allPairs.filter(pair => !expectedPairs.has(pair)))]
  const missingPairs = [...expectedPairs].filter(pair => !completePairs.has(pair))
  const complete = files.length === expectedPairs.size
    && missingPairs.length === 0
    && duplicatePairs.length === 0
    && unexpectedPairs.length === 0
  return status(complete, complete ? 'all host/engine performance reports passed' : 'host/engine performance evidence is incomplete', {
    reports,
    missingPairs,
    duplicatePairs,
    unexpectedPairs,
  })
}

function checkLedger(ledgerFile) {
  if (ledgerFile.error) return status(false, ledgerFile.error)
  const entries = Array.isArray(ledgerFile.value?.entries) ? ledgerFile.value.entries : []
  const required = ['id', 'tool', 'version', 'analysisTime', 'scope', 'conclusion', 'limitations']
  const malformed = entries.filter(entry => required.some(key => typeof entry?.[key] !== 'string' || entry[key].length === 0)).map(entry => entry?.id || '<missing-id>')
  const ids = entries.map(entry => entry.id)
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
  const complete = entries.length > 0 && malformed.length === 0 && duplicates.length === 0
  return status(complete, complete ? 'evidence ledger entries are structurally complete' : 'evidence ledger is malformed or empty', { entries: entries.length, malformed, duplicates })
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('Usage: node scripts/check-near-parity-gates.mjs [--index path] [--conformance-report path] [--matrix path] [--mobile path] [--host-bridge path] [--host-execution path ...] [--performance path ...] [--performance-index path] [--ledger path] [--out path]\n')
    return 0
  }
  const commit = currentCommit()
  let compilerCommit = null
  try { compilerCommit = execFileSync('git', ['rev-parse', `${commit}:vendor/weapp-vite`], { cwd: ROOT, encoding: 'utf8' }).trim() } catch { /* Missing pin remains incomplete. */ }
  const mobileDiscovery = discoverMobileReport(commit, options.mobile)
  const hostBridgeDiscovery = discoverHostBridge(commit, options.hostBridge)
  const mobileFile = readJson(mobileDiscovery.selectedPath)
  const hostBridgeFile = readJson(hostBridgeDiscovery.selectedPath)
  // A report can be provided both by discovery and by an explicit path, or
  // twice on the command line. Read a physical input once; independent
  // receipts for the same host/engine still remain a duplicate pair.
  const hostExecutionFiles = [...new Map([mobileFile, hostBridgeFile, ...options.hostExecution.map(readJson)]
    .map(file => [file.path, file])).values()]
  const mobileModuleExecution = checkMobileModules(mobileFile, hostExecutionFiles, commit, compilerCommit)
  const hostModuleExecution = inspectPackExecutionMatrix(hostExecutionFiles, {
    root: ROOT, expectedCommit: commit, expectedCompilerCommit: compilerCommit, hosts: EXECUTION_HOSTS,
  })
  const performanceDiscovery = options.performance.length === 0
    ? discoverPerformanceIndex(commit, options.performanceIndex)
    : {
        selectedIndex: null,
        selectedCommit: null,
        selectedGeneratedAt: null,
        selectedSource: 'explicit-reports',
        currentCommit: commit,
        currentCommitMatch: null,
        candidateIndexes: [],
        performancePaths: options.performance,
        reason: 'performance reports supplied explicitly',
      }
  const performancePaths = performanceDiscovery.performancePaths.length > 0
    ? performanceDiscovery.performancePaths
    : ['artifacts/performance-report.json', 'artifacts/native-performance-report.json']
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root: ROOT,
    commit,
    workingTreeDirty: workingTreeDirty(),
    gates: {
      conformance: inspectConformanceEvidence(readJson(options.index), options.conformanceReport ? readJson(options.conformanceReport) : null, { root: ROOT, expectedCommit: commit }),
      matrix: checkMatrix(readJson(options.matrix)),
      mobile: {
        ...mobileModuleExecution.gpu,
        scope: 'mobile-same-fixture-dual-engine-gpu',
        legacySurface: checkMobile(mobileFile, commit),
      },
      mobileModuleExecution,
      mobilePackGpu: { ...mobileModuleExecution.gpu, scope: 'mobile-same-fixture-dual-engine-gpu' },
      hostModuleExecution: { ...hostModuleExecution, scope: 'seven-host-same-fixture-dual-engine-execution' },
      hostPackGpu: { ...hostModuleExecution.gpu, scope: 'seven-host-same-fixture-dual-engine-gpu' },
      hostBridge: checkHostBridge(hostBridgeFile, commit),
      performance: checkPerformance(performancePaths, commit),
      evidenceLedger: checkLedger(readJson(options.ledger)),
    },
    expectedHosts: EXPECTED_HOSTS,
    expectedEngines: EXPECTED_ENGINES,
    performanceDiscovery,
    mobileDiscovery,
    hostBridgeDiscovery,
    disclaimer: 'A passed aggregate gate is limited to the listed artifacts and fixed baseline; it does not prove unobserved private WeChat behavior.',
  }
  const allPassed = Object.values(report.gates).every(gate => gate.status === 'passed') && report.workingTreeDirty === false
  report.status = allPassed ? 'passed' : 'incomplete'
  report.releaseReady = allPassed
  const output = `${JSON.stringify(report, null, 2)}\n`
  if (options.out) {
    const path = absolute(options.out)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, output, 'utf8')
  }
  process.stdout.write(output)
  if (!allPassed) process.exitCode = 1
}

try { main() } catch (error) {
  process.stderr.write(`${error.message || error}\n`)
  process.exitCode = 1
}
