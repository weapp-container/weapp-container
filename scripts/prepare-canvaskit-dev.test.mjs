import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareCanvasKitDev, rendererConfig } from './prepare-canvaskit-dev.mjs'
import { RENDERER_DEPENDENCY_PINS } from './build-web-wasm.mjs'

test('dev renderer preparation shares the standalone builder integrity pins and fixed URLs', () => {
  const config = rendererConfig()
  for (const [key, value] of Object.entries({ ...config.canvaskit, font: config.font.binary, fontLicense: config.font.license })) {
    const pin = RENDERER_DEPENDENCY_PINS[key]
    if (!pin) continue
    assert.equal(value.sha256, pin.sha256); assert.equal(value.size, pin.size)
    assert.equal(value.url, `/renderer-assets/${pin.url}`)
  }
  assert.equal(config.renderer, 'canvaskit'); assert.equal(config.fallback, 'error')
})

test('dev renderer preparation rejects bad dependency bytes before creating output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weapp-renderer-assets-'))
  try {
    await mkdir(join(root, 'sdk/bin/full'), { recursive: true })
    await writeFile(join(root, 'sdk/bin/full/canvaskit.js'), 'unverified')
    const outDir = join(root, 'out')
    await assert.rejects(prepareCanvasKitDev({ canvasKitDir: join(root, 'sdk'), fontFile: join(root, 'font'), fontLicenseFile: join(root, 'license'), outDir }), /integrity mismatch/)
    await assert.rejects(access(outDir), { code: 'ENOENT' })
    await mkdir(outDir)
    await assert.rejects(prepareCanvasKitDev({ canvasKitDir: 'missing', fontFile: 'missing', fontLicenseFile: 'missing', outDir }), /already exists/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
