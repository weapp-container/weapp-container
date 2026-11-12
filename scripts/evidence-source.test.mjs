import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { inspectEvidenceSource } from './evidence-source.mjs'

test('measured source survives evidence archival but runtime or gate changes invalidate it', () => {
  const root = mkdtempSync(join(tmpdir(), 'weapp-evidence-source-'))
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
    git(['add', path])
    git(['commit', '-m', path])
    return git(['rev-parse', 'HEAD'])
  }
  try {
    git(['init', '-q'])
    git(['config', 'user.name', 'Weapp Container evidence test'])
    git(['config', 'user.email', 'weapp-test@example.invalid'])
    const source = commit('crates/runtime.rs', 'runtime-v1')
    assert.equal(inspectEvidenceSource(root, source, source).exact, true)
    const archive = commit('docs/mobile-gpu-evidence/run/report.json', '{}')
    const archived = inspectEvidenceSource(root, source, archive)
    assert.equal(archived.compatible, true)
    assert.equal(archived.archiveOnly, true)
    assert.deepEqual(archived.changedPaths, ['docs/mobile-gpu-evidence/run/report.json'])
    const indexed = commit('docs/conformance/case-index-v1.json', '{}')
    assert.equal(inspectEvidenceSource(root, source, indexed).compatible, true)
    const runtime = commit('crates/runtime.rs', 'runtime-v2')
    assert.equal(inspectEvidenceSource(root, source, runtime).compatible, false)
    assert.deepEqual(inspectEvidenceSource(root, source, runtime).nonEvidencePaths, ['crates/runtime.rs'])
    const gate = commit('scripts/check-near-parity-gates.mjs', 'gate-v2')
    assert.equal(inspectEvidenceSource(root, runtime, gate).compatible, false)
    assert.equal(inspectEvidenceSource(root, gate, source).compatible, false)
    assert.equal(inspectEvidenceSource(root, null, gate).compatible, false)
    assert.equal(inspectEvidenceSource(root, 'missing', gate).compatible, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
