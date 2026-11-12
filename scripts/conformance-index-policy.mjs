import { isDeepStrictEqual } from 'node:util'

const statuses = new Set(['passed', 'failed', 'blocked', 'unknown'])

/** A source hash alone cannot carry an observation to a different official
 * runtime. Keep historical evidence in its archive when the baseline moves. */
export function reviewedCasesForBaseline(index, baseline) {
  const oracle = { devtoolsVersion: baseline.devtoolsVersion, baseLibraryVersion: baseline.baseLibraryVersion,
    primary: 'wechat-devtools', auxiliary: ['mpcore', 'weapp-vite-web'] }
  if (!isDeepStrictEqual(index?.compiler, baseline.compiler) || !isDeepStrictEqual(index?.oracle, oracle)
    || !Array.isArray(index?.cases)) return new Map()
  return new Map(index.cases
    .filter(item => item && typeof item.id === 'string' && typeof item.sourceSha256 === 'string' && statuses.has(item.status))
    .map(item => [item.id, { sourceSha256: item.sourceSha256, status: item.status, evidence: item.evidence }]))
}
