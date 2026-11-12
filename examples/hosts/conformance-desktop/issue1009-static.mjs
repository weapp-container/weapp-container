/** 只在完整生产证据 reader 之后保留三项 pathExists 和实际六字段返回值断言，不授予执行证据。 */
import { createHash } from 'node:crypto'
import { descriptor } from '../../../conformance/recipes/issue1009-descriptor.mjs'
import { assertIssue1009MethodResult } from '../../../conformance/recipes/issue1009-source-assertions.mjs'
import { assertIssue1009PureReadSource, pureReadAudit } from '../../../conformance/recipes/issue1009-pure-read.mjs'
import { loadSourcePlanEnvelope, loadSourcePlanInputs } from './source-plan-static.mjs'
const require = (value, message) => { if (!value) throw new Error(message) }
const digest = value => createHash('sha256').update(value).digest('hex')
export const issue1009AssertionIds = Object.freeze(descriptor.plans.map(plan => plan.fullName))
export async function loadIssue1009Inputs(options) {
  const input = { ...options, descriptor, assertionIds: issue1009AssertionIds }
  const envelope = await loadSourcePlanEnvelope(input)
  for (const stage of ['sourceBefore', 'sourceAfter']) {
    const members = envelope.checkpoint.build?.[stage]?.filter(member => member.path === 'src/pages/issue-1009/index.vue')
    require(members?.length === 1 && members[0].kind === 'file' && members[0].artifact?.sha256 === pureReadAudit.sourceSha256,
      'Issue1009 actual build closure omitted or changed its audited pure-read guest source')
    assertIssue1009PureReadSource(await envelope.read(members[0].artifact))
  }
  const loaded = await loadSourcePlanInputs(input), refs = new Map([...loaded.references, ...envelope.references.values()].map(ref => [ref.path, ref]))
  return { ...loaded, references: [...refs.values()] }
}
export function assertIssue1009Outputs(input, { methodResults } = {}) {
  require(input?.caseId === descriptor.caseId && input.sourceSha256 === descriptor.sourceSha256
    && Array.isArray(input.files) && input.files.length === descriptor.compiledFiles.length,
  'Issue1009 original generated member coverage is incomplete')
  for (const [at, path] of descriptor.compiledFiles.entries()) {
    const file = input.files[at]
    require(file?.path === path && Buffer.isBuffer(file.bytes) && file.length === file.bytes.length && file.sha256 === digest(file.bytes),
      `Issue1009 original pathExists member is absent or changed: ${path}`)
  }
  const runtime = assertIssue1009MethodResult(methodResults)
  return { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256,
    originalStaticExpectations: 3, originalRuntimeExpectations: 1, originalRuntimeFields: 6,
    assertionCoverage: [...descriptor.compiledFiles.map(path => `pathExists/${path}`), runtime],
    files: input.files.map(({ path, sha256, length: bytes }) => ({ path, sha256, bytes })) }
}
