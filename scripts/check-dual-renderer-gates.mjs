#!/usr/bin/env node
/** Frozen, fail-closed acceptance ledger for the seven-host dual-renderer goal. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BASELINE_COMMIT = 'c7d0dc6f595cd2d2c0ae2f7cd781c56a6cc6dab9'
export const COMPILER_COMMIT = '0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e'
export const HOSTS = ['web', 'macos', 'windows', 'linux', 'android', 'ios', 'harmony']
export const RENDERERS = ['skia', 'webview']
export const STATUSES = ['passed', 'failed', 'blocked', 'unknown']
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SHA = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const MOBILE = new Set(['android', 'ios', 'harmony'])
const GATE_PATH = 'docs/dual-renderer/gates-v1.json'
const SOURCE_POLICY = 'dual-renderer-evidence-descendant-v1'
const MUTABLE_STATUS_DOCUMENTS = new Set([
  'docs/dual-renderer/README.md',
  'docs/dual-renderer/implementation-status.md',
  'docs/dual-renderer/browser-dev-loop.md',
])
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export const COMPONENT_CHECKS = {
  'input-textarea': ['text-editing', 'chinese-ime', 'selection', 'focus', 'keyboard', 'events', 'basic-accessibility'],
  video: ['play-pause', 'seek', 'mute', 'loop', 'fullscreen', 'events', 'release'],
  camera: ['permission', 'preview', 'photo', 'recording', 'background-resume', 'no-device-error'],
  map: ['maplibre', 'offline-style-data', 'gestures', 'markers', 'polylines', 'polygons', 'events', 'explicit-gcj-wgs-conversion'],
  composition: ['size', 'clip', 'transform', 'z-order', 'occlusion', 'hit-testing', 'destroy'],
}

export function runtimeCombinations() {
  return HOSTS.flatMap(host => (host === 'web' ? ['remote', 'browser'] : ['native'])
    .flatMap(runtime => RENDERERS.map(renderer => ({ host, runtime, renderer }))))
}

export function v8Required({ host, runtime }) {
  // Preserve demonstrated engine availability, not a claim that the new
  // renderer already works. Other combinations must report explicit ERR_ENGINE.
  return (host === 'web' && runtime === 'remote') || host === 'macos' || host === 'ios'
}

export function requiredGates() {
  const gates = []
  const add = (id, dimensions, evidenceKind, checks, extra = {}) => {
    gates.push({ id, ...dimensions, evidenceKind, checks, ...extra })
  }
  add('baseline.regressions', {}, 'test', ['frozen-inventory', 'rust-fmt', 'rust-clippy', 'rust-workspace', 'manifest', 'node-regressions', 'submodule-pin', 'six-platform-builds'])
  add('baseline.devtools', {}, 'wechat-devtools', ['fixed-ide-library', 'serial-lease', 'normalized-trace', 'oracle-differential'], { caseScope: 'official-regressions' })
  add('architecture.page-selection', {}, 'test', ['app-default', 'page-override', 'skyline-compat-profile', 'mixed-page-navigation', 'unsupported-renderer-error'])
  add('architecture.session-ownership', {}, 'test', ['one-appservice', 'batch-bridge', 'deadline-cancel', 'atomic-frame-publication', 'hot-reload', 'surface-loss-recovery', 'explicit-software-mode'])
  add('delivery.reproducible', {}, 'build', ['pinned-dependencies', 'submodule-pin', 'private-repository-build', 'embedding-examples', 'default-branch-pushed', 'tag-source-match'])
  for (const dimensions of runtimeCombinations()) {
    for (const engine of ['quickjs', 'v8']) {
      const d = { ...dimensions, engine }
      const prefix = `${d.host}.${d.runtime}.${d.renderer}.${engine}`
      if (engine === 'v8' && !v8Required(d)) {
        add(`${prefix}.engine-availability`, d, 'test', ['explicit-engine-selection', 'no-silent-fallback'], { availabilityContract: true })
        continue
      }
      const execution = d.host === 'web' ? 'actual-browser' : 'actual-native'
      add(`${prefix}.build`, d, 'build', ['locked-build', 'engine-identity', 'renderer-identity'])
      add(`${prefix}.pack-execution`, d, execution, ['real-weapp-vite-pack', 'manifest-integrity', 'module-execution', 'first-presented-frame'])
      add(`${prefix}.conformance`, d, execution, ['wxml-wxss', 'wxs-modern-view', 'component-slot-behavior', 'lifecycle-navigation', 'setData-events', 'error-timeout-cancel'], { caseScope: 'supported-contracts' })
      add(`${prefix}.presentation`, d, execution, ['logical-physical-size', 'density-without-view-reevaluation', 'input-coordinates', 'resize', 'hot-reload', 'stale-frame-rejection', 'resource-release'])
      add(`${prefix}.local-rendering`, d, execution, ['no-per-frame-rgba-transport', 'no-unrequested-cpu-raster-readback', 'batched-scene-commit', 'resource-cache', 'snapshot-on-demand'])
      for (const [component, checks] of Object.entries(COMPONENT_CHECKS)) {
        add(`${prefix}.component.${component}`, d, execution, checks)
      }
      add(`${prefix}.surface`, d, execution, ['native-surface', 'presented-frame-identity', 'context-loss', 'background-resume', 'teardown'], { hardwareRequired: d.renderer === 'skia', physicalDeviceRequired: MOBILE.has(d.host) })
      add(`${prefix}.performance`, d, execution, ['release-build', 'reference-workload', 'independent-input-clock', 'environment-recorded', 'raw-samples'], { performance: true, hardwareRequired: d.renderer === 'skia', physicalDeviceRequired: MOBILE.has(d.host) })
    }
  }
  return gates
}

export function createChecklist() {
  return {
    schemaVersion: 1,
    goal: 'seven-host-dual-renderer',
    baselineCommit: BASELINE_COMMIT,
    gates: requiredGates().map(gate => ({ ...gate, status: 'unknown', reason: 'No evidence for this new acceptance gate has been recorded.', evidence: null })),
  }
}

export function selectBaselinePaths(paths) {
  return paths.filter(path =>
    ['package.json', 'Cargo.toml', 'Cargo.lock', 'docs/api-inventory-v1.json', 'docs/api-inventory-v1.sha256',
      'docs/conformance/baseline-v1.json', 'docs/conformance/case-index-v1.json', 'docs/conformance/case-index-v1.sha256'].includes(path)
    || path.startsWith('scripts/')
    || path.startsWith('.github/workflows/')
    || /^schemas\/(?:conformance|performance)/.test(path)
    || /^tools\/container-manifest\/(?:package.json|test\/[^/]+\.[cm]?[jt]s)$/.test(path)
    || /^crates\/[^/]+\/(?:Cargo.toml|tests\/.*\.rs|src\/.*(?:test|conformance).*\.rs)$/.test(path)
    || /^crates\/[^/]+\/src\/lib.rs$/.test(path)
  ).sort()
}

export function captureBaseline(root = ROOT) {
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 })
  const paths = git(['ls-tree', '-r', '--name-only', BASELINE_COMMIT]).toString().trim().split('\n')
  const files = selectBaselinePaths(paths).map(path => ({ path, sha256: sha256(git(['show', `${BASELINE_COMMIT}:${path}`])) }))
  const index = JSON.parse(git(['show', `${BASELINE_COMMIT}:docs/conformance/case-index-v1.json`]))
  const inventory = JSON.parse(git(['show', `${BASELINE_COMMIT}:docs/api-inventory-v1.json`]))
  const compilerCommit = git(['rev-parse', `${BASELINE_COMMIT}:vendor/weapp-vite`]).toString().trim()
  return {
    schemaVersion: 1, baselineCommit: BASELINE_COMMIT, compilerCommit,
    devtoolsVersion: '2.02.2608080', baseLibraryVersion: '3.17.3',
    sourceCount: index.generatedFrom.fileCount,
    conformanceCaseIds: index.cases.map(item => item.id).sort(),
    // Preserve the complete official inventory, including unresolved cases.
    // Only existing official passes are regression obligations for this goal;
    // the unknown near-parity backlog remains an independent acceptance gate.
    officialCaseBaseline: index.cases.map(({ id, status, source, sourceSha256 }) => ({ id, status, source, sourceSha256 })).sort((a, b) => a.id.localeCompare(b.id)),
    officialRegressionIds: index.cases.filter(item => item.status === 'passed').map(item => item.id).sort(),
    // Includes documented unsupported/error contracts too. A partial API
    // contract means its frozen documented boundary, not all WeChat semantics.
    runtimeContractIds: [...new Set(inventory.apis.flatMap(item => item.conformance ?? []))].sort(),
    apiInventorySha256: sha256(Buffer.from(JSON.stringify(inventory))),
    files,
    engineAvailability: runtimeCombinations().map(d => ({ ...d, quickjs: 'required', v8: v8Required(d) ? 'required' : 'explicit-availability-contract' })),
  }
}

// All paths are protected by default. Evidence is append-only and only these
// three existing explanatory documents may change without new execution.
const evidencePath = path => typeof path === 'string' && path.startsWith('docs/evidence/')
  && path.length > 'docs/evidence/'.length && !path.includes('\\')
  && !path.split('/').some(part => !part || part === '.' || part === '..')
const ordered = entries => [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && same(Object.keys(value).sort(), [...keys].sort())

function sourceGit(root, args, { input } = {}) {
  // Replacement objects cannot rewrite the tested commit's ancestry or tree.
  // Attributes used for checkout proof come only from the immutable tree.
  return execFileSync('git', ['--no-replace-objects', '-c', 'core.attributesFile=/dev/null', ...args], { cwd: root, input, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1' }, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
}

function sourceCommit(root, commit) {
  const grafts = sourceGit(root, ['rev-parse', '--git-path', 'info/grafts']).toString().trim()
  if (existsSync(resolve(root, grafts))) throw new Error('local Git grafts cannot prove source ancestry')
  if (!COMMIT.test(commit ?? '') || sourceGit(root, ['rev-parse', '--verify', `${commit}^{commit}`]).toString().trim() !== commit)
    throw new Error('source binding requires exact existing commit objects')
}

function gateDefinitions(bytes) {
  const checklist = JSON.parse(bytes)
  if (!exactKeys(checklist, ['schemaVersion', 'goal', 'baselineCommit', 'gates']) || !Array.isArray(checklist.gates))
    throw new Error('source gate document shape changed')
  const descriptors = checklist.gates.map(entry => {
    if (!entry || typeof entry !== 'object' || !['status', 'reason', 'evidence'].every(key => Object.hasOwn(entry, key)))
      throw new Error('source gate entry shape changed')
    const { status, reason, evidence, ...descriptor } = entry
    return descriptor
  })
  const definitions = { schemaVersion: checklist.schemaVersion, goal: checklist.goal,
    baselineCommit: checklist.baselineCommit, gates: descriptors }
  if (!same(definitions, { schemaVersion: 1, goal: 'seven-host-dual-renderer', baselineCommit: BASELINE_COMMIT, gates: requiredGates() }))
    throw new Error('frozen source gate definitions/list/order/count changed')
  return definitions
}

function treeEntries(root, commit) {
  const raw = sourceGit(root, ['ls-tree', '-r', '-z', '--full-tree', commit])
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  if (text && !text.endsWith('\0')) throw new Error('incomplete source tree inventory')
  return text.slice(0, -1).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), meta = line.slice(0, tab).split(' '), path = line.slice(tab + 1)
    const [mode, type, objectId] = meta
    if (tab < 0 || meta.length !== 3 || !COMMIT.test(objectId ?? '') || !path || path.includes('\\')
      || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..')
      || !(['100644', '100755', '120000'].includes(mode) && type === 'blob' || mode === '160000' && type === 'commit'))
      throw new Error('unsupported source tree entry')
    return { path, mode, type, objectId }
  })
}

/** Complete immutable Git source identity; no receipt-selected exclude globs. */
export function captureSourceInventory(commit, { root = ROOT } = {}) {
  sourceCommit(root, commit)
  let definitionsSha256
  const entries = ordered(treeEntries(root, commit).flatMap(entry => {
    if (evidencePath(entry.path)) return []
    if (entry.path === GATE_PATH) {
      if (entry.mode !== '100644' || entry.type !== 'blob') throw new Error('source gate file mode/type changed')
      definitionsSha256 = sha256(Buffer.from(JSON.stringify(gateDefinitions(sourceGit(root, ['cat-file', 'blob', entry.objectId])))))
      return [{ path: entry.path, mode: entry.mode, type: entry.type, gateDefinitionsSha256: definitionsSha256 }]
    }
    if (MUTABLE_STATUS_DOCUMENTS.has(entry.path)) {
      if (entry.mode !== '100644' || entry.type !== 'blob') throw new Error('status document mode/type changed')
      return [{ path: entry.path, mode: entry.mode, type: entry.type, content: 'mutable-status-document' }]
    }
    return [entry]
  }))
  if (!definitionsSha256) throw new Error('source gate definition file missing')
  return { schemaVersion: 1, kind: 'dual-renderer-source-inventory', policy: SOURCE_POLICY, sourceCommit: commit,
    pathListSha256: sha256(Buffer.from(JSON.stringify(entries.map(entry => entry.path)))),
    gateDefinitionsSha256: definitionsSha256, entries }
}

function requireAncestor(root, ancestor, descendant) {
  try { sourceGit(root, ['merge-base', '--is-ancestor', ancestor, descendant]) }
  catch { throw new Error('tested source is not a proven ancestor of the delivery commit') }
}

function checkContinuationEdge(root, parent, child) {
  const parts = sourceGit(root, ['diff-tree', '--no-commit-id', '--raw', '-r', '-z', '--no-renames', parent, child])
    .toString('utf8').split('\0')
  if (parts.pop() !== '') throw new Error('incomplete source continuation diff')
  for (let index = 0; index < parts.length; index += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMDT])$/.exec(parts[index])
    const path = parts[index + 1]
    if (!match || !path) throw new Error('unsupported source continuation diff')
    const [, oldMode, newMode, oldId, newId, status] = match
    if (evidencePath(path) && status === 'A' && oldMode === '000000' && newMode === '100644') continue
    if (MUTABLE_STATUS_DOCUMENTS.has(path) && status === 'M' && oldMode === '100644' && newMode === '100644') continue
    if (path === GATE_PATH && status === 'M' && oldMode === '100644' && newMode === '100644') {
      const before = gateDefinitions(sourceGit(root, ['cat-file', 'blob', oldId]))
      const after = gateDefinitions(sourceGit(root, ['cat-file', 'blob', newId]))
      if (same(before, after)) continue
    }
    throw new Error(`source continuation changed protected path: ${path} (${child})`)
  }
}

function checkDirtySource(root) {
  const checkoutCommit = sourceGit(root, ['rev-parse', 'HEAD']).toString().trim()
  sourceCommit(root, checkoutCommit)
  // Git status trusts index flags, stat caches and core.fileMode. Independently
  // compare actual checkout/index bytes before permitting evidence-only edits.
  verifyTrackedCheckout(root, checkoutCommit, true)
  // Content-aware status can execute clean/process filters from new local
  // attributes. Index plus direct bytes already prove every tracked path;
  // only enumerate additional files, without asking Git to hash their content.
  for (const path of untrackedPaths(root)) {
    if (evidencePath(path)) {
      const file = checkedPath(root, path), metadata = lstatSync(file)
      if (!metadata.isFile() || (metadata.mode & 0o111) !== 0) throw new Error('dirty evidence/status file mode/type changed')
      continue
    }
    throw new Error(`dirty protected source or existing evidence: ${path}`)
  }
}

function untrackedPaths(root) {
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(sourceGit(root, ['ls-files', '--others', '--exclude-standard', '-z']))
  const paths = raw.split('\0')
  if (paths.pop() !== '') throw new Error('incomplete untracked source inventory')
  for (const path of paths) {
    checkedPath(root, path)
    if (!path || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid untracked source path')
  }
  return paths
}

function checkoutAttributes(root, commit, entries) {
  const local = sourceGit(root, ['rev-parse', '--git-path', 'info/attributes']).toString().trim()
  if (existsSync(resolve(root, local))) throw new Error('local Git info/attributes cannot prove checkout materialization')
  const paths = entries.filter(entry => ['100644', '100755'].includes(entry.mode)).map(entry => entry.path)
  const result = new Map(paths.map(path => [path, Object.create(null)]))
  if (!paths.length) return result
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(sourceGit(root,
    ['check-attr', `--source=${commit}`, '-z', '--stdin', '--all'], { input: Buffer.from(paths.join('\0') + '\0') }))
  const fields = raw.split('\0')
  if (fields.pop() !== '' || fields.length % 3 !== 0) throw new Error('incomplete immutable checkout attribute proof')
  for (let index = 0; index < fields.length; index += 3) {
    const [path, name, value] = fields.slice(index, index + 3), attributes = result.get(path)
    if (!attributes || !name || Object.hasOwn(attributes, name)) throw new Error('invalid immutable checkout attribute proof')
    attributes[name] = value
  }
  for (const [path, attributes] of result) {
    for (const name of ['filter', 'working-tree-encoding', 'ident']) {
      // --all distinguishes an absent attribute from a literal string value
      // such as filter=unset, which named queries report like boolean -filter.
      // Reject every specified transformation, including explicit disabling.
      if (Object.hasOwn(attributes, name)) throw new Error(`unsupported checkout transformation ${name}: ${path}`)
    }
  }
  return result
}

// Git object identity stays byte-exact. The only differing materialization we
// prove is canonical LF -> CRLF under versioned, explicit `text eol=crlf`.
// Never run clean/smudge filters or normalize arbitrary working-tree bytes.
function canonicalCrlfObjectId(bytes) {
  let endings = 0
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0 || bytes[index] === 10) return undefined
    if (bytes[index] === 13) {
      if (bytes[++index] !== 10) return undefined
      endings++
    }
  }
  if (!endings) return undefined
  const hash = createHash('sha1').update(`blob ${bytes.length - endings}\0`)
  let offset = 0
  for (let index = bytes.indexOf(13); index !== -1; index = bytes.indexOf(13, offset)) {
    hash.update(bytes.subarray(offset, index))
    offset = index + 1
  }
  return hash.update(bytes.subarray(offset)).digest('hex')
}

function verifyTrackedCheckout(root, commit, allowEvidenceChanges, depth = 0, budget = { entries: 200_000, bytes: 1024 ** 3 }) {
  if (process.platform === 'win32') throw new Error('source checkout mode proof unavailable on Windows; validate from a POSIX checkout')
  if (depth > 16) throw new Error('source checkout gitlink depth budget exceeded')
  const tracked = new Map(treeEntries(root, commit).map(entry => [entry.path, entry]))
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(sourceGit(root, ['ls-files', '--stage', '-z']))
  if (raw && !raw.endsWith('\0')) throw new Error('incomplete source index inventory')
  const indexPaths = new Set()
  const records = raw.slice(0, -1).split('\0').filter(Boolean).map(record => {
    const match = /^(100644|100755|120000|160000) ([a-f0-9]{40}) 0\t([\s\S]+)$/.exec(record)
    if (!match || indexPaths.has(match[3]) || --budget.entries < 0) throw new Error('dirty protected source index shape or inventory budget exceeded')
    const [, mode, objectId, path] = match
    // Every index path must also obey the tree path policy, including staged
    // additions that Git status could hide through assume-unchanged flags.
    checkedPath(root, path)
    if (path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('dirty protected source index path')
    indexPaths.add(path)
    return { mode, objectId, path }
  })
  const attributes = checkoutAttributes(root, commit, [...tracked.values(), ...records.filter(entry => !tracked.has(entry.path))])
  const indexed = new Map(), directories = new Set()
  for (const { mode, objectId, path } of records) {
    const before = tracked.get(path)
    const mutable = allowEvidenceChanges && MUTABLE_STATUS_DOCUMENTS.has(path)
    const gate = allowEvidenceChanges && path === GATE_PATH
    const freshEvidence = allowEvidenceChanges && !before && evidencePath(path)
    if (mutable || gate || freshEvidence) {
      if (mode !== '100644' || before && before.mode !== '100644') throw new Error('dirty evidence/status index mode/type changed')
      if (!before && !freshEvidence) throw new Error(`dirty protected source index addition: ${path}`)
      if (gate) gateDefinitions(sourceGit(root, ['cat-file', 'blob', objectId]))
    } else if (!before || before.mode !== mode || before.objectId !== objectId) {
      throw new Error(`dirty protected source or existing evidence index: ${path}`)
    }
    indexed.set(path, { mode, objectId })
    const pathParts = path.split('/')
    for (let index = 1; index < pathParts.length; index++) {
      const directory = pathParts.slice(0, index).join('/')
      if (!directories.has(directory)) {
        if (!lstatSync(checkedPath(root, directory)).isDirectory()) throw new Error('dirty protected source parent is not a directory')
        directories.add(directory)
      }
    }
    const file = checkedPath(root, path)
    let metadata
    try { metadata = lstatSync(file) } catch { throw new Error(`dirty protected source checkout missing: ${path}`) }
    if (mode === '160000') {
      if (!metadata.isDirectory()) throw new Error(`dirty protected source gitlink checkout: ${path}`)
      sourceCommit(file, objectId)
      if (sourceGit(file, ['rev-parse', 'HEAD']).toString().trim() !== objectId) throw new Error(`dirty protected source gitlink pointer: ${path}`)
      verifyTrackedCheckout(file, objectId, false, depth + 1, budget)
      if (untrackedPaths(file).length) throw new Error(`dirty protected source gitlink content: ${path}`)
      continue
    }
    if (mode === '120000' ? !metadata.isSymbolicLink()
      : !metadata.isFile() || ((metadata.mode & 0o111) !== 0) !== (mode === '100755'))
      throw new Error(`dirty protected source checkout mode/type changed: ${path}`)
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || (budget.bytes -= metadata.size) < 0)
      throw new Error('source checkout byte budget exceeded')
    const bytes = mode === '120000' ? readlinkSync(file, { encoding: 'buffer' }) : readFileSync(file)
    if (gate) gateDefinitions(bytes)
    else if (!mutable) {
      const actual = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
      const declared = attributes.get(path)
      if (actual !== objectId && !(declared?.text === 'set' && declared.eol === 'crlf' && canonicalCrlfObjectId(bytes) === objectId))
        throw new Error(`dirty protected source or existing evidence checkout bytes: ${path}`)
    }
  }
  for (const path of tracked.keys()) if (!indexed.has(path)) throw new Error(`dirty protected source index deletion: ${path}`)
}

/** Verify exact sources plus every historical edge, never just ancestry. */
export function inspectSourceBinding(receipt, expectedCommit, { root = ROOT, readArtifact = path => readFileSync(checkedPath(root, path)) } = {}) {
  const binding = receipt.sourceBinding
  if (!exactKeys(binding, ['version', 'inventory', 'pathListSha256', 'gateDefinitionsSha256']) || binding.version !== '1.0'
    || !exactKeys(binding.inventory, ['path', 'sha256']) || !evidencePath(binding.inventory.path ?? '')
    || !SHA.test(binding.inventory.sha256 ?? '') || !SHA.test(binding.pathListSha256 ?? '') || !SHA.test(binding.gateDefinitionsSha256 ?? ''))
    throw new Error('missing or invalid source inventory binding')
  sourceCommit(root, receipt.commit)
  sourceCommit(root, expectedCommit)
  const source = captureSourceInventory(receipt.commit, { root }), current = captureSourceInventory(expectedCommit, { root })
  checkDirtySource(root)
  const bytes = readArtifact(binding.inventory.path)
  if (sha256(bytes) !== binding.inventory.sha256 || !same(JSON.parse(bytes), source)
    || binding.pathListSha256 !== source.pathListSha256 || binding.gateDefinitionsSha256 !== source.gateDefinitionsSha256)
    throw new Error('source inventory/list/definition binding differs from immutable Git source')
  if (!receipt.artifacts?.some(item => item.path === binding.inventory.path && item.sha256 === binding.inventory.sha256))
    throw new Error('source inventory must be retained as a bound raw artifact')
  requireAncestor(root, receipt.commit, expectedCommit)
  const commits = sourceGit(root, ['rev-list', '--topo-order', expectedCommit, `^${receipt.commit}`]).toString().trim().split('\n').filter(Boolean)
  for (const child of commits) {
    const [identity, ...parents] = sourceGit(root, ['rev-list', '--parents', '-n', '1', child]).toString().trim().split(' ')
    if (identity !== child || parents.length === 0) throw new Error('unverifiable source continuation parent set')
    for (const parent of parents) {
      requireAncestor(root, receipt.commit, parent)
      checkContinuationEdge(root, parent, child)
    }
  }
  if (!same(source.entries, current.entries) || source.pathListSha256 !== current.pathListSha256
    || source.gateDefinitionsSha256 !== current.gateDefinitionsSha256)
    throw new Error('delivery execution sources differ from tested source inventory')
  return { sourceCommit: receipt.commit, deliveryCommit: expectedCommit, policy: SOURCE_POLICY,
    pathListSha256: source.pathListSha256, gateDefinitionsSha256: source.gateDefinitionsSha256, inspectedCommitCount: commits.length }
}

function checkedPath(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\')) throw new Error('artifact path must be repository-relative')
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('artifact path escapes repository')
  return absolute
}

function inspectPerformance(receipt, gate, fail) {
  const metrics = receipt.metrics ?? {}
  const mobile = MOBILE.has(gate.host)
  const limits = {
    firstFrameP50Ms: mobile ? 900 : 500, firstFrameP95Ms: 1500,
    setData10kP95Ms: 8, bridgeP99Ms: mobile ? 5 : 2,
    scrollDroppedFrameRate: 0.01, steadyStateMemoryMiB: mobile ? 120 : 150,
  }
  if (gate.engine === 'quickjs') limits.runtimeIncrementMiB = 8
  if (gate.host === 'web') limits.inputToPresentP95Ms = 50
  for (const [name, maximum] of Object.entries(limits)) {
    if (!Number.isFinite(metrics[name]) || metrics[name] < 0 || metrics[name] > maximum) fail(`performance ${name} must be measured and <= ${maximum}`)
  }
  if (gate.engine === 'v8' && (!Number.isFinite(metrics.runtimeIncrementMiB) || metrics.runtimeIncrementMiB < 0
    || !Number.isFinite(receipt.v8PackageBudgetMiB) || receipt.v8PackageBudgetMiB <= 0 || metrics.runtimeIncrementMiB > receipt.v8PackageBudgetMiB)) fail('V8 platform package budget must be recorded and met')
  if (!Number.isFinite(metrics.coldStartP50Ms) || metrics.coldStartP50Ms < 0 || !Number.isFinite(metrics.hotStartP50Ms) || metrics.hotStartP50Ms < 0) fail('cold/hot startup must be measured')
  if (!Number.isFinite(metrics.observedInputHz) || metrics.observedInputHz < 57 || metrics.observedInputHz > 63) fail('scroll input must actually run at 57–63 Hz')
  if (!Number.isInteger(receipt.samples) || receipt.samples < 20) fail('performance requires at least 20 samples')
  if (!same(receipt.workload, { nodes: 1000, setDataEntries: 10000, scrollItems: 1000, networkRequests: 20 })) fail('reference workload differs from frozen acceptance workload')
  if (gate.host === 'web' && !same(receipt.presentation, { logicalWidth: 375, logicalHeight: 667, renderScale: 2 })) fail('Web performance requires 375×667 at 2×')
}

/** Validate claims and their byte/source bindings; this does not execute a host. */
export function inspectChecklist(checklist, baseline, { expectedCommit, repositoryRoot = ROOT, verifyCheckout = false,
  readArtifact = path => readFileSync(checkedPath(repositoryRoot, path)) } = {}) {
  const errors = []
  const sourceBindings = []
  const fail = message => errors.push(message)
  if (!COMMIT.test(expectedCommit ?? '')) fail('expectedCommit must be an exact Git commit')
  if (verifyCheckout) {
    try { captureSourceInventory(expectedCommit, { root: repositoryRoot }); checkDirtySource(repositoryRoot) }
    catch (error) { fail(`source checkout/inventory proof failed: ${error.message}`) }
  }
  if (baseline?.baselineCommit !== BASELINE_COMMIT || baseline?.compilerCommit !== COMPILER_COMMIT) fail('frozen baseline/compiler commit mismatch')
  if (checklist?.schemaVersion !== 1 || checklist?.goal !== 'seven-host-dual-renderer' || checklist?.baselineCommit !== BASELINE_COMMIT) fail('checklist identity mismatch')
  const required = requiredGates()
  const entries = Array.isArray(checklist?.gates) ? checklist.gates : []
  if (!same(entries.map(entry => {
    if (!entry || typeof entry !== 'object') return entry
    const { status, reason, evidence, ...descriptor } = entry
    return descriptor
  }), required)) fail('required gate list/order/count changed')
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry?.id)) fail(`duplicate gate: ${entry?.id}`)
    seen.add(entry?.id)
  }
  const wanted = new Set(required.map(gate => gate.id))
  for (const entry of entries) if (!wanted.has(entry?.id)) fail(`unexpected gate: ${entry?.id}`)
  const counts = Object.fromEntries(STATUSES.map(status => [status, 0]))
  for (const gate of required) {
    const entry = entries.find(item => item?.id === gate.id)
    const bad = message => fail(`${gate.id}: ${message}`)
    if (!entry) { bad('required gate missing'); continue }
    const { status, reason, evidence, ...descriptor } = entry
    if (!same(descriptor, gate)) bad('required gate definition changed')
    if (!STATUSES.includes(status)) bad('invalid status')
    else counts[status] += 1
    if (status !== 'passed' && (typeof reason !== 'string' || !reason.trim())) bad('non-passed gate requires a reason')
    if (!evidence) {
      if (status === 'passed') bad('passed gate requires bound evidence')
      continue
    }
    try {
      if (!SHA.test(evidence.sha256 ?? '')) throw new Error('invalid receipt SHA-256')
      const bytes = readArtifact(evidence.path)
      if (sha256(bytes) !== evidence.sha256) throw new Error('receipt SHA-256 mismatch')
      const receipt = JSON.parse(bytes)
      if (receipt.schemaVersion !== 1 || receipt.gateId !== gate.id || receipt.status !== status) bad('receipt identity/status mismatch')
      if (status !== 'passed') continue // Retain old failures without crediting them.
      if (receipt.commit !== expectedCommit || receipt.sourceBinding !== undefined) {
        try { sourceBindings.push({ gateId: gate.id, ...inspectSourceBinding(receipt, expectedCommit, { root: repositoryRoot, readArtifact }) }) }
        catch (error) { bad(`stale source commit: ${error.message}`) }
      }
      if (receipt.baselineCommit !== BASELINE_COMMIT || receipt.compilerCommit !== COMPILER_COMMIT) bad('receipt baseline/compiler mismatch')
      if (receipt.evidenceKind !== gate.evidenceKind) bad('wrong evidence boundary')
      for (const key of ['host', 'runtime', 'renderer', 'engine']) if (gate[key] && receipt[key] !== gate[key]) bad(`${key} mismatch`)
      if (receipt.executionStatus !== 'passed' || receipt.availability !== 'available') bad('blocked/unavailable execution cannot be passed')
      if (!Array.isArray(receipt.checks) || gate.checks.some(id => !receipt.checks.some(check => check.id === id && check.status === 'passed'))
        || receipt.checks.some(check => check.status !== 'passed')) bad('required checks are not all passed')
      if (typeof receipt.environment?.os !== 'string' || !receipt.environment.os || typeof receipt.environment?.device !== 'string' || !receipt.environment.device) bad('environment identity missing')
      if (['actual-native', 'actual-browser', 'wechat-devtools'].includes(gate.evidenceKind) && receipt.observedExecution !== true) bad('actual execution observation missing')
      if (gate.hardwareRequired && (receipt.hardwareAccelerated !== true || receipt.softwareFallback !== false)) bad('hardware GPU evidence required')
      if (gate.physicalDeviceRequired && receipt.deviceClass !== 'physical') bad('physical device evidence required')
      if (gate.availabilityContract) {
        if (!['available', 'unavailable'].includes(receipt.engineAvailability)) bad('engine availability observation missing')
        if (receipt.engineAvailability === 'unavailable' && receipt.errorCode !== 'ERR_ENGINE') bad('unavailable engine must fail with ERR_ENGINE')
        if (receipt.engineAvailability === 'available' && receipt.engineExecuted !== 'v8') bad('available V8 must execute V8')
      }
      if (gate.caseScope) {
        const cases = Array.isArray(receipt.caseResults) ? receipt.caseResults : []
        const ids = cases.map(item => item.id).sort()
        const requiredIds = gate.caseScope === 'official-regressions' ? baseline.officialRegressionIds : baseline.runtimeContractIds
        if (!same(ids, requiredIds) || cases.some(item => item.status !== 'passed')) bad('frozen conformance case coverage incomplete')
        if (gate.caseScope === 'official-regressions') {
          // Every unresolved official case stays visible with its provenance;
          // don't relabel it passed merely because an auxiliary host agrees.
          if (!same(receipt.officialCaseBaseline, baseline.officialCaseBaseline)) bad('official baseline status/provenance changed')
        }
      }
      if (gate.performance) inspectPerformance(receipt, gate, bad)
      if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) bad('raw evidence artifacts missing')
      else for (const artifact of receipt.artifacts) {
        if (!SHA.test(artifact.sha256 ?? '')) throw new Error('invalid artifact SHA-256')
        const raw = readArtifact(artifact.path)
        if (raw.byteLength === 0 || sha256(raw) !== artifact.sha256) throw new Error(`artifact SHA-256 mismatch or empty artifact: ${artifact.path}`)
      }
    } catch (error) { bad(error.message) }
  }
  const valid = errors.length === 0
  return { schemaVersion: 1, baselineCommit: BASELINE_COMMIT, expectedCommit, valid, releaseReady: valid && counts.passed === required.length,
    status: !valid ? 'invalid' : counts.passed === required.length ? 'passed' : 'incomplete', requiredGateCount: required.length, counts, sourceBindings, errors }
}

export function main(argv = process.argv.slice(2)) {
  let checklistPath = 'docs/dual-renderer/gates-v1.json'
  let baselinePath = 'docs/dual-renderer/baseline-v1.json'
  let expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  let validateOnly = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--checklist') checklistPath = argv[++i]
    else if (argv[i] === '--baseline') baselinePath = argv[++i]
    else if (argv[i] === '--expected-commit') expectedCommit = argv[++i]
    else if (argv[i] === '--validate-only') validateOnly = true
    else if (argv[i] === '--help') {
      process.stdout.write('Usage: node scripts/check-dual-renderer-gates.mjs [--checklist path] [--baseline path] [--expected-commit SHA] [--validate-only]\nDefault exits nonzero until all gates pass. --validate-only checks ledger integrity and never grants release readiness.\n')
      return 0
    } else throw new Error(`unknown option: ${argv[i]}`)
  }
  if (!COMMIT.test(expectedCommit)) throw new Error('expected commit must be an exact 40-character SHA')
  sourceCommit(ROOT, expectedCommit)
  const baseline = JSON.parse(readFileSync(resolve(ROOT, baselinePath)))
  const frozen = captureBaseline()
  if (!same(baseline, frozen)) throw new Error('frozen baseline inventory differs from immutable Git objects')
  const checklist = JSON.parse(readFileSync(resolve(ROOT, checklistPath)))
  // The CLI always checks real immutable Git trees and current checkout/index,
  // including all-unknown ledgers, legacy receipts and an explicit old SHA.
  // inspectChecklist's pure default remains a seam for synthetic schema tests.
  const result = inspectChecklist(checklist, baseline, { expectedCommit, verifyCheckout: true })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return (validateOnly ? result.valid : result.releaseReady) ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main() } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
