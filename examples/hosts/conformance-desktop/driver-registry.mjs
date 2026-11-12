#!/usr/bin/env node
/** Produce explicit immutable artifact references for the complete reviewed
 * driver import closure. This registry grants no native build or SDK evidence. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileReference } from './build.mjs'
import { collectorInputs } from './replay.mjs'
import { parseOptions } from './host-profile.mjs'

export async function createDriverRegistry(root, { hosts = ['macos'] } = {}) {
  if (!Array.isArray(hosts) || !hosts.length || new Set(hosts).size !== hosts.length || hosts.some(host => !['macos', 'linux'].includes(host))) {
    throw new Error('Explicit unique supported registry hosts required')
  }
  const inputs = await Promise.all(['./opaque-native-nodes.mjs', './issue826-replay.mjs', './issue826-static.mjs', './issue941-replay.mjs', './issue941-static.mjs', './issue1009-replay.mjs', './issue1009-static.mjs', '../../../conformance/recipes/issue1009-pure-read.mjs', './issue1008-replay.mjs', './issue1008-static.mjs', './issue1182-replay.mjs', './issue1182-static.mjs', './native-exception-channel.mjs', './host-profile.mjs', './template-multi-platform-sfc-replay.mjs', './template-multi-platform-sfc-static.mjs', './template-sfc-format-inputs.mjs', './collector-inputs.mjs', './template-multi-platform-replay.mjs', './template-multi-platform-static.mjs', './template-format-inputs.mjs', './build.mjs', './replay.mjs', './native-program.mjs', './wxml-replay.mjs', './wxml-static.mjs', './subpackage-replay.mjs', './subpackage-static.mjs', './ordered-plans-replay.mjs', './github-static-inputs.mjs', './web-runtime-replay.mjs', './web-runtime-static.mjs', './source-plan-replay.mjs', './import-meta-replay.mjs', './import-meta-static.mjs', './issue297-302-replay.mjs', './issue297-302-static.mjs', './source-plan-static.mjs', './issue1013-replay.mjs', './issue1013-static.mjs', './component-scope-family-replay.mjs', './issue547-static.mjs', './issue289-static.mjs', ...collectorInputs().map(value => value.path)]
    .map(path => fileReference(root, fileURLToPath(new URL(path, import.meta.url)))))
  inputs.push(...await Promise.all(['./issue1011-replay.mjs', './issue1011-static.mjs', '../../../conformance/recipes/issue1011-tap-source.mjs']
    .map(path => fileReference(root, fileURLToPath(new URL(path, import.meta.url))))))
  for (const collector of collectorInputs()) {
    const file = fileURLToPath(new URL(collector.path, import.meta.url))
    if ((await fileReference(root, file)).sha256 !== collector.sha256) throw new Error('Native registry collector differs from reviewed bytes')
  }
  const baseline = JSON.parse(await readFile(resolve(root, 'docs/conformance/baseline-v1.json'), 'utf8'))
  const drivers = []
  for (const host of hosts) {
    const module = await fileReference(root, fileURLToPath(new URL(host === 'linux' ? './linux-driver.mjs' : './driver.mjs', import.meta.url)))
    const closure = host === 'linux' ? [await fileReference(root, fileURLToPath(new URL('./driver.mjs', import.meta.url))), ...inputs] : inputs
    for (const engine of ['quickjs', 'v8']) drivers.push({ host, engine, module, inputs: closure, timeoutMs: 120000 })
  }
  return { schemaVersion: 1, kind: 'weapp-container-host-drivers', baselineId: baseline.id, drivers }
}

export function parseRegistryOptions(args) {
  const options = parseOptions(args, { values: ['--out'], repeat: ['--host'], required: ['--out'] })
  const hosts = options['--host'] ?? ['macos']
  if (hosts.some(host => !['macos', 'linux'].includes(host))) throw new Error('Explicit supported registry host required')
  return { output: options['--out'], hosts }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseRegistryOptions(process.argv.slice(2))
    const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
    await writeFile(resolve(root, options.output), JSON.stringify(await createDriverRegistry(root, { hosts: options.hosts }), null, 2) + '\n', { flag: 'wx' })
  } catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 }
}
