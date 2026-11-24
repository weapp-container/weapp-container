import { createPublicKey, verify } from 'node:crypto'

export const UPDATE_MANIFEST_SCHEMA_VERSION = 1

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+)\.(\d+))?$/.exec(value || '')
  if (!match) return null
  return match.slice(1).map(part => part === undefined ? Number.MAX_SAFE_INTEGER : Number(part))
}

function validateRelease(release) {
  if (!release || typeof release !== 'object') throw new Error('Malformed update release')
  if (!versionParts(release.version) || release.version.includes('-preview')) throw new Error('Stable update manifest contains a non-stable version')
  if (typeof release.target !== 'string' || !/^[a-z0-9_-]+$/.test(release.target)) throw new Error('Invalid update target')
  if (release.arch !== undefined && !['arm64', 'x64'].includes(release.arch)) throw new Error('Invalid update architecture')
  let url
  try { url = new URL(release.url) } catch { throw new Error('Invalid update asset URL') }
  if (url.protocol !== 'https:') throw new Error('Update asset URL must use HTTPS')
  if (!Number.isSafeInteger(release.size) || release.size <= 0) throw new Error('Invalid update asset size')
  if (!/^[a-f0-9]{64}$/.test(release.sha256 || '')) throw new Error('Invalid update asset SHA-256')
}

export function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  if (!a || !b) throw new Error('Unsupported update version')
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

export function verifyUpdateManifest(input, { publicKey } = {}) {
  if (!input || input.schemaVersion !== UPDATE_MANIFEST_SCHEMA_VERSION) throw new Error('Unsupported update manifest schema')
  if (input.channel !== 'stable' || !Array.isArray(input.releases) || input.releases.length === 0) throw new Error('Malformed stable update manifest')
  for (const release of input.releases) validateRelease(release)
  if (typeof input.signature !== 'string' || !publicKey) throw new Error('Signed update manifest is required')
  const { signature, ...unsigned } = input
  let signatureBytes
  try { signatureBytes = Buffer.from(signature, 'base64url') } catch { throw new Error('Invalid update manifest signature') }
  if (!signatureBytes.length || !verify(null, Buffer.from(canonical(unsigned)), createPublicKey(publicKey), signatureBytes)) {
    throw new Error('Update manifest signature verification failed')
  }
  return unsigned
}

export function selectUpdate(manifest, { version, target, arch = process.arch }) {
  const candidates = manifest.releases
    .filter(release => release.target === target && (!release.arch || release.arch === arch))
    .filter(release => typeof release.version === 'string' && compareVersions(release.version, version) > 0)
    .sort((left, right) => compareVersions(right.version, left.version))
  return candidates[0] || null
}

export async function checkForUpdate({ metadata, fetchImpl = fetch }) {
  const update = metadata?.update
  if (!update?.manifestUrl || !update.publicKey || !metadata.version || !metadata.target) return { status: 'disabled' }
  if (new URL(update.manifestUrl).protocol !== 'https:') throw new Error('Update manifest URL must use HTTPS')
  const response = await fetchImpl(update.manifestUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`Update manifest request failed: HTTP ${response.status}`)
  if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('Update manifest redirect must use HTTPS')
  const manifest = verifyUpdateManifest(await response.json(), { publicKey: update.publicKey })
  const candidate = selectUpdate(manifest, { version: metadata.version, target: metadata.target })
  return { status: candidate ? 'available' : 'current', candidate }
}

export function canonicalUpdatePayload(value) {
  return canonical(value)
}
