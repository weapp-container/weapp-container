#!/usr/bin/env node
/** Explicit investigation entry. Results never become a formal matrix pair. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDriver } from './driver.mjs'
import { verifyReference } from './build.mjs'
import { buildEnvironmentKey, hostProfile, parseOptions, requireEngine } from './host-profile.mjs'

export function parseDiagnoseOptions(args, root) {
  const options = parseOptions(args, { values: ['--build', '--engine', '--out', '--recipes', '--case', '--host', '--presenter'], required: ['--build', '--engine', '--out'] })
  const host = options['--host'] ?? 'macos', presenter = options['--presenter']
  hostProfile({ host, presenter })
  return { host, presenter, engine: requireEngine(options['--engine']), build: resolve(root, options['--build']),
    outputDirectory: resolve(root, options['--out']), recipes: resolve(root, options['--recipes'] ?? 'conformance/recipes/issue1058-v1.json'),
    caseId: options['--case'] ?? 'ide-issue-1058-template-tags-runtime' }
}

async function diagnose(args) {
  const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
  const options = parseDiagnoseOptions(args, root)
  const profile = hostProfile(options), { engine, outputDirectory } = options
  const driver = createDriver(options)
  process.env[buildEnvironmentKey(profile, engine)] = options.build
  let created = false
  try {
    await mkdir(outputDirectory)
    created = true
    const registry = JSON.parse(await readFile(options.recipes, 'utf8'))
    const recipe = registry.recipes.find(recipe => recipe.caseId === options.caseId)
    if (!recipe?.fixture || !recipe.resources || recipe.fixtureProfile) throw new Error('Native diagnosis requires a concrete captured execution recipe; an authored captured-static descriptor cannot supply a fixture')
    recipe.fixtureValue = JSON.parse(await readFile(await verifyReference(root, recipe.fixture), 'utf8'))
    const controller = new AbortController()
    const abort = () => controller.abort()
    process.once('SIGINT', abort); process.once('SIGTERM', abort)
    try {
      const candidate = await driver.runDiagnostic({ root, outputDirectory, recipe,
        job: { caseId: recipe.caseId, sourceSha256: recipe.sourceSha256, host: options.host, engine }, signal: controller.signal })
      await writeFile(resolve(outputDirectory, 'diagnostic.json'), JSON.stringify({ schemaVersion: 1, diagnosticOnly: true,
        status: 'observed', formalMatrixAdmitted: false, candidate }, null, 2) + '\n', { flag: 'wx' })
      process.stdout.write(`Observed native ${options.host}/${engine}; diagnostic only: ${outputDirectory}\n`)
    } finally {
      process.off('SIGINT', abort); process.off('SIGTERM', abort)
    }
  } finally {
    if (created) await driver.dispose({ outputDirectory })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await diagnose(process.argv.slice(2)) }
  catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 }
}
