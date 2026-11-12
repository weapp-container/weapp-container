/** Original complete static expectations, applied only after actual observations. */
import { descriptor } from '../../../conformance/recipes/issue547-descriptor.mjs'
import { loadGithubStaticInputs, validateGithubStaticInputs } from './github-static-inputs.mjs'
const require = (ok, message) => { if (!ok) throw new Error(message) }
export const issue547AssertionIds = () => descriptor.plans.map(plan => plan.fullName)
export const loadIssue547Inputs = options => loadGithubStaticInputs({ ...options, descriptor, assertionIds: issue547AssertionIds(), label: 'Issue547' })
export function assertIssue547StaticOutputs(input) {
  require(input?.caseId === descriptor.caseId, 'Issue547 static input belongs to another source case')
  validateGithubStaticInputs({ input, descriptor, label: 'Issue547' })
  const files = new Map(input.files.map(file => [file.path, file.bytes.toString('utf8')]))
  require(files.get("pages/issue-547/index.wxml").includes("issue-547 nested augmented slot"), 'Issue547 original static assertion at line 55 failed')
  require(files.get("pages/issue-547/index.wxml").includes("nested-slot-group"), 'Issue547 original static assertion at line 56 failed')
  require(files.get("pages/issue-547/index.wxml").includes("generic:scoped-slots-default"), 'Issue547 original static assertion at line 57 failed')
  require(files.get("components/issue-547/NestedSlotImage/index.wxml").includes("issue-547 nested slot image"), 'Issue547 original static assertion at line 60 failed')
  require(files.get("components/issue-547/NestedSlotImage/index.wxml").includes("data-issue547-image=\"true\""), 'Issue547 original static assertion at line 61 failed')
  return { caseId: descriptor.caseId, sourceSha256: input.sourceSha256, originalStaticExpectations: 5, files: input.files.map(({path,sha256,length:bytes})=>({path,sha256,bytes})) }
}
