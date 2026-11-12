import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { artifactReader, checkReviewedExecutionLink, CONFORMANCE_BASELINE as baseline } from './conformance-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

test('reviewed case evidence binds the exact official execution receipt', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'weapp-reviewed-execution-link-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const reportPath = 'docs/conformance/evidence/r15/report.json'
  mkdirSync(resolve(root, 'docs/conformance/evidence/r15'), { recursive: true })
  const item = { id: 'ide-github-issues-runtime-issue1009', sourceSha256: 'a'.repeat(64), evidence: [reportPath] }
  const receipt = { path: 'artifacts/run/official-execution.json', sha256: 'b'.repeat(64), bytes: 3531 }
  const report = {
    schemaVersion: 1, kind: 'reviewed-r15-official-result',
    baseline: { id: baseline.id, devtoolsVersion: baseline.devtoolsVersion,
      baseLibraryVersion: baseline.baseLibraryVersion, compilerCommit: baseline.compiler.commit },
    case: { caseId: item.id, sourceSha256: item.sourceSha256, status: 'passed' },
    independentReader: { status: 'passed' },
    cleanup: { ownedResourcesReleased: true, borrowedResourcesPreserved: true },
    receipts: { officialExecution: receipt },
  }
  const writeReport = value => writeFileSync(resolve(root, reportPath), `${JSON.stringify(value, null, 2)}\n`)
  const reader = artifactReader(root)
  writeReport(report)
  assert.doesNotThrow(() => checkReviewedExecutionLink(item, receipt, reader))
  assert.equal(reader.stable(), true)

  for (const change of [value => { value.receipts.officialExecution.path = 'artifacts/other/official-execution.json' },
    value => { value.receipts.officialExecution.sha256 = 'c'.repeat(64) },
    value => { value.receipts.officialExecution.bytes += 1 }]) {
    const changed = structuredClone(report)
    change(changed)
    writeReport(changed)
    assert.throws(() => checkReviewedExecutionLink(item, receipt, artifactReader(root)), /exact official execution receipt/)
  }

  assert.throws(() => checkReviewedExecutionLink({ ...item, evidence: [] }, receipt, artifactReader(root)), /not linked/)
  assert.doesNotThrow(() => checkReviewedExecutionLink({ ...item, evidence: [receipt.path] }, receipt, artifactReader(root)))
})
