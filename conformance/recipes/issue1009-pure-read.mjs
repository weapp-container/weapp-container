/** This one audited guest method only: no generic collapse for arbitrary poll callbacks. */
import { createHash } from 'node:crypto'
import { descriptor } from './issue1009-descriptor.mjs'
export const pureReadAudit = descriptor.plans[0].steps.find(step => step.kind === 'method.poll').normalization
const methodBody = 'function _runE2E() {\n  return { ...results.value }\n}'
export function assertIssue1009PureReadSource(bytes) {
  const source = Buffer.from(bytes).toString('utf8'), sha = value => createHash('sha256').update(value).digest('hex')
  if (sha(bytes) !== pureReadAudit.sourceSha256 || sha(methodBody) !== pureReadAudit.methodBodySha256
    || source.split(methodBody).length !== 2 || source.split('\n').slice(27, 30).join('\n') !== methodBody) {
    throw new Error('Issue1009 terminal normalization lacks its exact audited pure-read guest source')
  }
  return { ...pureReadAudit }
}
