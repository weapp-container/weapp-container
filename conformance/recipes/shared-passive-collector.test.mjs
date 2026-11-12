/** Explicit provenance regressions for the shared module extraction.
 * No compiler, SDK, original case, or expected rendered value is used. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readConformanceRecipes, prepareConformanceRecipe, createRuntimeTraceCollector } from '../../scripts/conformance-recipes.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const corePath = 'conformance/recipes/passive-collector-core.mjs'
const index = JSON.parse(await readFile(resolve(root, 'docs/conformance/case-index-v1.json'), 'utf8'))
async function registry(issue) {
  const file = resolve(root, `conformance/recipes/issue${issue}-v1.json`)
  const loaded = await readConformanceRecipes({ root, index, file })
  return { file, recipe: loaded.get(`ide-github-issues-runtime-issue${issue}`) }
}
async function directory(t) {
  await mkdir(resolve(root, 'artifacts'), { recursive: true })
  const path = await mkdtemp(resolve(root, 'artifacts/shared-passive-unit-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('both case registries bind the complete adapter, shared core and builtin-only query context closure', async () => {
  const core = await readFile(resolve(root, corePath), 'utf8')
  const coreImports = [...core.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map(([, path]) => `conformance/recipes/${path.slice(2)}`)
  assert.deepEqual(coreImports,['conformance/recipes/passive-query-context.mjs'])
  const context = await readFile(resolve(root,coreImports[0]),'utf8')
  assert.ok([...context.matchAll(/from\s+['"]([^'"]+)['"]/gu)].every(([,path])=>path.startsWith('node:')))
  for (const issue of ['1012', '1014']) {
    const { recipe } = await registry(issue)
    const source = await readFile(resolve(root, recipe.collector.path), 'utf8')
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map(([, path]) =>
      `conformance/recipes/${path.slice(2)}`)
    assert.deepEqual(recipe.collectorInputs.map(value => value.path), [...imports,...coreImports])
    assert.equal(imports.filter(path => path === corePath).length, 1)
  }
})

test('omitting the shared input stays rejected by the unchanged production snapshot loader', async t => {
  const base = await directory(t)
  for (const issue of ['1012', '1014']) {
    const { recipe } = await registry(issue)
    const prepared = await prepareConformanceRecipe({ root, directory: resolve(base, issue),
      recipe: { ...recipe, collectorInputs: recipe.collectorInputs.filter(ref => ref.path !== corePath) } })
    await assert.rejects(createRuntimeTraceCollector({ recipePath: prepared.runtimeRecipePath,
      outputFile: resolve(base, issue, 'unreachable-events.json') }), /outside its snapshot closure/u)
  }
})

test('a wrong shared input identity stays rejected before recipe preparation', async t => {
  const base = await directory(t)
  for (const issue of ['1012', '1014']) {
    const { file } = await registry(issue)
    const document = JSON.parse(await readFile(file, 'utf8'))
    document.recipes[0].collectorInputs.find(ref => ref.path === corePath).sha256 = '0'.repeat(64)
    const forged = resolve(base, `${issue}-forged.json`)
    await writeFile(forged, JSON.stringify(document))
    await assert.rejects(readConformanceRecipes({ root, index, file: forged }), /hash|identity/u)
  }
})
