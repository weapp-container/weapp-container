/** Source addresses and operation order only. Expected results remain in final assertions. */
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
const route = 'pages/issue-1008/index'
const method = (kind, ordinal, sourceCallsite) => ({ kind, ordinal, method: '_runE2E', args: [], sourceCallsite,
  helperSha256: '28b80e5be581f5b825ef1be7c998b1db14a8566581d8528d11697cf03a786e47', routeHelperSha256: '958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb',
  sourceAcquisition: 'callRoutePageMethod then awaited terminal completion',
  ...(kind === 'method.readiness' ? { readinessHelperSha256: '958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb' } : {}) })
const checkpoint = (ordinal, id) => ({ kind: 'checkpoint', ordinal, id,
  queries: ['#issue1008-count', '#issue1008-parameter-result', '#issue1008-block-result', '#issue1008-closure-result']
    .map(selector => ({ selector, query: 'css', fields: { text: true, attributes: [] } })) })
const tap = (ordinal, selector) => ({ kind: 'tap', ordinal, address: { selector, query: 'css' }, sourceAcquisition: 'Page.$$ then unique Element.tap' })
const result = ordinal => method('method.call', ordinal, 'e2e/ide/github-issues.runtime.issue1008.test.ts:115 post-checkpoint _runE2E')
export const descriptor = freeze({
  caseId: 'ide-github-issues-runtime-issue1008', caseSourcePath: 'e2e/ide/github-issues.runtime.issue1008.test.ts', sourceSha256: '28b80e5be581f5b825ef1be7c998b1db14a8566581d8528d11697cf03a786e47',
  sourceGuards: [{ path: 'e2e/ide/github-issues.runtime.issue1008.test.ts', sha256: '28b80e5be581f5b825ef1be7c998b1db14a8566581d8528d11697cf03a786e47', bytes: 4088 },
    { path: 'e2e/ide/github-issues.runtime.shared.ts', sha256: '958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb', bytes: 53026 }],
  plans: [{ ordinal: 0, fullName: 'e2e app: github-issues / issue #1008 keeps shadowed template writes local while genuine setup ref writes remain live', route,
    steps: [method('method.readiness', 0, 'e2e/ide/github-issues.runtime.issue1008.test.ts:91 readiness callback'),
      checkpoint(0, 'initial'), result(1),
      tap(2, '#issue1008-parameter'), checkpoint(1, 'parameter'), result(3),
      tap(4, '#issue1008-block'), checkpoint(2, 'block'), result(5),
      tap(6, '#issue1008-closure'), checkpoint(3, 'closure'), result(7),
      tap(8, '#issue1008-setup-ref'), checkpoint(4, 'setup-ref'), result(9)] }],
  compiledFiles: ['pages/issue-1008/index.js', 'pages/issue-1008/index.json', 'pages/issue-1008/index.wxml'],
})
