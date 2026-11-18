/** Exact original item/user static assertions over the actual admitted pack. */
import { descriptor as itemDescriptor } from '../../../conformance/recipes/subpackage-item-descriptor.mjs'
import { descriptor as userDescriptor } from '../../../conformance/recipes/subpackage-user-descriptor.mjs'
import { loadGithubStaticInputs, validateGithubStaticInputs } from './github-static-inputs.mjs'
const require = (condition, message) => { if (!condition) throw new Error(message) }
const descriptors = Object.freeze([itemDescriptor, userDescriptor])
export function subpackageDescriptor(caseId) {
  const descriptor = descriptors.find(value => value.caseId === caseId)
  require(descriptor, 'Subpackage adapter requires its exact reviewed source case')
  return descriptor
}
export function subpackageAssertionIds(caseId) {
  const descriptor = subpackageDescriptor(caseId), kind = caseId.endsWith('-item') ? 'item' : 'user'
  return descriptor.plans.map(plan => `e2e app: github-issues / ${kind} subpackage ${plan.test}`)
}

export async function loadSubpackageInputs(options) {
  const descriptor = subpackageDescriptor(options.recipe?.caseId)
  return loadGithubStaticInputs({ ...options, descriptor, assertionIds: subpackageAssertionIds(descriptor.caseId), label: 'Subpackage' })
}

export function assertSubpackageStaticOutputs(input) {
  const descriptor = subpackageDescriptor(input?.caseId)
  validateGithubStaticInputs({ input, descriptor, label: 'Subpackage' })
  // Unchanged original assertions: sharedPath exists; actual pageJs contains
  // this literal. These values never enter runtime IPC or readiness.
  const kind = descriptor.caseId.endsWith('-item') ? 'item' : 'user'
  const expected = kind === 'item' ? 'item-login-required:issue-340:shared' : 'user-register-form:issue-340:shared'
  require(input.files[0].path.endsWith('/weapp-shared/common.js'), 'Original subpackage shared chunk does not exist')
  require(input.files[1].bytes.toString('utf8').includes(expected), 'Original subpackage page JS does not contain its cross-subpackage import marker')
  return { caseId: descriptor.caseId, sourceSha256: input.sourceSha256, manifestIntegrity: input.manifestIntegrity,
    originalAccesses: 2, originalStaticExpectations: 2,
    files: input.files.map(({ path, sha256, length: bytes }) => ({ path, sha256, bytes })) }
}
