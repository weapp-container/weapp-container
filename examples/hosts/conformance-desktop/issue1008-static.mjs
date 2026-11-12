/** Original three generated-file existence checks and all five exact method results.
 * DOM and method observations remain independent; expected values never drive IPC. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { descriptor } from '../../../conformance/recipes/issue1008-descriptor.mjs'
import { loadSourcePlanInputs } from './source-plan-static.mjs'
const require = (condition, message) => { if (!condition) throw new Error(message) }
const hash = value => createHash('sha256').update(value).digest('hex')
export const issue1008AssertionIds = Object.freeze(descriptor.plans.map(plan => plan.fullName))
export const loadIssue1008Inputs = options => loadSourcePlanInputs({ ...options, descriptor, assertionIds: issue1008AssertionIds })
const snapshots = Object.freeze([
  { blockResult: [], closureResult: [], count: 1, parameterResult: [] },
  { blockResult: [], closureResult: [], count: 1, parameterResult: [2] },
  { blockResult: [7, 8], closureResult: [], count: 1, parameterResult: [2] },
  { blockResult: [7, 8], closureResult: [5, 5], count: 1, parameterResult: [2] },
  { blockResult: [7, 8], closureResult: [5, 5], count: 7, parameterResult: [2] },
])
export function assertIssue1008Outputs(input, { methodResults } = {}) {
  require(input?.caseId === descriptor.caseId && input.sourceSha256 === descriptor.sourceSha256 && input.files?.length === 3,
    'Issue1008 original generated-file coverage is incomplete')
  for (const [at, path] of descriptor.compiledFiles.entries()) {
    const file = input.files[at]
    require(file.path === path && Buffer.isBuffer(file.bytes) && file.length === file.bytes.length && file.sha256 === hash(file.bytes),
      'Issue1008 original generated-file existence/identity check failed: ' + path)
  }
  const plan = descriptor.plans[0], methods = plan.steps.filter(step => step.kind === 'method.call')
  require(Array.isArray(methodResults) && methodResults.length === 5, 'Issue1008 requires every post-checkpoint method result')
  for (const [at, actual] of methodResults.entries()) {
    require(actual.route === plan.route && actual.method === '_runE2E' && actual.sourceCallsite === methods[at].sourceCallsite,
      'Issue1008 post-checkpoint method result belongs to another source')
    require(isDeepStrictEqual(actual.value, snapshots[at]), 'Issue1008 original toEqual snapshot failed at checkpoint ' + at)
  }
  return { caseId: descriptor.caseId, sourceSha256: input.sourceSha256, originalExistenceExpectations: 3,
    originalMethodResultExpectations: 5, originalDomCheckpoints: 5, originalTapCardinalityExpectations: 4,
    assertionCoverage: [...descriptor.compiledFiles.map(path => 'exists/' + path), ...['initial', 'parameter', 'block', 'closure', 'setup-ref'].map(id => 'snapshot/' + id)],
    files: input.files.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.length })) }
}
