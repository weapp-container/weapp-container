import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runFile = promisify(execFile)
const installableAssets = [
  { id: 'macos-arm64', filename: 'weapp-container-devtools-macos-arm64.dmg' },
  { id: 'macos-x86_64', filename: 'weapp-container-devtools-macos-x86_64.dmg' },
  { id: 'linux-x86_64', filename: 'weapp-container-devtools-linux-x86_64.deb' },
  { id: 'windows-x86_64', filename: 'weapp-container-devtools-windows-x86_64.msi' },
]
const githubReleaseBase = 'https://github.com/weapp-container/weapp-container/releases/download'

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function parseChecksums(contents) {
  const checksums = new Map()
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue
    const match = line.match(/^([a-f0-9]{64})[ \t]+[* ]?(.+)$/)
    if (!match || checksums.has(match[2])) throw new Error(`Invalid or duplicate checksum entry: ${line}`)
    checksums.set(match[2], match[1])
  }
  return checksums
}

function releasePath(version, tag) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || tag !== `devtools-v${version}`) {
    throw new Error('Release version and tag do not match')
  }
  return tag
}

function publicBaseUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('R2 public base URL must be a plain HTTPS URL')
  }
  return url.href.replace(/\/$/, '')
}

export async function createDevtoolsDownloadManifest({ assetsDirectory, version, tag, baseUrl }) {
  const releaseTag = releasePath(version, tag)
  const base = publicBaseUrl(baseUrl)
  const checksums = parseChecksums(await readFile(join(assetsDirectory, 'SHA256SUMS'), 'utf8'))
  const platforms = []

  for (const asset of installableAssets) {
    const path = join(assetsDirectory, asset.filename)
    const actualSha256 = await sha256File(path)
    const expectedSha256 = checksums.get(asset.filename)
    if (!expectedSha256 || actualSha256 !== expectedSha256) {
      throw new Error(`SHA-256 mismatch for ${asset.filename}`)
    }

    platforms.push({
      id: asset.id,
      installer: {
        filename: asset.filename,
        size: (await stat(path)).size,
        sha256: actualSha256,
        url: `${base}/devtools/releases/${releaseTag}/${asset.filename}`,
        githubUrl: `${githubReleaseBase}/${releaseTag}/${asset.filename}`,
      },
    })
  }

  return {
    schemaVersion: 3,
    version,
    tag: releaseTag,
    manifestUrl: `${base}/devtools/latest.json`,
    checksumsUrl: `${githubReleaseBase}/${releaseTag}/SHA256SUMS`,
    platforms,
  }
}

async function defaultRunAws(args) {
  return runFile('aws', args, {
    env: {
      ...process.env,
      AWS_DEFAULT_REGION: 'auto',
      AWS_EC2_METADATA_DISABLED: 'true',
    },
    maxBuffer: 10 * 1024 * 1024,
  })
}

function expectObjectHead(output, expectedSize, expectedSha256, filename) {
  let metadata
  try {
    metadata = JSON.parse(output)
  } catch {
    throw new Error(`R2 returned invalid metadata for ${filename}`)
  }
  if (metadata.ContentLength !== expectedSize || metadata.Metadata?.sha256 !== expectedSha256) {
    throw new Error(`R2 object verification failed for ${filename}`)
  }
}

export async function publishDevtoolsReleaseToR2({
  assetsDirectory,
  version,
  tag,
  baseUrl,
  accountId,
  bucket,
  runAws = defaultRunAws,
}) {
  const releaseTag = releasePath(version, tag)
  const base = publicBaseUrl(baseUrl)
  if (!/^[a-f0-9]{32}$/.test(accountId || '')) throw new Error('R2 account ID must be 32 lowercase hexadecimal characters')
  if (!/^[a-z0-9-]+$/.test(bucket || '')) throw new Error('R2 bucket name is invalid')

  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`
  const manifest = await createDevtoolsDownloadManifest({ assetsDirectory, version, tag: releaseTag, baseUrl: base })
  const manifestPath = join(assetsDirectory, 'latest.json')
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(manifestPath, manifestBytes)

  // Bucket CORS is configured once outside CI so the upload token only needs object access.
  for (const platform of manifest.platforms) {
    const installer = platform.installer
    const key = `devtools/releases/${releaseTag}/${installer.filename}`
    await runAws([
      's3', 'cp', join(assetsDirectory, installer.filename), `s3://${bucket}/${key}`,
      '--endpoint-url', endpoint,
      '--content-type', 'application/octet-stream',
      '--content-disposition', `attachment; filename="${installer.filename}"`,
      '--cache-control', 'public,max-age=31536000,immutable',
      '--metadata', `sha256=${installer.sha256}`,
      '--only-show-errors',
    ])

    const head = await runAws([
      's3api', 'head-object', '--bucket', bucket, '--key', key,
      '--endpoint-url', endpoint,
      '--output', 'json',
    ])
    expectObjectHead(head.stdout, installer.size, installer.sha256, installer.filename)
  }

  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  await runAws([
    's3', 'cp', manifestPath, `s3://${bucket}/devtools/latest.json`,
    '--endpoint-url', endpoint,
    '--content-type', 'application/json',
    '--cache-control', 'no-cache,max-age=0,must-revalidate',
    '--metadata', `sha256=${manifestSha256}`,
    '--only-show-errors',
  ])
  const manifestHead = await runAws([
    's3api', 'head-object', '--bucket', bucket, '--key', 'devtools/latest.json',
    '--endpoint-url', endpoint,
    '--output', 'json',
  ])
  expectObjectHead(manifestHead.stdout, Buffer.byteLength(manifestBytes), manifestSha256, 'latest.json')

  await runAws([
    's3', 'rm', `s3://${bucket}/devtools/releases/`,
    '--recursive', '--exclude', `${releaseTag}/*`,
    '--endpoint-url', endpoint,
    '--only-show-errors',
  ])

  return manifest
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function main() {
  const assetsDirectory = resolve(root, option('--assets') || '')
  const version = option('--version')
  const tag = option('--tag')
  const baseUrl = option('--base-url')
  const accountId = process.env.R2_ACCOUNT_ID
  const bucket = 'weapp-container-devtools-downloads'
  if (!version || !tag || !baseUrl || !option('--assets')) {
    throw new Error('Usage: node scripts/devtools-r2-release.mjs --assets <dir> --version <version> --tag <tag> --base-url <https-url>')
  }

  const manifest = await publishDevtoolsReleaseToR2({
    assetsDirectory,
    version,
    tag,
    baseUrl,
    accountId,
    bucket,
  })
  process.stdout.write(`${JSON.stringify({ status: 'published', version, bucket, assets: manifest.platforms.length })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  })
}
