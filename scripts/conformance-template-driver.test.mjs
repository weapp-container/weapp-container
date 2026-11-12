/** Actual archived Node children and original formatting packages. No compiler,
 * SDK, native host or UI executes. Expected package bytes are fixed inputs. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import closure from '../examples/hosts/conformance-desktop/fixtures/template-driver-closure.json' with { type: 'json' }
import { createDriverRegistry } from '../examples/hosts/conformance-desktop/driver-registry.mjs'
import { RUNNER_INPUTS } from './conformance-devtools-runner.mjs'
import { CONFORMANCE_BASELINE } from './conformance-evidence.mjs'
import { conformanceArtifactReference, readConformanceRecipes } from './conformance-recipes.mjs'
import { executeMatrixDriver, readHostDrivers } from './conformance-matrix-runner.mjs'

const sourceRoot = fileURLToPath(new URL('..', import.meta.url))
const formatRoot = 'conformance/recipes/'
const formatModule = formatRoot + 'template-snapshot-format.mjs'
const packagePrefix = formatRoot + 'template-format-dependencies/'
const portable = closure.templateDriver.filter(input => input.path.startsWith(packagePrefix))
const format = closure.templateDriver.find(input => input.path === formatModule)
const paths = inputs => inputs.map(input => input.path).sort()
const put = async (root, relative, bytes) => { const file = resolve(root, relative); await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes); return file }

async function fixture(t, body, { omit = () => false, ambient = false } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'template-cjs-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ref = relative => conformanceArtifactReference(root, resolve(root, relative))
  await put(root, 'scripts/conformance-matrix-driver.mjs', await readFile(resolve(sourceRoot, 'scripts/conformance-matrix-driver.mjs')))
  const marker = resolve(root, 'unexpected-body'), omitted = portable.filter(omit)
  const source = `import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
export async function run(){${body.replaceAll('__MARKER__', JSON.stringify(marker))}}
export const dispose=async()=>({ownedResourcesReleased:true,borrowedResourcesPreserved:true});\n`
  await put(root, 'driver.mjs', source)
  const included = [format, ...portable].filter(input => !omit(input))
  for (const input of included) await put(root, input.path, await readFile(resolve(sourceRoot, input.path)))
  if (ambient) {
    await put(root, 'node_modules/picocolors/package.json', '{"name":"picocolors","main":"index.js"}')
    await put(root, 'node_modules/picocolors/index.js', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ambient fallback ran');module.exports={};`)
  }
  await put(root, 'fixture.json', '{"manifest":{"integrity":{"root":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}')
  await put(root, 'collector.mjs', 'export const createCollector=()=>({attach(){}});\n')
  const outputDirectory = resolve(root, 'output'); await mkdir(outputDirectory)
  return { root, marker, omitted, outputDirectory, job: { caseId: 'ide-template-cjs-boundary-test', host: 'macos', engine: 'quickjs' },
    driver: { module: await ref('driver.mjs'), inputs: await Promise.all(included.map(input => ref(input.path))), timeoutMs: 10000 },
    recipe: { caseId: 'ide-template-cjs-boundary-test', sourceSha256: 'b'.repeat(64), fixture: await ref('fixture.json'),
      fixtureValue: { manifest: { integrity: { root: 'a'.repeat(64) } } }, resources: {}, collector: await ref('collector.mjs'), collectorInputs: [] } }
}
const importFormat = `const format=await import('./${formatModule}');`
const formatResult = `return {wxss:await format.formatWxss('view { color: red; }'),wxml:await format.formatWxml('<view>actual archive</view>')};`
const assertNoForeignBody = setup => assert.rejects(access(setup.marker), { code: 'ENOENT' })

test('the complete fixed 360-file format set belongs to source, driver, recipe and official runner inputs', async t => {
  assert.equal(portable.length, 360)
  assert.equal(portable.filter(input => input.path.includes('/node_modules/')).length, 277)
  const registry = await createDriverRegistry(sourceRoot), driverFiles = registry.drivers[0].inputs
  assert.deepEqual(paths(driverFiles.filter(input => input.path.startsWith(packagePrefix))), paths(portable))
  assert.deepEqual(RUNNER_INPUTS.filter(path => path.startsWith(packagePrefix)).sort(), paths(portable))
  assert.equal(new Set(RUNNER_INPUTS).size, RUNNER_INPUTS.length)
  const recipe = JSON.parse(await readFile(resolve(sourceRoot, 'conformance/recipes/template-multi-platform-v1.json'))).recipes[0]
  assert.deepEqual(paths(recipe.collectorInputs.filter(input => input.path.startsWith(packagePrefix))), paths(portable))
  const directory = await mkdtemp(resolve(sourceRoot, 'artifacts/template-registry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const driversFile = await put(directory, 'drivers.json', JSON.stringify(registry))
  assert.equal((await readHostDrivers({ root: sourceRoot, file: driversFile })).size, 2)
  assert.equal((await readConformanceRecipes({ root: sourceRoot, file: resolve(sourceRoot, 'conformance/recipes/template-multi-platform-v1.json'), index: { cases: [{ id: recipe.caseId, sourceSha256: recipe.sourceSha256 }] } })).size, 1)
})

test('the narrow Git exception retains all exact portable files while ordinary dist and dependencies stay ignored', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'template-source-ignore-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await put(directory, '.gitignore', await readFile(resolve(sourceRoot, '.gitignore')))
  execFileSync('git', ['init', '-q'], { cwd: directory })
  for (const input of portable) await put(directory, input.path, '')
  let exit
  try { execFileSync('git', ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin'], { cwd: directory, input: paths(portable).join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'] }); exit = 0 }
  catch (error) { exit = error.status; assert.equal(error.stdout.length, 0) }
  assert.equal(exit, 1, 'a reviewed portable dependency is still ignored')
  for (const path of ['node_modules/unrelated/index.js', 'tools/container-manifest/node_modules/unrelated/index.js', 'unrelated/dist/index.js'])
    assert.equal(execFileSync('git', ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', path], { cwd: directory, encoding: 'utf8' }).trim(), path)
})

test('the actual matrix child loads the complete original CJS require graph from its archived portable closure', async t => {
  const setup = await fixture(t, importFormat + formatResult), result = await executeMatrixDriver(setup)
  assert.equal(result.status, 'executed', result.errors.join('\n'))
  assert.equal(result.process.exitCode, 0)
  assert.match(result.candidate.wxss, /color: red/)
  assert.match(result.candidate.wxml, /actual archive/)
  assert.deepEqual(result.cleanup, { ownedResourcesReleased: true, borrowedResourcesPreserved: true })
  assert.equal(result.inputs.filter(input => input.path.includes('/driver-inputs/' + packagePrefix)).length, 360)
})

test('changed archived CJS bytes fail before a replacement body executes and retain scoped disposal', async t => {
  const body = `await writeFile(new URL('./${packagePrefix}postcss/lib/parser.js',import.meta.url),"require('node:fs').writeFileSync("+JSON.stringify(__MARKER__)+",'changed body');module.exports={};");` + importFormat + formatResult
  const setup = await fixture(t, body), result = await executeMatrixDriver(setup)
  assert.equal(result.status, 'failed'); assert.match(result.errors.join('\n'), /input bytes differ/)
  assert.equal(result.cleanup.ownedResourcesReleased, true); await assertNoForeignBody(setup)
})

test('a missing declared transitive CJS module cannot execute from the original source tree', async t => {
  const setup = await fixture(t, importFormat + formatResult, { omit: input => input.path.endsWith('/domhandler/dist/node.js') })
  assert(setup.omitted.length > 0)
  const result = await executeMatrixDriver(setup)
  assert.equal(result.status, 'failed'); assert.match(result.errors.join('\n'), /Cannot find module|outside its snapshot closure/)
  assert.equal(result.cleanup.ownedResourcesReleased, true); await assertNoForeignBody(setup)
})

test('changed package metadata cannot redirect an archived CJS require into another graph', async t => {
  const body = `await writeFile(new URL('./${packagePrefix}postcss/node_modules/picocolors/package.json',import.meta.url),'{"name":"picocolors","main":"../../../../../../outside.js"}');` + importFormat + formatResult
  const setup = await fixture(t, body), result = await executeMatrixDriver(setup)
  assert.equal(result.status, 'failed'); assert.match(result.errors.join('\n'), /input bytes differ.*package.json/s)
  assert.equal(result.cleanup.ownedResourcesReleased, true); await assertNoForeignBody(setup)
})

test('a missing archived bare dependency cannot fall back to ambient root node_modules', async t => {
  const setup = await fixture(t, importFormat + formatResult, { omit: input => input.path.startsWith(packagePrefix + 'postcss/node_modules/picocolors/'), ambient: true })
  assert(setup.omitted.length > 0)
  const result = await executeMatrixDriver(setup)
  assert.equal(result.status, 'failed'); assert.match(result.errors.join('\n'), /outside its snapshot closure: picocolors/)
  assert.equal(result.cleanup.ownedResourcesReleased, true); await assertNoForeignBody(setup)
})

test('a require cache hit cannot retain a completed proof after its archived CJS input changes', async t => {
  const body = importFormat + `const require=createRequire(new URL('./${packagePrefix}postcss/lib/postcss.js',import.meta.url));const first=require('./parser');await writeFile(new URL('./${packagePrefix}postcss/lib/parser.js',import.meta.url),"require('node:fs').writeFileSync("+JSON.stringify(__MARKER__)+",'cached replacement');module.exports={};");require('./parser');` + formatResult
  const setup = await fixture(t, body), result = await executeMatrixDriver(setup)
  assert.equal(result.status, 'failed'); assert.match(result.errors.join('\n'), /input bytes differ|artifact hash\/size differs/)
  assert.equal(result.cleanup.ownedResourcesReleased, true); await assertNoForeignBody(setup)
})
