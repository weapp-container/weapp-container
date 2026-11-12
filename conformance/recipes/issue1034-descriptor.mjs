/** Coverage from the unchanged pinned source; no expected rendered values. */
const queries = Object.freeze(['#source', '#increment'])
const routes = Object.freeze([
  'pages/home/index',
  'subpackages/account/pages/detail/index',
  'subpackages/isolated/pages/detail/index',
])
export const descriptor = Object.freeze({
  caseId: 'ide-issue-1034-auto-routes-runtime',
  sourceSha256: '7af17235a588c76b5cf8cf5f8659b35a7b806ba421ba67e59e5146b2b41f1a4c',
  routes,
  pollSelector: '#source',
  tapSelector: '#increment',
  checkpoints: Object.freeze(routes.map((route, index) => Object.freeze({ id: `package-${index}`, route, queries }))),
})
