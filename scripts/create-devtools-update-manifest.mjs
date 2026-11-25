#!/usr/bin/env node
import { createHash, sign } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalUpdatePayload, verifyUpdateManifest } from './lib/devtools-update.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}

export async function createUpdateManifest({ assetsDirectory, version, tag, privateKey, publicKey }) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Stable update manifest requires a stable semantic version')
  if (!/^devtools-v\d+\.\d+\.\d+$/.test(tag || '')) throw new Error('Invalid stable DevTools release tag')
  if (!privateKey || !publicKey) throw new Error('Stable update signing requires private and public keys')
  const targetAssets = new Map([
    ['weapp-container-devtools-macos-arm64.dmg', { target: 'macos-arm64', arch: 'arm64' }],
    ['weapp-container-devtools-macos-x86_64.dmg', { target: 'macos-x86_64', arch: 'x64' }],
    ['weapp-container-devtools-linux-x86_64.deb', { target: 'linux-x86_64', arch: 'x64' }],
    ['weapp-container-devtools-windows-x86_64.msi', { target: 'windows-x86_64', arch: 'x64' }],
  ])
  const available = new Set(await readdir(assetsDirectory))
  const releases = []
  for (const [filename, platform] of targetAssets) {
    if (!available.has(filename)) throw new Error(`Missing installer asset ${filename}`)
    const bytes = await readFile(join(assetsDirectory, filename))
    releases.push({
      version,
      ...platform,
      url: `https://github.com/weapp-container/weapp-container/releases/download/${tag}/${filename}`,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  const unsigned = { schemaVersion: 1, channel: 'stable', releases }
  const signature = sign(null, Buffer.from(canonicalUpdatePayload(unsigned)), privateKey).toString('base64url')
  const manifest = { ...unsigned, signature }
  verifyUpdateManifest(manifest, { publicKey })
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = resolve(option('--output', join(root, 'artifacts/devtools-release/updates.json')))
    const manifest = await createUpdateManifest({
      assetsDirectory: resolve(option('--assets', join(root, 'artifacts'))),
      version: option('--version', process.env.GITHUB_REF_NAME?.replace(/^devtools-v/, '')),
      tag: option('--tag', process.env.GITHUB_REF_NAME),
      privateKey: process.env.WEAPP_DEVTOOLS_UPDATE_PRIVATE_KEY,
      publicKey: process.env.WEAPP_DEVTOOLS_UPDATE_PUBLIC_KEY,
    })
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`)
    process.stdout.write(`${output}\n`)
  } catch (error) {
    process.stderr.write(`create-devtools-update-manifest: ${error.message}\n`)
    process.exitCode = 1
  }
}
