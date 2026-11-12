/** Exact source plan structure only. Test titles are source provenance, not observed task IDs.
 * Original expected texts remain exclusively in the original source assertions. */
const text = selector => Object.freeze({ selector, text: true })
const plan = (ordinal, test, route, selectors) => Object.freeze({ ordinal, test, route,
  actions: Object.freeze([]), checkpoints: Object.freeze([Object.freeze({ id: 'initial',
    queries: Object.freeze(selectors.map(text)) })]) })
export const descriptor = Object.freeze({
  caseId: 'ide-github-issues-runtime-subpackage-item',
  caseSourcePath: 'e2e/ide/github-issues.runtime.subpackage-item.test.ts',
  sourceSha256: '2fad80fcbe8cb7d00cc87091ae7fce34a954650e8446ccbf374dcb164c129e13',
  plans: Object.freeze([
    plan(0, 'issue #317: loads duplicated shared chunks with localized runtime', 'subpackages/item/index', ['.issue317-message', '.issue317-npm-marker']),
    plan(1, 'issue #340: loads cross-subpackage source imports in item/login-required', 'subpackages/item/login-required/index', ['.issue340-message']),
  ]),
  compiledFiles: Object.freeze(['subpackages/item/weapp-shared/common.js', 'subpackages/item/login-required/index.js']),
})
