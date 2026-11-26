import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDevtoolsDownloadManifest, publishDevtoolsReleaseToR2 } from './devtools-r2-release.mjs'

const assets = [
  ['macos-arm64', 'weapp-container-devtools-macos-arm64.dmg'],
  ['macos-x86_64', 'weapp-container-devtools-macos-x86_64.dmg'],
  ['linux-x86_64', 'weapp-container-devtools-linux-x86_64.deb'],
  ['windows-x86_64', 'weapp-container-devtools-windows-x86_64.msi'],
]

async function createAssets(t) {
  const directory = await mkdtemp(join(tmpdir(), 'devtools-r2-release-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const lines = []
  const records = new Map()
  for (const [, filename] of assets) {
    const bytes = Buffer.from(`installer bytes for ${filename}`)
    await writeFile(join(directory, filename), bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    lines.push(`${sha256}  ${filename}`)
    records.set(filename, { sha256, size: bytes.length })
  }
  await writeFile(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  return { directory, records }
}

test('release manifest contains only supported installers with verified GitHub hashes', async t => {
  const { directory, records } = await createAssets(t)
  const manifest = await createDevtoolsDownloadManifest({
    assetsDirectory: directory,
    version: '0.1.0-preview.7.4',
    tag: 'devtools-v0.1.0-preview.7.4',
    baseUrl: 'https://download.container.weapp.dev/',
  })

  assert.equal(manifest.schemaVersion, 3)
  assert.equal(manifest.manifestUrl, 'https://download.container.weapp.dev/devtools/latest.json')
  assert.equal(manifest.checksumsUrl, 'https://github.com/weapp-container/weapp-container/releases/download/devtools-v0.1.0-preview.7.4/SHA256SUMS')
  assert.deepEqual(manifest.platforms.map(platform => platform.id), assets.map(([id]) => id))
  for (const platform of manifest.platforms) {
    const asset = records.get(platform.installer.filename)
    assert.equal(platform.installer.size, asset.size)
    assert.equal(platform.installer.sha256, asset.sha256)
    assert.match(platform.installer.url, /download\.container\.weapp\.dev\/devtools\/releases\/devtools-v0\.1\.0-preview\.7\.4\//)
    assert.match(platform.installer.githubUrl, /github\.com\/weapp-container\/weapp-container\/releases\/download\/devtools-v0\.1\.0-preview\.7\.4\//)
  }
})

test('R2 publication validates uploaded objects before publishing the latest manifest and pruning', async t => {
  const { directory, records } = await createAssets(t)
  const commands = []
  const runAws = async args => {
    commands.push(args)
    if (args[0] === 's3api' && args[1] === 'head-object') {
      const key = args[args.indexOf('--key') + 1]
      const filename = key.split('/').at(-1)
      const expected = filename === 'latest.json'
        ? { size: Buffer.byteLength(await readFile(join(directory, 'latest.json'), 'utf8')), sha256: createHash('sha256').update(await readFile(join(directory, 'latest.json'))).digest('hex') }
        : records.get(filename)
      return { stdout: JSON.stringify({ ContentLength: expected.size, Metadata: { sha256: expected.sha256 } }) }
    }
    return { stdout: '' }
  }

  const manifest = await publishDevtoolsReleaseToR2({
    assetsDirectory: directory,
    version: '0.1.0-preview.7.4',
    tag: 'devtools-v0.1.0-preview.7.4',
    baseUrl: 'https://download.container.weapp.dev',
    accountId: '0123456789abcdef0123456789abcdef',
    bucket: 'weapp-container-devtools-downloads',
    runAws,
  })

  const latestUpload = commands.findIndex(args => args[0] === 's3' && args[1] === 'cp' && args[3] === 's3://weapp-container-devtools-downloads/devtools/latest.json')
  const prune = commands.findIndex(args => args[0] === 's3' && args[1] === 'rm')
  assert.equal(latestUpload > 0, true)
  assert.equal(prune > latestUpload, true)
  assert.deepEqual(commands.at(-1).slice(0, 5), ['s3', 'rm', 's3://weapp-container-devtools-downloads/devtools/releases/', '--recursive', '--exclude'])
  assert.equal(commands.at(-1)[5], 'devtools-v0.1.0-preview.7.4/*')
  assert.equal(manifest.platforms.length, 4)
})

test('R2 publication leaves existing releases untouched when an uploaded object fails verification', async t => {
  const { directory } = await createAssets(t)
  let latestPublished = false
  let pruned = false
  const runAws = async args => {
    if (args[0] === 's3api' && args[1] === 'head-object') {
      return { stdout: JSON.stringify({ ContentLength: 1, Metadata: { sha256: '0'.repeat(64) } }) }
    }
    if (args[0] === 's3' && args[1] === 'cp' && args[3]?.endsWith('/devtools/latest.json')) latestPublished = true
    if (args[0] === 's3' && args[1] === 'rm') pruned = true
    return { stdout: '' }
  }

  await assert.rejects(publishDevtoolsReleaseToR2({
    assetsDirectory: directory,
    version: '0.1.0-preview.7.4',
    tag: 'devtools-v0.1.0-preview.7.4',
    baseUrl: 'https://download.container.weapp.dev',
    accountId: '0123456789abcdef0123456789abcdef',
    bucket: 'weapp-container-devtools-downloads',
    runAws,
  }), /R2 object verification failed/)
  assert.equal(latestPublished, false)
  assert.equal(pruned, false)
})

test('release manifest rejects mismatched local SHA256SUMS and unsafe release identifiers', async t => {
  const { directory } = await createAssets(t)
  await writeFile(join(directory, 'SHA256SUMS'), '0'.repeat(64) + '  ' + assets[0][1] + '\n')
  await assert.rejects(createDevtoolsDownloadManifest({
    assetsDirectory: directory,
    version: '0.1.0-preview.7.4',
    tag: 'devtools-v0.1.0-preview.7.4',
    baseUrl: 'https://download.container.weapp.dev',
  }), /SHA-256 mismatch/)
  await assert.rejects(createDevtoolsDownloadManifest({
    assetsDirectory: directory,
    version: '../latest',
    tag: 'devtools-v../latest',
    baseUrl: 'https://download.container.weapp.dev',
  }), /version and tag do not match/)
})
