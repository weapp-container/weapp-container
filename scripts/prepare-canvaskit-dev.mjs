#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RENDERER_DEPENDENCY_PINS } from './build-web-wasm.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export function rendererConfig() {
  const resource = key => ({ ...RENDERER_DEPENDENCY_PINS[key], url: `/renderer-assets/${RENDERER_DEPENDENCY_PINS[key].url}` })
  return { schemaVersion: 1, renderer: 'canvaskit', fallback: 'error',
    canvaskit: { version: '0.42.0', variant: 'full', javascript: resource('javascript'), wasm: resource('wasm'),
      license: resource('license'), package: resource('package') },
    font: { binary: resource('font'), license: resource('fontLicense') } }
}

export async function prepareCanvasKitDev({ canvasKitDir, fontFile, fontLicenseFile, outDir }) {
  if (![canvasKitDir, fontFile, fontLicenseFile, outDir].every(value => typeof value === 'string' && value))
    throw new Error('Expected --canvaskit-dir, --font-file, --font-license-file and --out-dir')
  const output = resolve(outDir)
  try { await lstat(output); throw new Error(`Output already exists: ${output}`) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  // Verify every input before allocating an output directory. No downloader or
  // implicit installer is involved; these pins are shared with the WASM builder.
  const inputs = []
  for (const [key, pin] of Object.entries(RENDERER_DEPENDENCY_PINS)) {
    const path = key === 'font' ? fontFile : key === 'fontLicense' ? fontLicenseFile : resolve(canvasKitDir, pin.input)
    const bytes = await readFile(path)
    if (bytes.length !== pin.size || digest(bytes) !== pin.sha256) throw new Error(`Pinned renderer integrity mismatch: ${key}`)
    inputs.push({ key, pin, bytes })
  }
  await mkdir(dirname(output), { recursive: true })
  const temporary = `${output}.preparing-${randomUUID()}`
  await mkdir(temporary)
  try {
    for (const { pin, bytes } of inputs) {
      const path = resolve(temporary, pin.url)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes, { flag: 'wx' })
    }
    await writeFile(resolve(temporary, 'runtime-config.json'), `${JSON.stringify(rendererConfig(), null, 2)}\n`, { flag: 'wx' })
    await rename(temporary, output)
    return { schemaVersion: 1, status: 'prepared', output, renderer: 'canvaskit-webgl2',
      files: inputs.map(({ key, pin }) => ({ key, path: pin.url, sha256: pin.sha256, size: pin.size })),
      limitation: 'Verified dependency bytes only; no browser, GPU or performance acceptance.' }
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const names = new Map([['--canvaskit-dir', 'canvasKitDir'], ['--font-file', 'fontFile'], ['--font-license-file', 'fontLicenseFile'], ['--out-dir', 'outDir']])
  try {
    const options = {}
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names.get(process.argv[index]), value = process.argv[index + 1]
      if (!key || !value || value.startsWith('--')) throw new Error(`Invalid option: ${process.argv[index]}`)
      options[key] = value
    }
    console.log(JSON.stringify(await prepareCanvasKitDev(options), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
