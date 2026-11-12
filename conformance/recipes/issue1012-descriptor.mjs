/** Coverage from the unchanged pinned test. No rendered/expected values. */
const queries = Object.freeze(['#issue1012-map-result', '#issue1012-results'])
export const descriptor = Object.freeze({
  caseId: 'ide-github-issues-runtime-issue1012',
  sourceSha256: 'c91ec602d9bc78f722f5a3d4e4930e840f4227f8d567c0ee1c88063579bb67ff',
  route: 'pages/issue-1012/index',
  checkpoints: Object.freeze([
    Object.freeze({ id: 'initial', queries, taps: 0 }),
    Object.freeze({ id: 'executed', queries, taps: 1 }),
  ]),
  action: Object.freeze({ afterCheckpoint: 1, selector: '#issue1012-run' }),
})
