/** All55 unchanged compiled JS/WXML expectations. Values are final static
 * assertions only; no generated string influences a runtime request. */
import { createHash } from 'node:crypto'
import { descriptor } from '../../../conformance/recipes/issue297-302-descriptor.mjs'
import { loadSourcePlanInputs } from './source-plan-static.mjs'
const require = (condition, message) => { if (!condition) throw new Error(message) }
const hash = value => createHash('sha256').update(value).digest('hex')
export const issue297302AssertionIds = Object.freeze(descriptor.plans.map(plan => plan.fullName))
export const loadIssue297302Inputs = options => loadSourcePlanInputs({ ...options, descriptor, assertionIds: issue297302AssertionIds })
export function assertIssue297302StaticOutputs(input) {
  require(input?.caseId === descriptor.caseId && input.sourceSha256 === descriptor.sourceSha256
    && Array.isArray(input.files) && input.files.length === descriptor.compiledFiles.length, 'Issue297302 original static coverage is incomplete')
  const files = new Map()
  for (const [at, path] of descriptor.compiledFiles.entries()) {
    const file = input.files[at]
    require(file?.path === path && Buffer.isBuffer(file.bytes) && file.length === file.bytes.length
      && file.sha256 === hash(file.bytes), 'Issue297302 generated source member is absent or changed')
    files.set(path, file.bytes.toString('utf8'))
  }
  const checks = []
  const check = (id, condition) => { require(condition, `Issue297302 original static assertion failed: ${id}`); checks.push(id) }
  const contains = (path, values) => values.forEach((value, at) => check(`${path}/contains/${at}`, files.get(path).includes(value)))
  const matches = (path, values) => values.forEach((value, at) => check(`${path}/matches/${at}`, value.test(files.get(path))))
  const excludes = (path, values) => values.forEach((value, at) => check(`${path}/excludes/${at}`, !files.get(path).includes(value)))
  const w = 'pages/issue-297/index.wxml', j = 'pages/issue-297/index.js'
  contains(w, ['issue-297 complex call expressions', 'Case A · v-bind 调用表达式', 'Case B · v-if + v-for 调用表达式',
    'Case C · 多参数调用（含激活项）', 'Case A(v-bind):', 'Case B(v-if/v-for):', 'Case C(多参数):', '新增列表项', '重置列表'])
  matches(w, [/wx:if="\{\{__wv_bind_\d+\}\}"/, /wx:for="\{\{__wv_bind_\d+\}\}"/,
    /data-title="\{\{__wv_bind_\d+\}\}"/, /data-hello="\{\{__wv_bind_\d+\[[^\]]+\]\}\}"/, /\{\{__wv_bind_\d+\[[^\]]+\]\}\}/])
  excludes(w, ['sayHello('])
  check(`${w}/unique-bind-tokens`, new Set(files.get(w).match(/__wv_bind_\d+/g) ?? []).size >= 5)
  contains(j, ["sayHello(1, 'root', dasd)", 'dasd', 'this.sayHello', '_runE2E', 'Hello'])
  const sw = 'pages/issue-297-setup-method-calls/index.wxml', sj = 'pages/issue-297-setup-method-calls/index.js'
  contains(sw, ['issue-297 setup method call variants', 'Case A · 插值调用 + 同级静态文本 + 同级元素', 'Case B · v-bind 多参数调用',
    'Case C · v-if + v-for 调用表达式', 'Case D · 成员调用 / 模板字符串 / 三元表达式', 'Case E · 可选调用 + 空值兜底'])
  matches(sw, [/wx:if="\{\{__wv_bind_\d+\}\}"/, /wx:for="\{\{__wv_bind_\d+\}\}"/,
    /data-inline="\{\{__wv_bind_\d+\}\}"/, /data-multi="\{\{__wv_bind_\d+\}\}"/, /data-label="\{\{__wv_bind_\d+\[[^\]]+\]\}\}"/,
    /data-loop="\{\{__wv_bind_\d+\[[^\]]+\]\}\}"/, /data-member="\{\{__wv_bind_\d+\}\}"/, /data-template="\{\{__wv_bind_\d+\}\}"/,
    /data-ternary="\{\{__wv_bind_\d+\}\}"/, /data-wrap="\{\{__wv_bind_\d+\}\}"/, /data-optional="\{\{__wv_bind_\d+\}\}"/])
  excludes(sw, ['getCase()', 'sayCase(', 'getOptionalInvoker?.('])
  contains(sj, ['this.getCase', 'this.sayCase', 'this.getRows', 'this.getOptionalInvoker', '_runE2E', 'toggleOptionalInvoker'])
  const lw = 'pages/issue-302/index.wxml', lj = 'pages/issue-302/index.js'
  contains(lw, ['issue-302 v-for class binding update', 'active: {{active}}', 'wx:for="{{tabs}}"'])
  matches(lw, [/class="\{\{__wv_cls_\d+\[(?:__wv_index_0|index)\]\}\}"/])
  contains(lj, ['setActive', '_runE2E', 'issue302-item-active', 'issue302-item-inactive'])
  require(checks.length === 55, 'Issue297302 static assertion projection is incomplete')
  return { caseId: descriptor.caseId, sourceSha256: input.sourceSha256, manifestIntegrity: input.manifestIntegrity,
    originalReadFiles: 6, originalStaticExpectations: checks.length, assertionCoverage: checks,
    files: input.files.map(({ path, sha256, length: bytes }) => ({ path, sha256, bytes })) }
}
