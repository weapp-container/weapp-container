/** All original Web runtime static assertions. Expected literals are used
 * only after complete actual native observations, never as readiness input. */
import { descriptor } from '../../../conformance/recipes/web-runtime-descriptor.mjs'
import { loadGithubStaticInputs, validateGithubStaticInputs } from './github-static-inputs.mjs'
const require = (condition, message) => { if (!condition) throw new Error(message) }
export function webRuntimeAssertionIds() { return descriptor.plans.map(plan => `github-issues runtime web runtime globals ${plan.test}`) }
export async function loadWebRuntimeInputs(options) {
  return loadGithubStaticInputs({ ...options, descriptor, assertionIds: webRuntimeAssertionIds(), label: 'Web runtime' })
}
export function assertWebRuntimeStaticOutputs(input) {
  require(input?.caseId === descriptor.caseId, 'Web runtime static coverage belongs to another source case')
  validateGithubStaticInputs({ input, descriptor, label: 'Web runtime' })
  const files = new Map(input.files.map(file => [file.path, file.bytes.toString('utf8')]))
  let assertions = 0
  const expect = (condition, message) => { assertions++; require(condition, 'Original Web runtime static assertion: ' + message) }
  const contains = (source, literal) => expect(source.includes(literal), 'missing ' + literal)
  for (const extension of ['wxml', 'json', 'js']) expect(files.get(`pages/issue-1186/index.${extension}`) !== '', 'empty issue-1186 ' + extension)
  const wxml448 = files.get('pages/issue-448/index.wxml'), js448 = files.get('pages/issue-448/index.js')
  contains(wxml448, 'class="issue448-page"'); contains(wxml448, 'class="issue448-title"')
  expect(wxml448.match(/class="issue448-line"/g)?.length === 18, 'issue448-line count')
  for (const literal of ['installWebRuntimeGlobals', '"fetch"', '"CustomEvent"', 'btoa("AB")', 'atob(encoded)',
    'URL.parse("123", "fake://abc")', 'new URLSearchParams("b=2&a=1&a=0")', 'headers.getSetCookie().length',
    'Response.json({ ok: true })', 'Response.error()', 'queueMicrotask', '_runE2E']) contains(js448, literal)
  const wxml459 = files.get('pages/issue-459/index.wxml'), js459 = files.get('pages/issue-459/index.js')
  contains(wxml459, 'class="issue459-page"'); contains(wxml459, 'class="issue459-title"')
  expect(wxml459.match(/class="issue459-line"/g)?.length === 6, 'issue459-line count')
  for (const literal of ['RequestPolyfill', 'URLPolyfill("/abc", "https://issue-459.invalid")', 'ResponsePolyfill("123")',
    'TextDecoderPolyfill', 'TextEncoderPolyfill', 'Object.keys(response).join(",")', '_runE2E']) contains(js459, literal)
  const wxml804 = files.get('pages/issue-804/index.wxml')
  contains(wxml804, 'id="issue804-page"'); contains(wxml804, '<pressable')
  // Original readdir selects every direct-child .js. The shared loader binds
  // this complete membership to both original CLI and actual snapshot trees.
  const vendors = input.directories[0].members.map(path => files.get(path)).join('\n')
  contains(vendors, 'resolveMiniProgramPlatform')
  expect(!vendors.includes('request-globals-wevu-web-apis-fetch.js'), 'forbidden request-globals vendor reference')
  require(assertions === 32, 'Web runtime original static assertion coverage is incomplete')
  return { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, manifestIntegrity: input.manifestIntegrity,
    originalStaticExpectations: assertions, originalFixedFiles: descriptor.compiledFiles.length,
    vendorFiles: [...input.directories[0].members], files: input.files.map(({ path, sha256, length: bytes }) => ({ path, sha256, bytes })) }
}
