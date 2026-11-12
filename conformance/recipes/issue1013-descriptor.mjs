/** Addresses, field names and source provenance only. Expected rendered values
 * remain in the unchanged test and final oracle comparison. */
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }; return value }
const query = (selector, attributes = [], scope) => ({ selector, query: 'css', ...(scope ? { scope } : {}), fields: { text: true, attributes } })
const checkpoint = (ordinal, id, queries) => ({ kind: 'checkpoint', ordinal, id, queries })
const tap = (ordinal, selector) => ({ kind: 'tap', ordinal, address: { selector, query: 'css' }, sourceAcquisition: 'Page.$$ then unique Element.tap' })
export const descriptor = freeze({
  caseId: 'ide-github-issues-runtime-issue1013',
  caseSourcePath: 'e2e/ide/github-issues.runtime.issue1013.test.ts',
  sourceSha256: 'dd214fe8af937331788f4b491b51c9fd0816fe45614c28e3f9a192c29781cb35',
  plans: [{ ordinal: 0, fullName: 'e2e app: github-issues / issue #1013 omits unsupported dynamic names while static native and component controls still run',
    route: 'pages/issue-1013/index', steps: [
      checkpoint(0, 'initial', [query('#issue-1013-dynamic'), query('#issue-1013-dynamic-count'), query('#issue-1013-static-probe-count'),
        query('#issue-1013-native', ['data-title']), query('#issue-1013-child', [], [{ has: '#issue-1013-child' }]), query('#issue-1013-component-status')]),
      tap(0, '#issue-1013-dynamic'),
      checkpoint(1, 'dynamic-event-ignored', [query('#issue-1013-dynamic-count'), query('#issue-1013-static-probe-count')]),
      tap(1, '#issue-1013-native'),
      checkpoint(2, 'static-native-event', [query('#issue-1013-native', ['data-title']), query('#issue-1013-component-status')]),
    ] }],
  compiledFiles: ['pages/issue-1013/index.js', 'pages/issue-1013/index.json', 'pages/issue-1013/index.wxml',
    'components/issue-1013-child/index.js', 'components/issue-1013-child/index.json', 'components/issue-1013-child/index.wxml'],
})
