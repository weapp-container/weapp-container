import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { validateReport, validateTrace } from './verify-conformance.mjs'

const caseId = 'ide-route-transaction'
const ids = new Set([caseId, 'ide-other'])
const trace = () => ({
  schemaVersion: 1, caseId, oracle: 'wechat-devtools',
  run: { status: 'passed', host: 'devtools', engine: 'wechat', protocolVersion: '1.0', manifestVersion: '1.0' },
  events: [{ seq: 0, kind: 'lifecycle', op: 'page.ready', payload: { path: 'pages/home' } }],
  assertions: [{ id: 'page is ready', passed: true }],
})

function archive(t) {
  const root = mkdtempSync(join(tmpdir(), 'conformverify-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, value) => writeFileSync(join(root, path), JSON.stringify(value))
  put('official.json', trace())
  const report = {
    schemaVersion: 1, generatedAt: '2026-11-06T00:00:00Z', suite: 'weapp-vite-e2e-ide', indexSha256: 'a'.repeat(64),
    runs: [{ caseId, status: 'passed', trace: 'official.json' }],
    summary: { total: 1, passed: 1, failed: 0, blocked: 0, unknown: 0 },
  }
  return { root, put, report }
}

test('observation reports validate the referenced trace rather than only status counts', t => {
  const { root, put, report } = archive(t)
  assert.doesNotThrow(() => validateReport(report, ids, root))
  report.runs[0].trace = 'absent.json'
  assert.throws(() => validateReport(report, ids, root), /ENOENT/)
  report.runs[0].trace = 'official.json'
  const wrongCase = trace(); wrongCase.caseId = 'ide-other'
  put('official.json', wrongCase)
  assert.throws(() => validateReport(report, ids, root), /case\/status differ/)
  const wrongStatus = trace(); wrongStatus.run.status = 'failed'
  put('official.json', wrongStatus)
  assert.throws(() => validateReport(report, ids, root), /case\/status differ/)
})

test('duplicate execution pairs cannot replace a missing provider while distinct pairs remain valid', t => {
  const { root, put, report } = archive(t)
  const container = trace()
  container.oracle = 'container'; container.run.host = 'web'; container.run.engine = 'quickjs'
  put('container.json', container)
  report.runs.push({ caseId, status: 'passed', trace: 'container.json' })
  report.summary.total = report.summary.passed = 2
  assert.doesNotThrow(() => validateReport(report, ids, root))
  report.runs[1].trace = 'official.json'
  assert.throws(() => validateReport(report, ids, root), /duplicate report case\/provider\/host\/engine/)
})

test('report traces cannot escape their archive or use a symlink', t => {
  const { root, report } = archive(t)
  symlinkSync(join(root, 'official.json'), join(root, 'linked.json'))
  for (const path of ['../official.json', join(root, 'official.json'), './official.json', 'linked.json']) {
    report.runs[0].trace = path
    assert.throws(() => validateReport(report, ids, root), /unsafe report trace path|not a regular file/)
  }
})

test('normalized trace validation preserves complete event shape and assertion truth', () => {
  for (const update of [
    value => { value.events[0].seq = Number.MAX_SAFE_INTEGER + 1 },
    value => { value.events[0].op = '' },
    value => { value.events[0].atNs = -1 },
    value => { value.events[0].ignoredPayload = true },
    value => { value.run.engine = 'replacement-engine' },
    value => { value.events.push(structuredClone(value.events[0])) },
    value => { value.assertions[0].passed = false },
    value => { value.assertions.push(structuredClone(value.assertions[0])) },
    value => { value.run.startedAt = '2026-11-06T00:00:01Z'; value.run.endedAt = '2026-11-06T00:00:00Z' },
  ]) {
    const value = trace(); update(value)
    assert.throws(() => validateTrace(value, ids))
  }
})

test('CLI argument errors are explicit and forwarded pnpm separators are accepted', () => {
  const script = new URL('./verify-conformance.mjs', import.meta.url)
  const missing = spawnSync(process.execPath, [script.pathname, '--report'], { encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /--report requires a path/)
  const help = spawnSync(process.execPath, [script.pathname, '--', '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage:/)
})
