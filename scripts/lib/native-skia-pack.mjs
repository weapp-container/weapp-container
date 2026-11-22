import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { canonicalize } from '../../tools/container-manifest/src/json-integrity.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export async function adaptNativeSkiaPack(pack) {
  const manifestPath = resolve(pack, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath))
  if (manifest.schemaVersion !== 3 || !Array.isArray(manifest.routes) || manifest.integrity?.algorithm !== 'sha256') {
    throw new Error('Native Skia packaging requires a schema v3 pack with rendering routes and SHA-256 integrity')
  }
  const sourceRendering = manifest.rendering ?? null
  const pages = Object.fromEntries(manifest.routes.map(route => [route.path, 'skia']))
  manifest.rendering = { version: '1.0', default: 'skia', pages }
  const unsigned = structuredClone(manifest)
  unsigned.integrity.root = ''
  manifest.integrity.root = sha256(Buffer.from(canonicalize(unsigned)))
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return {
    source: sourceRendering,
    effective: manifest.rendering,
    manifestSha256: sha256(await readFile(manifestPath)),
    integrityRoot: manifest.integrity.root,
  }
}
