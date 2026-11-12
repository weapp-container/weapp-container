/** Exact predicate from source :96. A property-access throw is unsuccessful
 * readiness because the unchanged pinned helper catches it and retries.
 * 12s and 220ms come from that helper, independently of oracle observations. */
export const readinessPolicies = Object.freeze({
  'e2e/ide/github-issues.runtime.issue1008.test.ts:91 readiness callback': Object.freeze({
    timeoutMs: 12000, pollMs: 220,
    ready: snapshot => { try { return snapshot.count === 1 } catch { return false } },
  }),
})
