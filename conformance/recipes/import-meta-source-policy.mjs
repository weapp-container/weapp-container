/** This literal predicate is copied from the unchanged source callback at :47.
 * 12s is the original shared helper's min(20s, default12s) readiness budget;
 * 220ms is its actual retry wait. Neither value comes from an oracle trace. */
export const readinessPolicies = Object.freeze({
  'e2e/ide/github-issues.runtime.import-meta.test.ts:46 readiness callback': Object.freeze({
    timeoutMs: 12000, pollMs: 220,
    ready: runtime => runtime?.url === '/pages/issue-431/index.js',
  }),
})
