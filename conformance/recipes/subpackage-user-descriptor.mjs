/** Exact source plan structure only. Test titles are source provenance, not observed task IDs.
 * Original expected texts remain exclusively in the original source assertions. */
const text = selector => Object.freeze({ selector, text: true })
const plan = (ordinal, test, route, selectors) => Object.freeze({ ordinal, test, route,
  actions: Object.freeze([]), checkpoints: Object.freeze([Object.freeze({ id: 'initial',
    queries: Object.freeze(selectors.map(text)) })]) })
export const descriptor = Object.freeze({
  caseId: 'ide-github-issues-runtime-subpackage-user',
  caseSourcePath: 'e2e/ide/github-issues.runtime.subpackage-user.test.ts',
  sourceSha256: 'b5504ae1432588556f30993d93ae2dccfbd0f27876457106afb0a91914cf48de',
  plans: Object.freeze([
    plan(0, 'issue #317: loads duplicated shared chunks with localized runtime', 'subpackages/user/index', ['.issue317-message', '.issue317-npm-marker']),
    plan(1, 'issue #340: loads cross-subpackage source imports in user/register/form', 'subpackages/user/register/form', ['.issue340-message']),
  ]),
  compiledFiles: Object.freeze(['subpackages/user/weapp-shared/common.js', 'subpackages/user/register/form.js']),
})
