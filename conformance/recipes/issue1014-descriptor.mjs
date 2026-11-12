/** Full unchanged #1014 runtime coverage. Attribute names only; no expected values. */
const text = selector => Object.freeze({ selector, text: true, attributes: Object.freeze([]) })
export const descriptor = Object.freeze({
  caseId: 'ide-github-issues-runtime-issue1014',
  sourceSha256: '332a6673e36403659dc83eb634177e239400e748e2d346b50c7569f17e552bc8',
  route: 'pages/issue-1014/index',
  checkpoints: Object.freeze([
    Object.freeze({ id: 'explicit-control-initial', taps: 0, queries: Object.freeze([
      text('#issue1014-title'),
      Object.freeze({ selector: '#issue1014-explicit-control', text: false, attributes: Object.freeze(['data-title']) }),
      text('#issue1014-explicit-count'),
    ]) }),
    Object.freeze({ id: 'explicit-control-tapped', taps: 1, queries: Object.freeze([text('#issue1014-explicit-count')]) }),
  ]),
  action: Object.freeze({ afterCheckpoint: 1, selector: '#issue1014-explicit-control' }),
})
