/** Preserve three original pathExists checks, app pages membership and the complete actual snapshot after evidence admission. */
import { createHash } from 'node:crypto'
import { descriptor } from '../../../conformance/recipes/issue1011-descriptor.mjs'
import { assertIssue1011MethodResult } from '../../../conformance/recipes/issue1011-source-assertions.mjs'
import { assertIssue1011PureReadSource, pureReadAudit } from '../../../conformance/recipes/issue1011-pure-read.mjs'
import { loadSourcePlanEnvelope, loadSourcePlanInputs } from './source-plan-static.mjs'
const require = (value, message) => { if (!value) throw new Error(message) }
const digest = value => createHash('sha256').update(value).digest('hex')
export const issue1011AssertionIds = Object.freeze(descriptor.plans.map(plan => plan.fullName))
export async function loadIssue1011Inputs(options) {
  const input = { ...options, descriptor, assertionIds: issue1011AssertionIds }
  const envelope = await loadSourcePlanEnvelope(input)
  for (const stage of ['sourceBefore', 'sourceAfter']) {
    const members = envelope.checkpoint.build?.[stage]?.filter(member => member.path === 'src/pages/issue-1011/index.vue')
    require(members?.length === 1 && members[0].kind === 'file' && members[0].artifact?.sha256 === pureReadAudit.sourceSha256,
      'Issue1011 actual build closure omitted or changed its audited pure-read guest source')
    assertIssue1011PureReadSource(await envelope.read(members[0].artifact))
  }
  const loaded = await loadSourcePlanInputs(input), refs = new Map([...loaded.references, ...envelope.references.values()].map(ref => [ref.path, ref]))
  return { ...loaded, references: [...refs.values()] }
}
export function assertIssue1011Outputs(input, { methodResults } = {}) {
  require(input?.caseId === descriptor.caseId && input.sourceSha256 === descriptor.sourceSha256
    && Array.isArray(input.files) && input.files.length === descriptor.compiledFiles.length,
  'Issue1011 original generated member coverage is incomplete')
  for (const [at, path] of descriptor.compiledFiles.entries()) {
    const file = input.files[at]
    require(file?.path === path && Buffer.isBuffer(file.bytes) && file.length === file.bytes.length && file.sha256 === digest(file.bytes),
      `Issue1011 original pathExists member is absent or changed: ${path}`)
  }
  const pages=JSON.parse(input.files[3].bytes.toString('utf8')).pages
  require((Array.isArray(pages)||typeof pages==='string')&&pages.includes(descriptor.staticObligations.appPagesIncludes),'original app.json.pages toContain assertion failed')
  const runtime = assertIssue1011MethodResult(methodResults)
  return { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256,
    originalStaticExpectations: 4, originalRuntimeExpectations: 1, originalRuntimeCaptures: 5,
    assertionCoverage: [...descriptor.compiledFiles.slice(0,3).map(path => `pathExists/${path}`), 'app.json.pages/toContain', runtime],
    files: input.files.map(({ path, sha256, length: bytes }) => ({ path, sha256, bytes })) }
}
