/** The unchanged six exists and six generated-WXML assertions. These values
 * enter final host assertions only, after native observation is complete. */
import { createHash } from 'node:crypto'
import { descriptor } from '../../../conformance/recipes/issue1013-descriptor.mjs'
import { loadSourcePlanInputs } from './source-plan-static.mjs'

const require = (condition, message) => { if (!condition) throw new Error(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export const issue1013AssertionIds = Object.freeze(descriptor.plans.map(plan => plan.fullName))
export const loadIssue1013Inputs = options => loadSourcePlanInputs({ ...options, descriptor, assertionIds: issue1013AssertionIds })
export function assertIssue1013StaticOutputs(input) {
  require(input?.caseId === descriptor.caseId && input.sourceSha256 === descriptor.sourceSha256
    && Array.isArray(input.files) && input.files.length === descriptor.compiledFiles.length, 'Issue1013 original static coverage is incomplete')
  for (const [at, path] of descriptor.compiledFiles.entries()) {
    const file = input.files[at]
    // Each source pathExists is applied to a real generated regular member
    // bound to both the CLI generation and the executed snapshot/pack.
    require(file?.path === path && Buffer.isBuffer(file.bytes) && file.length === file.bytes.length && file.sha256 === hash(file.bytes),
      'Issue1013 original generated member is absent or changed')
  }
  const wxml = input.files.find(file => file.path === 'pages/issue-1013/index.wxml').bytes.toString('utf8')
  require(!/\sattr=/.test(wxml), 'Issue1013 original WXML still contains a dynamic attr name')
  require(!wxml.includes('bindevent='), 'Issue1013 original WXML still contains a dynamic event name')
  for (const literal of ['data-title="{{staticTitle}}"', 'bindtap="__weapp_vite_inline"', 'data-wd-ready="1"', 'bindready="__weapp_vite_inline"']) {
    require(wxml.includes(literal), 'Issue1013 original WXML is missing a static control')
  }
  return { caseId: descriptor.caseId, sourceSha256: input.sourceSha256, manifestIntegrity: input.manifestIntegrity,
    originalAccesses: 7, originalStaticExpectations: 12,
    files: input.files.map(({ path, sha256, length: bytes }) => ({ path, sha256, bytes })) }
}
