import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  BASELINE_COMMIT, COMPILER_COMMIT, captureSourceInventory, createChecklist,
  inspectChecklist, inspectSourceBinding, sha256,
} from './check-dual-renderer-gates.mjs'

const GATES = 'docs/dual-renderer/gates-v1.json'
const STATUS = 'docs/dual-renderer/implementation-status.md'
const INVENTORY = 'docs/evidence/source-bound/source-inventory.json'
const RAW = 'docs/evidence/source-bound/browser.json'
const RECEIPT = 'docs/evidence/source-bound/pack-receipt.json'
const baseline = JSON.parse(readFileSync(new URL('../docs/dual-renderer/baseline-v1.json', import.meta.url)))

function fixture(t, { withGitlink = false, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dual-renderer-git-source-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (path, data) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), data) }
  const json = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n')
  const commit = message => { git('add', '-A', '--'); git('commit', '-qm', message); return git('rev-parse', 'HEAD') }
  git('init', '-q', '--initial-branch=main')
  git('config', 'user.name', 'Source Binding Fixture')
  git('config', 'user.email', 'source-binding@example.invalid')
  git('config', 'core.filemode', 'true')
  write('runtime.js', 'export const version = 1\n')
  write('Cargo.lock', 'frozen lock input\n')
  write('scripts/check-dual-renderer-gates.mjs', 'frozen checker input\n')
  write('schemas/container.json', '{"frozen":true}\n')
  write('.github/workflows/ci.yml', 'name: frozen workflow\n')
  write('docs/evidence/prior/raw.json', '{"historical":true}\n')
  write('docs/dual-renderer/README.md', 'frozen status explanation\n')
  write(STATUS, 'frozen implementation status\n')
  write('docs/dual-renderer/browser-dev-loop.md', 'frozen development explanation\n')
  json(GATES, createChecklist())
  for (const [path, bytes] of Object.entries(files)) write(path, bytes)
  let nested
  if (withGitlink) {
    const nestedRoot = join(root, 'vendor/dep')
    mkdirSync(nestedRoot, { recursive: true })
    nested = (...args) => execFileSync('git', args, { cwd: nestedRoot, encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    nested('init', '-q', '--initial-branch=main')
    nested('config', 'user.name', 'Nested Fixture'); nested('config', 'user.email', 'nested@example.invalid')
    nested('config', 'core.filemode', 'true')
    write('vendor/dep/nested.js', 'export const nested = 1\n')
    nested('add', '-A'); nested('commit', '-qm', 'fixed dependency')
  }
  const source = commit('measured source')
  const readArtifact = path => readFileSync(join(root, path))
  const bind = () => {
    const inventory = captureSourceInventory(source, { root })
    const bytes = Buffer.from(JSON.stringify(inventory) + '\n')
    write(INVENTORY, bytes)
    write(RAW, '{"kind":"controlled-test-artifact-not-browser-evidence"}\n')
    const gate = createChecklist().gates.find(item => item.id === 'web.browser.skia.quickjs.pack-execution')
    const receipt = {
      schemaVersion: 1, gateId: gate.id, status: 'passed', commit: source,
      baselineCommit: BASELINE_COMMIT, compilerCommit: COMPILER_COMMIT,
      evidenceKind: gate.evidenceKind, host: gate.host, runtime: gate.runtime,
      renderer: gate.renderer, engine: gate.engine, executionStatus: 'passed',
      availability: 'available', observedExecution: true,
      checks: gate.checks.map(id => ({ id, status: 'passed' })),
      environment: { os: 'controlled-git-fixture', device: 'not-an-execution-claim' },
      sourceBinding: { version: '1.0', inventory: { path: INVENTORY, sha256: sha256(bytes) },
        pathListSha256: inventory.pathListSha256, gateDefinitionsSha256: inventory.gateDefinitionsSha256 },
      artifacts: [{ path: INVENTORY, sha256: sha256(bytes) }, { path: RAW, sha256: sha256(readArtifact(RAW)) }],
    }
    return receipt
  }
  const inspect = (receipt, current = git('rev-parse', 'HEAD')) => inspectSourceBinding(receipt, current, { root, readArtifact })
  const publish = receipt => {
    json(RECEIPT, receipt)
    const checklist = createChecklist(), entry = checklist.gates.find(item => item.id === receipt.gateId)
    entry.status = 'passed'; entry.reason = ''
    entry.evidence = { path: RECEIPT, sha256: sha256(readArtifact(RECEIPT)) }
    json(GATES, checklist)
    return checklist
  }
  return { root, source, git, nested, write, json, commit, readArtifact, bind, inspect, publish }
}

test('exact-source receipts retain the original behavior without a new binding', t => {
  const f = fixture(t), receipt = f.bind()
  delete receipt.sourceBinding
  const checklist = f.publish(receipt)
  const result = inspectChecklist(checklist, baseline, { expectedCommit: f.source, repositoryRoot: f.root, readArtifact: f.readArtifact, verifyCheckout: true })
  assert.equal(result.valid, true)
  assert.equal(result.counts.passed, 1)
  assert.deepEqual(result.sourceBindings, [])
})

test('one committed evidence receipt persists against default delivery HEAD with exact sources', t => {
  const f = fixture(t), receipt = f.bind(), checklist = f.publish(receipt)
  const delivery = f.commit('archive one controlled receipt')
  const result = inspectChecklist(checklist, baseline, { expectedCommit: delivery, repositoryRoot: f.root, readArtifact: f.readArtifact })
  assert.equal(result.valid, true, result.errors.join('\n'))
  assert.equal(result.counts.passed, 1)
  assert.equal(result.counts.unknown, 278)
  assert.equal(result.releaseReady, false)
  assert.equal(result.sourceBindings[0].sourceCommit, f.source)
  assert.equal(result.sourceBindings[0].deliveryCommit, delivery)
  assert.equal(result.sourceBindings[0].inspectedCommitCount, 1)
})

test('multiple append-only evidence and precisely allowed explanation commits remain bound', t => {
  const f = fixture(t), receipt = f.bind()
  f.commit('retain new inventory and raw artifact')
  for (const path of ['docs/dual-renderer/README.md', STATUS, 'docs/dual-renderer/browser-dev-loop.md']) {
    f.write(path, 'updated explanation only\n')
    f.commit('update one allowed status explanation')
  }
  f.write('docs/evidence/another/new.log', 'new historical record\n')
  const delivery = f.commit('append new evidence')
  assert.equal(f.inspect(receipt, delivery).inspectedCommitCount, 5)
})

test('every parent of a documentation-only merge is inspected', t => {
  const f = fixture(t), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  f.git('checkout', '-qb', 'left')
  f.write(STATUS, 'left status explanation\n'); f.commit('left documentation')
  f.git('checkout', '-q', 'main')
  f.write('docs/dual-renderer/browser-dev-loop.md', 'right explanation\n'); f.commit('right documentation')
  f.git('merge', '--no-ff', '-qm', 'merge documentation parents', 'left')
  assert.equal(f.inspect(receipt).inspectedCommitCount, 4)
})

test('an implementation edit followed by an exact revert is still rejected', t => {
  const f = fixture(t), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  f.write('runtime.js', 'export const version = 2\n'); f.commit('implementation change')
  f.write('runtime.js', 'export const version = 1\n'); f.commit('restore original bytes')
  assert.deepEqual(captureSourceInventory(f.source, { root: f.root }).entries,
    captureSourceInventory(f.git('rev-parse', 'HEAD'), { root: f.root }).entries)
  assert.throws(() => f.inspect(receipt), /changed protected path: runtime.js/)
})

test('a merge cannot hide a protected edit and revert on its side branch', t => {
  const f = fixture(t), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  f.git('checkout', '-qb', 'side')
  f.write('runtime.js', 'changed on side\n'); f.commit('side implementation edit')
  f.write('runtime.js', 'export const version = 1\n'); f.commit('side implementation revert')
  f.git('checkout', '-q', 'main')
  f.write(STATUS, 'main documentation\n'); f.commit('main documentation')
  f.git('merge', '--no-ff', '-qm', 'merge reverted implementation side', 'side')
  assert.throws(() => f.inspect(receipt), /changed protected path: runtime.js/)
})

for (const [name, mutate] of [
  ['runtime edit', f => f.write('runtime.js', 'changed execution\n')],
  ['new build source', f => f.write('build.rs', 'fn main() {}\n')],
  ['deleted source', f => rmSync(join(f.root, 'runtime.js'))],
  ['source executable mode', f => chmodSync(join(f.root, 'runtime.js'), 0o755)],
  ['source symlink', f => { rmSync(join(f.root, 'runtime.js')); symlinkSync('Cargo.lock', join(f.root, 'runtime.js')) }],
  ['lockfile', f => f.write('Cargo.lock', 'changed lock\n')],
  ['CI workflow', f => f.write('.github/workflows/ci.yml', 'changed workflow\n')],
  ['schema', f => f.write('schemas/container.json', '{}\n')],
  ['checker policy source', f => f.write('scripts/check-dual-renderer-gates.mjs', 'weakened checker\n')],
  ['unclassified path', f => f.write('unclassified.txt', 'protected by default\n')],
  ['unlisted documentation', f => f.write('docs/other.md', 'not an allowed status document\n')],
  ['root README', f => f.write('README.md', 'not in the three-document allowance\n')],
  ['status document deletion', f => rmSync(join(f.root, STATUS))],
  ['status document mode', f => chmodSync(join(f.root, STATUS), 0o755)],
  ['historical raw modification', f => f.write('docs/evidence/prior/raw.json', '{"rewritten":true}\n')],
  ['historical raw deletion', f => rmSync(join(f.root, 'docs/evidence/prior/raw.json'))],
  ['new executable evidence', f => { f.write('docs/evidence/new/tool.sh', 'exit 0\n'); chmodSync(join(f.root, 'docs/evidence/new/tool.sh'), 0o755) }],
  ['new symlink evidence', f => symlinkSync('../../Cargo.lock', join(f.root, 'docs/evidence/new-link'))],
]) {
  test(`source continuation rejects ${name}`, t => {
    const f = fixture(t), receipt = f.bind()
    f.commit('retain controlled raw artifact')
    mutate(f); f.commit(`mutate ${name}`)
    assert.throws(() => f.inspect(receipt), /protected path|mode\/type changed/)
  })
}

test('a gitlink pointer is protected even when no vendored file is read', t => {
  const f = fixture(t), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  mkdirSync(join(f.root, 'vendor/dep'), { recursive: true })
  f.git('update-index', '--add', '--cacheinfo', `160000,${f.source},vendor/dep`)
  f.git('commit', '-qm', 'add unapproved gitlink')
  const inventory = captureSourceInventory(f.git('rev-parse', 'HEAD'), { root: f.root })
  assert.deepEqual(inventory.entries.find(item => item.path === 'vendor/dep'),
    { path: 'vendor/dep', mode: '160000', type: 'commit', objectId: f.source })
  assert.throws(() => f.inspect(receipt), /protected path|dirty protected source/)
})

for (const [name, mutate] of [
  ['check list', gates => { gates.gates[0].checks.pop() }],
  ['gate order', gates => { [gates.gates[0], gates.gates[1]] = [gates.gates[1], gates.gates[0]] }],
  ['gate count', gates => { gates.gates.pop() }],
  ['gate evidence kind', gates => { gates.gates[0].evidenceKind = 'mock' }],
  ['baseline identity', gates => { gates.baselineCommit = '0'.repeat(40) }],
]) {
  test(`gate state allowance rejects changed frozen ${name}`, t => {
    const f = fixture(t), receipt = f.bind()
    f.commit('retain controlled raw artifact')
    const gates = createChecklist(); mutate(gates); f.json(GATES, gates); f.commit('change frozen definitions')
    assert.throws(() => f.inspect(receipt), /gate definitions\/list\/order\/count changed/)
  })
}

test('a missing source inventory is not replaced by ancestry alone', t => {
  const f = fixture(t), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  delete receipt.sourceBinding
  assert.throws(() => f.inspect(receipt), /missing or invalid source inventory binding/)
})

for (const [name, mutate] of [
  ['raw artifact hash', (f, r) => { r.sourceBinding.inventory.sha256 = '0'.repeat(64) }],
  ['path-list self claim', (f, r) => { r.sourceBinding.pathListSha256 = '0'.repeat(64) }],
  ['definition self claim', (f, r) => { r.sourceBinding.gateDefinitionsSha256 = '0'.repeat(64) }],
  ['receipt-selected exclusions', (f, r) => { r.sourceBinding.excludedPaths = ['runtime.js'] }],
  ['noncanonical inventory path', (f, r) => { r.sourceBinding.inventory.path = 'docs/evidence/../source-inventory.json' }],
  ['inventory not in raw artifact list', (f, r) => { r.artifacts = r.artifacts.filter(item => item.path !== INVENTORY) }],
  ['missing entry with recomputed self hashes', (f, r) => {
    const inventory = JSON.parse(f.readArtifact(INVENTORY)); inventory.entries = inventory.entries.filter(item => item.path !== 'runtime.js')
    inventory.pathListSha256 = sha256(Buffer.from(JSON.stringify(inventory.entries.map(item => item.path))))
    const bytes = Buffer.from(JSON.stringify(inventory) + '\n'); f.write(INVENTORY, bytes)
    r.sourceBinding.inventory.sha256 = sha256(bytes); r.sourceBinding.pathListSha256 = inventory.pathListSha256
    r.artifacts.find(item => item.path === INVENTORY).sha256 = sha256(bytes)
  }],
  ['blob OID with recomputed artifact hash', (f, r) => {
    const inventory = JSON.parse(f.readArtifact(INVENTORY)); inventory.entries.find(item => item.path === 'runtime.js').objectId = '0'.repeat(40)
    const bytes = Buffer.from(JSON.stringify(inventory) + '\n'); f.write(INVENTORY, bytes)
    r.sourceBinding.inventory.sha256 = sha256(bytes); r.artifacts.find(item => item.path === INVENTORY).sha256 = sha256(bytes)
  }],
]) {
  test(`independent Git reconstruction rejects ${name}`, t => {
    const f = fixture(t), receipt = f.bind()
    mutate(f, receipt)
    f.commit('retain candidate controlled artifacts')
    assert.throws(() => f.inspect(receipt), /binding|bound raw artifact/)
  })
}

test('a supplied binding is checked even at the exact source commit', t => {
  const f = fixture(t), receipt = f.bind()
  receipt.sourceBinding.pathListSha256 = '0'.repeat(64)
  assert.throws(() => f.inspect(receipt, f.source), /binding differs/)
})

test('source identity cannot be relabelled to a newer evidence commit', t => {
  const f = fixture(t), receipt = f.bind(), delivery = f.commit('retain controlled raw artifact')
  receipt.commit = delivery
  assert.throws(() => f.inspect(receipt, delivery), /binding differs/)
})

test('matching execution trees on unrelated history are not accepted', t => {
  const f = fixture(t), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  f.git('checkout', '--orphan', 'unrelated')
  const unrelated = f.commit('unrelated root with the same files')
  assert.throws(() => f.inspect(receipt, unrelated), /not a proven ancestor/)
})

test('local graft metadata cannot rewrite the ancestry proof', t => {
  const f = fixture(t), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  f.write('.git/info/grafts', `${f.source}\n`)
  assert.throws(() => f.inspect(receipt), /local Git grafts/)
})

for (const [name, mutate] of [
  ['tracked execution change', f => f.write('runtime.js', 'dirty execution\n')],
  ['untracked execution input', f => f.write('new-build-input.js', 'untracked execution\n')],
  ['existing raw rewrite', f => f.write('docs/evidence/prior/raw.json', 'dirty historical bytes\n')],
  ['dirty evidence symlink', f => symlinkSync('../../Cargo.lock', join(f.root, 'docs/evidence/dirty-link'))],
  ['dirty status executable mode', f => chmodSync(join(f.root, STATUS), 0o755)],
  ['dirty frozen gate descriptor', f => { const gates = createChecklist(); gates.gates[0].checks.pop(); f.json(GATES, gates) }],
]) {
  test(`default delivery HEAD rejects ${name}`, t => {
    const f = fixture(t), receipt = f.bind()
    f.commit('retain controlled raw artifact')
    mutate(f)
    assert.throws(() => f.inspect(receipt), /dirty|gate definitions\/list\/order\/count changed/)
  })
}

test('pending new regular evidence and status prose are allowed before their archive commit', t => {
  const f = fixture(t), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  f.write('docs/evidence/followup/new.json', '{"new":true}\n')
  f.write(STATUS, 'new prose before commit\n')
  const gates = createChecklist(); gates.gates[1].reason = 'still unknown'; f.json(GATES, gates)
  assert.equal(f.inspect(receipt).inspectedCommitCount, 1)
})

test('an index-only frozen gate change is rejected even with restored working bytes', t => {
  const f = fixture(t), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  const original = f.readArtifact(GATES), gates = createChecklist()
  gates.gates[0].checks.pop(); f.json(GATES, gates); f.git('add', '--', GATES)
  f.write(GATES, original)
  assert.throws(() => f.inspect(receipt), /gate definitions\/list\/order\/count changed/)
})

for (const path of [STATUS, 'docs/evidence/new-staged.log']) {
  test(`a concealed staged executable mode is rejected for ${path}`, t => {
    const f = fixture(t), receipt = f.bind()
    f.commit('retain controlled raw artifact')
    f.write(path, 'candidate archive bytes\n'); chmodSync(join(f.root, path), 0o755)
    f.git('add', '--', path); chmodSync(join(f.root, path), 0o644)
    assert.throws(() => f.inspect(receipt), /dirty/)
  })
}

test('staged regular evidence and status-only gate edits remain valid', t => {
  const f = fixture(t), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  f.write('docs/evidence/new-staged.log', 'candidate evidence\n')
  f.write(STATUS, 'candidate explanation\n')
  const gates = createChecklist(); gates.gates[0].reason = 'unchanged unknown state'; f.json(GATES, gates)
  f.git('add', '--', 'docs/evidence/new-staged.log', STATUS, GATES)
  assert.equal(f.inspect(receipt).inspectedCommitCount, 1)
})

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test(`actual checkout bytes remain protected under ${flag}`, t => {
    const f = fixture(t), receipt = f.bind()
    f.commit('retain controlled raw artifact')
    f.git('update-index', flag, '--', 'runtime.js')
    f.write('runtime.js', 'hidden execution change\n')
    assert.equal(f.git('status', '--porcelain'), '', 'fixture must reproduce an invisible status change')
    assert.throws(() => f.inspect(receipt), /dirty protected source.*checkout bytes/)
  })
}

test('core.fileMode=false cannot hide a protected executable bit change', t => {
  const f = fixture(t), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  f.git('config', 'core.filemode', 'false')
  chmodSync(join(f.root, 'runtime.js'), 0o755)
  assert.equal(f.git('status', '--porcelain'), '', 'fixture must reproduce a hidden mode change')
  assert.throws(() => f.inspect(receipt), /dirty protected source checkout mode\/type/)
})

test('legacy exact-source receipts also reject hidden dirty checkout bytes without requiring a new binding', t => {
  const f = fixture(t), receipt = f.bind()
  delete receipt.sourceBinding
  const checklist = f.publish(receipt)
  f.git('update-index', '--assume-unchanged', '--', 'runtime.js')
  f.write('runtime.js', 'hidden exact-source execution change\n')
  const result = inspectChecklist(checklist, baseline, { expectedCommit: f.source, repositoryRoot: f.root, readArtifact: f.readArtifact, verifyCheckout: true })
  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /dirty protected source.*checkout bytes/)
})

test('an explicit historical expected commit does not bypass actual HEAD checkout validation', t => {
  const f = fixture(t), receipt = f.bind()
  delete receipt.sourceBinding
  const checklist = f.publish(receipt)
  f.commit('archive legacy exact-source evidence')
  f.git('update-index', '--skip-worktree', '--', 'runtime.js')
  f.write('runtime.js', 'hidden bytes after an old expected revision\n')
  const result = inspectChecklist(checklist, baseline, { expectedCommit: f.source, repositoryRoot: f.root,
    readArtifact: f.readArtifact, verifyCheckout: true })
  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /dirty protected source.*checkout bytes/)
})

test('all-unknown ledgers still validate actual checkout bytes on the CLI verification path', t => {
  const f = fixture(t)
  f.git('update-index', '--assume-unchanged', '--', 'runtime.js')
  f.write('runtime.js', 'hidden bytes without any passed receipt\n')
  const result = inspectChecklist(createChecklist(), baseline, { expectedCommit: f.source,
    repositoryRoot: f.root, readArtifact: f.readArtifact, verifyCheckout: true })
  assert.equal(result.valid, false)
  assert.equal(result.counts.unknown, 279)
  assert.match(result.errors.join('\n'), /dirty protected source.*checkout bytes/)
})

test('a separately supplied checklist cannot reorder the frozen gate descriptors', t => {
  const f = fixture(t), checklist = createChecklist()
  ;[checklist.gates[0], checklist.gates[1]] = [checklist.gates[1], checklist.gates[0]]
  const result = inspectChecklist(checklist, baseline, { expectedCommit: f.source })
  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /gate list\/order\/count changed/)
})

test('an unchanged initialized gitlink checkout remains verifiable', t => {
  const f = fixture(t, { withGitlink: true }), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  assert.equal(f.inspect(receipt).inspectedCommitCount, 1)
})

test('gitlink checkout pointer changes cannot be hidden by submodule ignore configuration', t => {
  const f = fixture(t, { withGitlink: true }), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  f.write('vendor/dep/nested.js', 'new nested execution\n')
  f.nested('add', '-A'); f.nested('commit', '-qm', 'unmeasured nested source')
  f.git('config', 'diff.ignoreSubmodules', 'all')
  assert.throws(() => f.inspect(receipt), /dirty protected source gitlink pointer/)
})

test('hidden dirty bytes inside a fixed gitlink checkout are checked recursively', t => {
  const f = fixture(t, { withGitlink: true }), receipt = f.bind()
  f.commit('retain controlled raw artifact')
  f.nested('update-index', '--assume-unchanged', '--', 'nested.js')
  f.write('vendor/dep/nested.js', 'hidden nested execution\n')
  assert.equal(f.nested('status', '--porcelain'), '')
  assert.throws(() => f.inspect(receipt), /dirty protected source.*checkout bytes/)
})

test('protected symlink targets are compared as bytes rather than followed', t => {
  const f = fixture(t)
  symlinkSync('runtime.js', join(f.root, 'source-link'))
  const measured = f.commit('measure a protected symlink')
  const inventory = captureSourceInventory(measured, { root: f.root })
  const bytes = Buffer.from(JSON.stringify(inventory) + '\n')
  f.write(INVENTORY, bytes)
  const receipt = { commit: measured, sourceBinding: { version: '1.0', inventory: { path: INVENTORY, sha256: sha256(bytes) },
    pathListSha256: inventory.pathListSha256, gateDefinitionsSha256: inventory.gateDefinitionsSha256 },
    artifacts: [{ path: INVENTORY, sha256: sha256(bytes) }] }
  f.commit('archive symlink source inventory')
  assert.equal(f.inspect(receipt).inspectedCommitCount, 1)
  f.git('update-index', '--assume-unchanged', '--', 'source-link')
  rmSync(join(f.root, 'source-link')); symlinkSync('Cargo.lock', join(f.root, 'source-link'))
  assert.throws(() => f.inspect(receipt), /dirty protected source.*checkout bytes/)
})

const LF_SCRIPT = 'Write-Output "source identity"\nWrite-Output "second line"\n'
const crlfScript = LF_SCRIPT.replaceAll('\n', '\r\n')

test('versioned explicit text/eol materializes canonical CRLF without changing Git source identity', t => {
  const f = fixture(t, { files: { '.gitattributes': '*.ps1 text eol=crlf\n', 'source.ps1': LF_SCRIPT } })
  rmSync(join(f.root, 'source.ps1'))
  f.git('checkout-index', '--force', '--', 'source.ps1')
  assert.equal(f.readArtifact('source.ps1').toString(), crlfScript)
  assert.equal(f.git('diff', '--exit-code', '--', 'source.ps1'), '', 'real Git CRLF checkout must have no content diff')
  const receipt = f.bind()
  const inventory = captureSourceInventory(f.source, { root: f.root })
  assert.equal(inventory.entries.find(entry => entry.path === 'source.ps1').objectId, f.git('rev-parse', `${f.source}:source.ps1`))
  assert.equal(f.git('show', `${f.source}:source.ps1`) + '\n', LF_SCRIPT)
  f.commit('archive CRLF materialization evidence')
  assert.equal(f.inspect(receipt).inspectedCommitCount, 1)
})

test('nested versioned attributes and macros are read from the immutable tree', t => {
  const f = fixture(t, { files: {
    '.gitattributes': '[attr]windows-script text eol=crlf\n*.ps1 text eol=lf\n',
    'nested/.gitattributes': '*.ps1 windows-script\n',
    'nested/source.ps1': LF_SCRIPT,
  } })
  rmSync(join(f.root, 'nested/source.ps1'))
  f.git('checkout-index', '--force', '--', 'nested/source.ps1')
  assert.equal(f.readArtifact('nested/source.ps1').toString(), crlfScript)
  const receipt = f.bind(); f.commit('archive immutable nested attributes')
  assert.equal(f.inspect(receipt).inspectedCommitCount, 1)
})

test('canonical CRLF proof is applied recursively inside an unchanged gitlink', t => {
  const f = fixture(t, { withGitlink: true, files: {
    'vendor/dep/.gitattributes': '*.ps1 text eol=crlf\n', 'vendor/dep/source.ps1': LF_SCRIPT,
  } })
  rmSync(join(f.root, 'vendor/dep/source.ps1'))
  f.nested('checkout-index', '--force', '--', 'source.ps1')
  assert.equal(f.readArtifact('vendor/dep/source.ps1').toString(), crlfScript)
  const receipt = f.bind(); f.commit('archive CRLF dependency checkout')
  assert.equal(f.inspect(receipt).inspectedCommitCount, 1)
})

for (const [name, bytes] of [
  ['mixed LF and CRLF', LF_SCRIPT.replace('\n', '\r\n')],
  ['bare CR', crlfScript.replace('\r\n', '\r')],
  ['NUL-bearing text', '\0' + crlfScript],
  ['changed source under canonical CRLF', crlfScript.replace('source identity', 'changed identity')],
]) {
  test(`explicit CRLF does not normalize ${name}`, t => {
    const f = fixture(t, { files: { '.gitattributes': '*.ps1 text eol=crlf\n', 'source.ps1': LF_SCRIPT } })
    const receipt = f.bind(); f.commit('archive before checkout corruption')
    f.git('update-index', '--assume-unchanged', '--', 'source.ps1')
    f.write('source.ps1', bytes)
    assert.throws(() => f.inspect(receipt), /dirty protected source.*checkout bytes/)
  })
}

test('core.autocrlf alone cannot authorize changed checkout bytes', t => {
  const f = fixture(t, { files: { 'source.ps1': LF_SCRIPT } })
  const receipt = f.bind(); f.commit('archive undeclared LF source')
  f.git('config', 'core.autocrlf', 'true')
  rmSync(join(f.root, 'source.ps1'))
  f.git('checkout-index', '--force', '--', 'source.ps1')
  assert.equal(f.readArtifact('source.ps1').toString(), crlfScript)
  assert.equal(f.git('diff', '--exit-code', '--', 'source.ps1'), '')
  assert.throws(() => f.inspect(receipt), /dirty protected source.*checkout bytes/)
})

test('text=auto is not accepted as an explicit canonical CRLF declaration', t => {
  const f = fixture(t, { files: { '.gitattributes': '*.ps1 text=auto eol=crlf\n', 'source.ps1': LF_SCRIPT } })
  rmSync(join(f.root, 'source.ps1'))
  f.git('checkout-index', '--force', '--', 'source.ps1')
  assert.equal(f.readArtifact('source.ps1').toString(), crlfScript)
  const receipt = f.bind(); f.commit('archive auto-classified checkout')
  assert.throws(() => f.inspect(receipt), /dirty protected source.*checkout bytes/)
})

test('uncommitted attributes cannot authorize a CRLF materialization', t => {
  const f = fixture(t, { files: { '.gitattributes': '*.ps1 text eol=lf\n', 'source.ps1': LF_SCRIPT } })
  const receipt = f.bind(); f.commit('archive before unmeasured attribute change')
  f.write('.gitattributes', '*.ps1 text eol=crlf\n')
  f.write('source.ps1', crlfScript)
  assert.throws(() => f.inspect(receipt), /dirty protected source.*checkout bytes/)
})

test('local info/attributes cannot override versioned checkout materialization', t => {
  const f = fixture(t, { files: { 'source.ps1': LF_SCRIPT } })
  const receipt = f.bind(); f.commit('archive before local attribute override')
  f.write('.git/info/attributes', '*.ps1 text eol=crlf\n')
  f.write('source.ps1', crlfScript)
  assert.throws(() => f.inspect(receipt), /local Git info\/attributes/)
})

test('global attribute configuration cannot authorize normalization or filter execution', t => {
  const f = fixture(t, { files: { 'source.ps1': LF_SCRIPT } })
  const receipt = f.bind(); f.commit('archive before global attribute override')
  f.write('.git/global-attributes', '*.ps1 text eol=crlf filter=untrusted\n')
  f.git('config', 'core.attributesFile', join(f.root, '.git/global-attributes'))
  assert.equal(f.inspect(receipt).inspectedCommitCount, 1, 'global attributes are excluded even for matching bytes')
  f.write('source.ps1', crlfScript)
  assert.throws(() => f.inspect(receipt), /dirty protected source.*checkout bytes/)
})

for (const [name, declaration] of [
  ['custom filter', 'filter=untrusted'],
  ['filter named unset', 'filter=unset'],
  ['filter named unspecified', 'filter=unspecified'],
  ['working-tree encoding', 'working-tree-encoding=UTF-8'],
  ['ident expansion', 'ident'],
  ['ident named unset', 'ident=unset'],
  ['explicitly disabled filter', '-filter'],
  ['explicitly disabled encoding', '-working-tree-encoding'],
  ['explicitly disabled ident', '-ident'],
]) {
  test(`versioned ${name} requires an unsupported transformation and is rejected`, t => {
    const f = fixture(t, { files: { '.gitattributes': `*.ps1 ${declaration}\n`, 'source.ps1': LF_SCRIPT } })
    const receipt = f.bind(); f.commit('archive declared unsupported transformation')
    assert.throws(() => f.inspect(receipt), /unsupported checkout transformation/)
  })
}

test('new evidence attributes cannot execute configured clean or process filters during source proof', t => {
  const f = fixture(t), receipt = f.bind()
  f.commit('archive before local evidence attributes')
  f.write('docs/evidence/.gitattributes', '*.json filter=untrusted\n')
  const command = join(f.root, '.git/untrusted-filter.sh')
  f.write('.git/untrusted-filter.sh', '#!/bin/sh\nprintf invoked >> "$0.marker"\nexit 17\n')
  chmodSync(command, 0o755)
  const quoted = "'" + command.replaceAll("'", "'\\''") + "'"
  f.git('config', 'filter.untrusted.clean', quoted)
  f.git('config', 'filter.untrusted.process', quoted)
  f.git('config', 'filter.untrusted.required', 'true')
  const raw = join(f.root, 'docs/evidence/prior/raw.json')
  const changedTime = new Date(Date.now() + 60_000)
  utimesSync(raw, changedTime, changedTime)
  assert.equal(f.inspect(receipt).inspectedCommitCount, 1)
  assert.equal(existsSync(command + '.marker'), false, 'source proof must not execute content filters')
})
