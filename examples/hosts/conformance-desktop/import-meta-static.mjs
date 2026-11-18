/** All original nine generated-WXML and two runtime partial-object assertions.
 * Runtime snapshot JSON comes from the actual final method return, independently of DOM. */
import { createHash } from 'node:crypto'
import { descriptor } from '../../../conformance/recipes/import-meta-descriptor.mjs'
import { loadSourcePlanInputs } from './source-plan-static.mjs'
const require = (condition, message) => { if (!condition) throw new Error(message) }
const hash = value => createHash('sha256').update(value).digest('hex')
export const importMetaAssertionIds = Object.freeze(descriptor.plans.map(plan => plan.fullName))
export const loadImportMetaInputs = options => loadSourcePlanInputs({ ...options, descriptor, assertionIds: importMetaAssertionIds })
export function assertImportMetaOutputs(input, { methodResults } = {}) {
  require(input?.caseId === descriptor.caseId && input.sourceSha256 === descriptor.sourceSha256 && input.files?.length === 1,
    'Import-meta source-generated coverage is incomplete')
  const file = input.files[0]
  require(file.path === descriptor.compiledFiles[0] && Buffer.isBuffer(file.bytes) && file.length === file.bytes.length
    && file.sha256 === hash(file.bytes), 'Import-meta original generated WXML bytes changed')
  require(Array.isArray(methodResults) && methodResults.length === 1 && methodResults[0].route === descriptor.plans[0].route
    && methodResults[0].method === '_runE2E' && methodResults[0].sourceCallsite === descriptor.plans[0].steps[1].sourceCallsite,
    'Import-meta final method return is absent or belongs to readiness/another source')
  const runtime = methodResults[0].value, checks = []
  const check = (id, condition) => { require(condition, `Import-meta original assertion failed: ${id}`); checks.push(id) }
  // Preserve JSON.parse behavior: malformed/absent snapshot throws; DOM cannot supply it.
  const importMetaSnapshot = JSON.parse(runtime.snapshot)
  check('runtime.toMatchObject', runtime.dirname === '/pages/issue-431' && runtime.url === '/pages/issue-431/index.js')
  check('snapshot.toMatchObject', importMetaSnapshot.dirname === '/pages/issue-431'
    && importMetaSnapshot.filename === '/pages/issue-431/index.js' && importMetaSnapshot.url === '/pages/issue-431/index.js')
  const pageWxml = file.bytes.toString('utf8')
  check('wxml.double', pageWxml.includes('data-case="double"'))
  check('wxml.single', pageWxml.includes("data-case='single'"))
  check('wxml.template-url', /data-template-url=(["'])\{\{['"]\/pages\/issue-431\/index\.wxml['"]\}\}\1/.test(pageWxml))
  check('wxml.template-dir', /data-template-dir=(["'])\{\{['"]\/pages\/issue-431['"]\}\}\1/.test(pageWxml))
  check('wxml.env-label', /data-env-label=(["'])\{\{['"]issue-431 native wxml env replacement['"]\}\}\1/.test(pageWxml))
  check('wxml.env-base', /data-env-base=(["'])\{\{['"]https:\/\/static\.example\.com\/issue-431['"]\}\}\1/.test(pageWxml))
  for (const value of ['import.meta.env', 'import.meta.url', 'import.meta.dirname']) check('wxml.excludes/'+value, !pageWxml.includes(value))
  require(checks.length === 11, 'Import-meta original assertions were omitted')
  return { caseId: descriptor.caseId, sourceSha256: input.sourceSha256, originalReadFiles: 1,
    originalStaticExpectations: 9, originalRuntimeExpectations: 2, assertionCoverage: checks,
    files: [{ path: file.path, sha256: file.sha256, bytes: file.length }] }
}
