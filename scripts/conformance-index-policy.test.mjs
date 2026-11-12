import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewedCasesForBaseline } from './conformance-index-policy.mjs'

test('reviewed observations belong to exact compiler, SDK and official oracle versions', () => {
  const baseline = { devtoolsVersion: '2.02.2609250', baseLibraryVersion: '3.17.3', compiler: { name: 'weapp-vite', commit: 'a'.repeat(40), platform: 'weapp' } }
  const previous = { compiler: { ...baseline.compiler }, oracle: { devtoolsVersion: baseline.devtoolsVersion, baseLibraryVersion: baseline.baseLibraryVersion,
    primary: 'wechat-devtools', auxiliary: ['mpcore', 'weapp-vite-web'] },
    cases: [{ id: 'ide-example', sourceSha256: 'b'.repeat(64), status: 'passed', evidence: ['historical-receipt.json'] }] }
  assert.equal(reviewedCasesForBaseline(previous, baseline).get('ide-example').status, 'passed')
  for (const change of [
    index => { index.oracle.devtoolsVersion = '2.02.2608080' },
    index => { index.oracle.baseLibraryVersion = '3.17.4' },
    index => { index.compiler.commit = 'c'.repeat(40) },
    index => { index.oracle.primary = 'mpcore' },
  ]) {
    const candidate = structuredClone(previous)
    change(candidate)
    assert.equal(reviewedCasesForBaseline(candidate, baseline).size, 0)
    assert.equal(candidate.cases[0].status, 'passed', 'historical input remains intact')
  }
})
