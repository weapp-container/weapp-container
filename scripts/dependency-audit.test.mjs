import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { classifyUpdate, discoverProjects, isExcluded, parseArgs, runAudit, satisfiesRange, updateKind } from './dependency-audit.mjs'

test('classifies compatible semver updates and protects exact pins', () => {
  assert.equal(updateKind('1.2.3', '1.2.4'), 'patch')
  assert.equal(updateKind('1.2.3', '1.4.0'), 'minor')
  assert.equal(updateKind('1.2.3', '2.0.0'), 'major')
  assert.equal(satisfiesRange('1.4.0', '^1.2.3'), true)
  assert.equal(satisfiesRange('2.0.0', '^1.2.3'), false)
  assert.equal(classifyUpdate('1.2.3', '1.2.4', '1.2.3').eligible, false)
  assert.equal(classifyUpdate('1.2.3', '1.2.4', '^1.2.3').eligible, true)
  assert.equal(classifyUpdate('1.2.3', '1.2.4', '^1.2.3', true).eligible, false)
})

test('matches exclusions without excluding maintained sibling projects', () => {
  assert.equal(isExcluded('third-party/package.json', ['third-party/**']), true)
  assert.equal(isExcluded('packages/node/package.json', ['third-party/**']), false)
})

test('discovers configured projects and preserves blocked scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weapp-deps-'))
  try {
    await mkdir(join(root, 'app'), { recursive: true })
    await writeFile(join(root, 'app', 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { demo: '^1.0.0' } }))
    const config = { schemaVersion: 1, scopes: [{ name: 'fixture', kind: 'npm', path: 'app' }, { name: 'blocked', kind: 'flutter', path: 'missing', blocked: 'generated path' }], reportOnly: [], exclusions: [], protected: [] }
    const projects = await discoverProjects({ root, config })
    assert.deepEqual(projects.map(project => [project.name, project.manifestPresent]), [['fixture', true], ['blocked', false]])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('check mode is read-only and strict mode fails scanner and protected-pin issues', async () => {
  const calls = []
  const config = { schemaVersion: 1, scopes: [{ name: 'fixture', kind: 'npm', path: '.' }], reportOnly: [], exclusions: [], protected: [] }
  const runner = (command, args) => {
    calls.push([command, ...args])
    if (args[0] === 'outdated') return { status: 1, stdout: JSON.stringify({ demo: { current: '1.0.0', wanted: '1.0.1', latest: '2.0.0' }, major: { current: '1.0.0', wanted: '1.0.0', latest: '2.0.0' } }), stderr: '', error: null }
    if (args[0] === 'ci') return { status: 0, stdout: '', stderr: '', error: null }
    if (args[0] === 'audit') return { status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } }), stderr: '', error: null }
    if (args[0] === 'git') return { status: 0, stdout: '', stderr: '', error: null }
    return { status: 0, stdout: '', stderr: '', error: null }
  }
  const root = await mkdtemp(join(tmpdir(), 'weapp-deps-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { demo: '^1.0.0', major: '1.0.0' } }))
    const report = await runAudit({ root, config, options: parseArgs(['--strict']), commandRunner: runner })
    assert.equal(report.exitCode, 0)
    assert.equal(report.summary.eligible, 1)
    assert.ok(calls.some(call => call[0] === 'npm' && call[1] === 'outdated'))
    assert.ok(!calls.some(call => call[1] === 'update'))
    const plan = await runAudit({ root, config, options: parseArgs(['--mode', 'upgrade']), commandRunner: runner })
    assert.equal(plan.scopes[0].upgrade.attempted, false)
    assert.equal(plan.scopes[0].upgrade.candidates.length, 1)
    assert.ok(!calls.some(call => call[1] === 'update'))
    const applied = await runAudit({ root, config, options: parseArgs(['--mode', 'upgrade', '--apply']), commandRunner: runner })
    assert.equal(applied.scopes[0].upgrade.applied, true)
    assert.ok(calls.some(call => call[0] === 'npm' && call[1] === 'update'))
    const strictReport = await runAudit({ root, config: { ...config, protected: [{ path: 'package.json', reason: 'fixture pin' }] }, options: parseArgs(['--strict']), commandRunner: (...args) => args[0] === 'git' ? { status: 0, stdout: 'package.json\n', stderr: '', error: null } : runner(...args) })
    assert.equal(strictReport.exitCode, 1)
    assert.equal(strictReport.summary.strictFailures[0].code, 'protected-pin-change')
  } finally { await rm(root, { recursive: true, force: true }) }
})
