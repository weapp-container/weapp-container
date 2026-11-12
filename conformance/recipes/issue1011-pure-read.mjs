/** Independent certificate for this exact page and FunctionDeclaration only. */
import { createHash } from 'node:crypto'
import { descriptor } from './issue1011-descriptor.mjs'
export const pureReadAudit=descriptor.plans[0].steps.find(step=>step.kind==='method.poll').normalization
const method='function _snapshot() {\n  return {\n    objectCaptures: objectCaptures.map(capture => ({ ...capture })),\n    tupleCaptures: tupleCaptures.map(capture => ({ ...capture })),\n  }\n}'
export function assertIssue1011PureReadSource(bytes){
 const sha=value=>createHash('sha256').update(value).digest('hex'),text=Buffer.from(bytes).toString('utf8')
 if(sha(bytes)!==pureReadAudit.sourceSha256||sha(method)!==pureReadAudit.methodBodySha256
  ||pureReadAudit.methodSyntaxKind!=='FunctionDeclaration'||text.slice(pureReadAudit.methodAstStart,pureReadAudit.methodAstEnd)!==method
  ||text.split('\n').slice(pureReadAudit.methodStartLine-1,pureReadAudit.methodEndLine).join('\n')!==method
  ||text.split(method).length!==2)throw new Error('Issue1011 terminal normalization lacks its exact independent pure-read source/AST')
 return {...pureReadAudit}
}
