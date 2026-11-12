#!/usr/bin/env node
// Independent Web/Harmony distribution families. No build, install on a device,
// signing or publication to an external release is performed here.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { inspectBrowserRuntimeProducer } from './browser-dev-artifacts.mjs'
import { WEB_SAMPLE_FILES, loadFrozenPackValidator } from './build-web-wasm.mjs'
import { inspectHarmonyHap, HARMONY_RELEASE_FEATURES } from './lib/harmony-artifact-contract.mjs'
import { verifyHarmonyPlatformNotices } from './harmony-platform-notices.mjs'
import { SDK_RELEASE_VERSION, captureNativeSource } from './lib/sdk-current-release.mjs'
import { isNoticeFileName } from './lib/sdk-notice.mjs'
import { assertDistributionIdentity, distributionIdentity } from './lib/showcase-policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const hashPattern = /^[a-f0-9]{64}$/
function safe(path) {
  assert.ok(typeof path === 'string' && path.length < 4096 && path.length && !path.startsWith('/') && !/[\\:\x00-\x20\x7f]/.test(path) && path.split('/').every(value => value && value !== '.' && value !== '..'), 'Unsafe platform artifact path')
  return path
}
const descriptor = (path, bytes) => ({ path, size: bytes.length, sha256: sha(bytes) })
function read(base, path, expected) {
  safe(path)
  const location = resolve(base, path), stat = lstatSync(location)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && realpathSync(location) === location && stat.size <= 128 * 1024 * 1024, `Not a bounded ordinary artifact: ${path}`)
  const bytes = readFileSync(location)
  if (expected) { assert.ok(hashPattern.test(expected.sha256)); assert.equal(sha(bytes), expected.sha256, `Artifact digest mismatch: ${path}`); assert.equal(bytes.length, expected.size ?? expected.bytes, `Artifact length mismatch: ${path}`) }
  return bytes
}
function notices(directory, expected, packageName, target, features) {
  const result = new Map(), bytes = read(directory, 'licenses.json'), value = JSON.parse(bytes)
  assert.equal(value.schemaVersion, 1); assert.equal(value.package, packageName); assert.equal(value.target, target)
  assert.deepEqual([...value.features].sort(), [...features].sort()); assert.equal(value.source?.sourceCommit, expected.sourceCommit); assert.equal(value.source.sourceDirty, false)
  assert.ok(value.packages?.length, 'Complete dependency notices are required')
  result.set('licenses/licenses.json', bytes)
  for (const pkg of value.packages) {
    assert.ok(pkg.files?.length, `Dependency notices missing: ${pkg.name}`)
    for (const file of pkg.files) {
      assert.ok(isNoticeFileName(basename(file.path)), 'Notice inventory contains an implementation file')
      const content = read(directory, file.path)
      assert.equal(sha(content), file.sha256, 'Dependency notice changed')
      const path = `licenses/${safe(file.path)}`
      assert.ok(!result.has(path), 'Duplicate dependency notice'); result.set(path, content)
    }
  }
  return result
}
function toolIdentity() {
  const paths = ['scripts/platform-runtime-archives.mjs', 'scripts/browser-dev-artifacts.mjs', 'scripts/build-web-wasm.mjs', 'scripts/generated-package-closure.mjs', 'examples/hosts/web-wasm/renderer-dependency-pins.json', 'scripts/lib/harmony-artifact-contract.mjs', 'scripts/harmony-platform-notices.mjs', 'scripts/lib/sdk-current-release.mjs', 'scripts/lib/sdk-native-features.mjs', 'scripts/lib/sdk-notice.mjs', 'scripts/lib/showcase-policy.mjs', 'sdk/contract/tools/unpack-runtime.py']
  return { ...captureNativeSource(root), files: paths.map(path => descriptor(path, readFileSync(resolve(root, path)))) }
}

export async function preparePlatformArtifact({ family, producerDirectory, expected, licensesDirectory, platformNoticesDirectory, runtimeLicenseFile }) {
  assert.ok(['web', 'harmony'].includes(family)); assert.match(expected?.sourceCommit ?? '', /^[a-f0-9]{40}$/)
  assert.ok(hashPattern.test(expected.reportSha256) && hashPattern.test(expected.runtimeLicenseSha256), 'Independent producer report and runtime license pins are required')
  const base = realpathSync(producerDirectory), reportBytes = read(base, 'build-report.json')
  assert.equal(sha(reportBytes), expected.reportSha256, 'Independent release receipt pin mismatch')
  const report = JSON.parse(reportBytes), files = new Map()
  const distribution = assertDistributionIdentity(report, expected)
  let coordinate, execution, renderer, source, target, features, selected
  if (family === 'web') {
    assert.ok(!platformNoticesDirectory, 'OHOS SDK platform notices belong only to Harmony')
    assert.ok(['worker', 'legacy'].includes(expected.execution), 'An explicit Worker/direct producer mode is required')
    const state = await inspectBrowserRuntimeProducer(base, expected)
    assert.equal(report.plan.profile, 'release'); assert.equal(report.plan.target, 'wasm32-unknown-unknown')
    if (report.sdkVersion !== undefined) assert.equal(report.sdkVersion, SDK_RELEASE_VERSION, 'Producer SDK preview version differs from distribution')
    assert.deepEqual([...report.plan.features].sort(), ['quickjs-native', 'wasm', ...(distribution.distributionProfile === 'restricted-showcase' ? ['restricted-showcase'] : [])].sort()); assert.ok(report.commands.length && report.commands.every(value => value.status === 'passed')); assert.equal(Object.keys(report.customBuildEnvironment ?? {}).length, 0)
    execution = expected.execution === 'legacy' ? 'direct' : 'worker'; renderer = expected.renderer
    coordinate = `web/${execution}/${renderer}${distribution.distributionProfile === 'restricted-showcase' ? '/restricted-showcase' : ''}`; source = { sourceCommit: expected.sourceCommit, sourceSha256: expected.sourceSha256, sourceDirty: false }; target = report.plan.target; features = report.plan.features
    selected = [...WEB_SAMPLE_FILES, ...report.generatedPackage.files.map(file => file.path), 'runtime-config.json', ...report.rendererDependencies.files.map(file => file.url)]
    for (const path of selected) { assert.ok(state.retained.has(path)); files.set(path, state.retained.get(path)) }
    const keep = (path, value) => { assert.ok(!files.has(path), 'Duplicate Web delivery member'); files.set(path, read(base, path, value)) }
    keep('browser-assets.json', report.browserAssets.inventory)
    keep('pack-index.json', report.packIndex)
    assert.deepEqual(JSON.parse(files.get('pack-index.json')), report.pack)
    keep('portable-pack/manifest.json', { sha256: report.pack.manifestSha256, size: lstatSync(resolve(base, 'portable-pack/manifest.json')).size })
    for (const blob of report.pack.blobs) {
      assert.equal(blob.url, `portable-pack/blobs/sha256/${blob.sha256}`); keep(blob.url, blob)
    }
    for (const file of report.browserAssets.generatedFiles ?? []) {
      assert.ok(['worker-product-config.mjs', 'worker-product-config.json'].includes(file.path), 'Unexpected generated browser entry')
      keep(file.path, file)
    }
    if (report.workerStartupIntent) keep('worker-startup-intent.json', report.workerStartupIntent)
    // Full manifest/schema/reference validation uses the byte-verified frozen
    // validator and a private temporary destination, never mutating the producer.
    const scratch = resolve(realpathSync(tmpdir()), `.archive-pack-check-${randomUUID()}`)
    try {
      const validator = await loadFrozenPackValidator(state.source)
      const checked = await validator.syncPortablePack({ source: resolve(base, 'portable-pack'), destination: scratch })
      assert.equal(checked.integrityRoot, report.pack.integrityRoot)
      assert.deepEqual(checked.files.map(path => `portable-pack/${path}`).sort(), [...files.keys()].filter(path => path.startsWith('portable-pack/')).sort())
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  } else {
    assert.equal(distribution.distributionProfile, 'full', 'Restricted Harmony has no current producer contract')
    assert.equal(report.schemaVersion, 1); assert.equal(report.status, 'passed'); assert.equal(report.profile, 'release'); assert.equal(report.sdkVersion, SDK_RELEASE_VERSION)
    assert.equal(report.sourceBefore?.sourceCommit, expected.sourceCommit); assert.equal(report.sourceAfter?.sourceCommit, expected.sourceCommit)
    assert.equal(report.sourceBefore.sourceDirty, false); assert.equal(report.sourceAfter.sourceDirty, false)
    assert.equal(report.nativeRelease?.profile, 'release'); assert.equal(report.nativeRelease.sourceCommit, expected.sourceCommit)
    assert.equal(report.nativeRelease.target, 'aarch64-unknown-linux-ohos'); assert.deepEqual([...report.nativeRelease.features].sort(), [...HARMONY_RELEASE_FEATURES].sort())
    assert.ok(hashPattern.test(report.nativeRelease.receiptSha256)); assert.ok(report.commands?.some(value => value.name === 'hvigor') && report.commands.every(value => value.code === 0))
    assert.equal(report.artifact?.signing, 'unsigned'); assert.deepEqual(report.protocols, { hostServices: '1.0', nativeBridge: '1.0' })
    const hapPath = realpathSync(report.artifact.path), rel = relative(base, hapPath)
    assert.ok(rel && !rel.startsWith(`..${sep}`) && rel !== '..', 'HAP artifact must be inside its producer run')
    const hap = read(base, rel, report.artifact)
    assert.deepEqual(inspectHarmonyHap(hapPath, report.nativeRelease, { metadata: report.generatedMetadata ?? [] }), report.artifact.members)
    files.set('application-unsigned.hap', hap)
    if (report.artifact.members.some(value => value.path === 'libs/arm64-v8a/libc++_shared.so')) {
      const platform = verifyHarmonyPlatformNotices({ directory: platformNoticesDirectory, report, reportSha256: expected.reportSha256, identitySha256: expected.platformNoticesSha256 })
      for (const [path, bytes] of platform.files) files.set(path, bytes)
    } else assert.ok(!platformNoticesDirectory, 'Platform notices cannot claim a runtime absent from the HAP')
    coordinate = 'harmony/arm64/unsigned'; source = { sourceCommit: expected.sourceCommit, sourceDirty: false }; target = report.nativeRelease.target; features = report.nativeRelease.features
  }
  for (const [path, bytes] of notices(licensesDirectory, expected, family === 'web' ? 'container-host-web' : 'container-host-harmony', target, features)) files.set(path, bytes)
  const license = read(dirname(realpathSync(runtimeLicenseFile)), basename(runtimeLicenseFile))
  assert.equal(sha(license), expected.runtimeLicenseSha256); files.set('RUNTIME-LICENSE', license)
  for (const path of files.keys()) {
    safe(path)
    assert.ok(!/^(?:source|commands|raw|validation|cargo-target|project)\//.test(path) && !/\.(?:rs|cpp|cc|ets)$/.test(path), 'Private producer source is forbidden in delivery')
  }
  const receipt = { schemaVersion: 1, scope: 'platform-runtime-distribution', sdkVersion: SDK_RELEASE_VERSION, family, coordinate, source, target, features, ...distribution,
    ...(execution ? { execution, producerExecution: expected.execution, renderer, entry: report.plan.entry } : { signing: 'unsigned', nativeRelease: report.nativeRelease }),
    producerReceipt: { sha256: sha(reportBytes), size: reportBytes.length }, archiveTool: toolIdentity(),
    protocols: { hostServices: '1.0', ...(family === 'harmony' ? { nativeBridge: '1.0' } : { wasmBindgen: report.toolchain.versions.wasmBindgen }) },
    protocolVerification: 'source and compiled export boundary; runtime handshake requires independent acceptance',
    versionBinding: report.sdkVersion ? 'producer-and-distribution' : 'explicit-distribution-version; historical producer does not record SDK preview version',
    acceptance: { compile: 'passed', archive: 'pending', runtime: 'pending', hardware: 'pending' },
    files: [...files].map(([path, bytes]) => descriptor(path, bytes)).sort((a, b) => a.path.localeCompare(b.path)) }
  files.set('release-receipt.json', json(receipt))
  return { family, coordinate, files, receipt }
}

const tarProgram = `import gzip,json,sys,tarfile
from pathlib import Path
j=json.load(sys.stdin)
with open(j['archive'],'xb') as raw:
 with gzip.GzipFile(fileobj=raw,mode='wb',mtime=0,filename='') as gz:
  with tarfile.open(fileobj=gz,mode='w') as tar:
   for p in j['files']:
    f=Path(j['root'])/p;i=tarfile.TarInfo(p);i.size=f.stat().st_size;i.mode=0o644
    with f.open('rb') as s:tar.addfile(i,s)`

export async function buildPlatformArchive(options) {
  const planned = await preparePlatformArtifact(options), out = resolve(options.outDirectory), base = realpathSync(options.producerDirectory)
  assert.ok(!out.startsWith(`${base}${sep}`) && out !== base && !base.startsWith(`${out}${sep}`), 'Output must be separate from producer')
  mkdirSync(dirname(out), { recursive: true })
  assert.equal(realpathSync(dirname(out)), dirname(out), 'Use a canonical output parent')
  const stage = resolve(dirname(out), `.platform-archive-${randomUUID()}`); mkdirSync(stage)
  let owned
  const linked = [], same = (a, b) => a.dev === b.dev && a.ino === b.ino
  try {
    const payload = resolve(stage, 'payload'); mkdirSync(payload)
    for (const [path, bytes] of planned.files) { mkdirSync(dirname(resolve(payload, path)), { recursive: true }); writeFileSync(resolve(payload, path), bytes, { flag: 'wx' }) }
    const fileName = `${planned.coordinate.replaceAll('/', '-')}-${SDK_RELEASE_VERSION}.tar.gz`, archive = resolve(stage, fileName)
    const made = spawnSync(process.env.PYTHON ?? 'python3', ['-c', tarProgram], { input: JSON.stringify({ archive, root: payload, files: [...planned.files.keys()].sort() }), encoding: 'utf8' })
    assert.equal(made.status, 0, 'Platform archive writer failed')
    const bytes = readFileSync(archive), records = [...planned.files].map(([path, bytes]) => descriptor(path, bytes)).sort((a, b) => a.path.localeCompare(b.path))
    const identity = distributionIdentity(planned.receipt)
    const artifact = { coordinate: planned.coordinate, fileName, size: bytes.length, sha256: sha(bytes), sourceCommit: options.expected.sourceCommit, producerReportSha256: options.expected.reportSha256, ...identity, files: records }
    const manifest = { schemaVersion: 1, format: 'weapp-container-platform-artifacts/1', runtimeVersion: SDK_RELEASE_VERSION, family: planned.family, ...identity, artifacts: [artifact] }
    const verify = resolve(stage, 'verified'), checked = spawnSync(process.env.PYTHON ?? 'python3', [resolve(root, 'sdk/contract/tools/unpack-runtime.py'), '--archive', archive, '--destination', verify, '--sha256', artifact.sha256, '--identity-json', JSON.stringify({ runtimeVersion: SDK_RELEASE_VERSION, family: planned.family, coordinate: planned.coordinate })], { encoding: 'utf8' })
    assert.equal(checked.status, 0, 'Independent bounded unpack failed')
    const installed = JSON.parse(readFileSync(resolve(verify, '.runtime-install.json'))).files.filter(value => value.sha256).map(value => ({ path: value.path, size: value.size, sha256: value.sha256 })).sort((a, b) => a.path.localeCompare(b.path))
    assert.deepEqual(installed, records, 'Extracted delivery bytes differ from manifest')
    const marker = `${planned.family}-runtime-artifacts.lock.json`
    writeFileSync(resolve(stage, marker), json(manifest)); writeFileSync(resolve(stage, 'SHA256SUMS'), `${artifact.sha256}  ${fileName}\n`)
    // Exclusive creation and hard links never replace an existing destination.
    mkdirSync(out); owned = lstatSync(out)
    for (const name of [fileName, 'SHA256SUMS', marker]) {
      assert.ok(same(lstatSync(out), owned), 'Output ownership changed during publication')
      const source = resolve(stage, name), destination = resolve(out, name)
      linkSync(source, destination); linked.push({ destination, identity: lstatSync(source) })
    }
    return { outDirectory: out, manifest, receipt: planned.receipt }
  } catch (error) {
    if (owned) {
      try {
        if (same(lstatSync(out), owned)) {
          for (const file of linked) if (same(lstatSync(file.destination), file.identity)) unlinkSync(file.destination)
          rmdirSync(out)
        }
      } catch (cleanup) { error.message += `; output cleanup requires review: ${cleanup.code ?? cleanup.message}` }
    }
    throw error
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

export function installPlatformArchive({ manifestPath, expectedManifestSha256, artifactDirectory, coordinate, destination, expectedDistribution }) {
  assert.ok(hashPattern.test(expectedManifestSha256), 'Independent exact platform manifest pin is required')
  const manifestBytes = readFileSync(manifestPath)
  assert.equal(sha(manifestBytes), expectedManifestSha256, 'Platform manifest pin mismatch')
  const manifest = JSON.parse(manifestBytes)
  const identity = assertDistributionIdentity(manifest, expectedDistribution)
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.format, 'weapp-container-platform-artifacts/1'); assert.equal(manifest.runtimeVersion, SDK_RELEASE_VERSION)
  assert.ok(['web', 'harmony'].includes(manifest.family) && Array.isArray(manifest.artifacts))
  const selected = manifest.artifacts.filter(value => value.coordinate === coordinate)
  assert.equal(selected.length, 1, 'Select one exact platform coordinate')
  const artifact = selected[0]
  assertDistributionIdentity(artifact, identity)
  assert.equal(basename(artifact.fileName), safe(artifact.fileName)); assert.ok(coordinate.startsWith(`${manifest.family}/`))
  read(realpathSync(artifactDirectory), artifact.fileName, artifact)
  const target = resolve(destination)
  try { lstatSync(target); throw Error('Platform acceptance requires a new installation directory') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const checked = spawnSync(process.env.PYTHON ?? 'python3', [resolve(root, 'sdk/contract/tools/unpack-runtime.py'), '--archive', resolve(artifactDirectory, artifact.fileName), '--destination', target, '--sha256', artifact.sha256, '--identity-json', JSON.stringify({ runtimeVersion: SDK_RELEASE_VERSION, family: manifest.family, coordinate })], { encoding: 'utf8' })
  assert.equal(checked.status, 0, 'Platform installation failed')
  const owned = lstatSync(target)
  try {
    const installed = JSON.parse(readFileSync(resolve(target, '.runtime-install.json'))).files.filter(value => value.sha256).map(value => ({ path: value.path, size: value.size, sha256: value.sha256 })).sort((a, b) => a.path.localeCompare(b.path))
    assert.deepEqual(installed, artifact.files, 'Platform installed closure differs from pinned manifest')
    const receipt = JSON.parse(readFileSync(resolve(target, 'release-receipt.json')))
    assertDistributionIdentity(receipt, identity)
    assert.equal(receipt.source.sourceCommit, artifact.sourceCommit); assert.equal(receipt.producerReceipt.sha256, artifact.producerReportSha256)
    assert.equal(receipt.coordinate, coordinate); assert.equal(receipt.family, manifest.family)
    return { status: 'installed-verified', destination: target, coordinate, archiveSha256: artifact.sha256, manifestSha256: sha(manifestBytes), scope: 'Pinned byte installation only; runtime and hardware acceptance remain separate' }
  } catch (error) {
    try {
      const actual = lstatSync(target)
      if (actual.dev !== owned.dev || actual.ino !== owned.ino) throw Error('Installation ownership changed')
      rmSync(target, { recursive: true })
    } catch (cleanup) { error.message += `; installation cleanup requires review: ${cleanup.code ?? cleanup.message}` }
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), values = {}, installing = args.includes('--install'), keys = installing
      ? { '--manifest': 'manifestPath', '--manifest-sha256': 'expectedManifestSha256', '--artifact-dir': 'artifactDirectory', '--coordinate': 'coordinate', '--install': 'destination', '--distribution-profile': 'distributionProfile', '--policy-sha256': 'policySha256' }
      : { '--family': 'family', '--producer': 'producerDirectory', '--pins': 'pins', '--licenses': 'licensesDirectory', '--platform-notices': 'platformNoticesDirectory', '--runtime-license': 'runtimeLicenseFile', '--out': 'outDirectory' }
    for (let i = 0; i < args.length; i += 2) { assert.ok(keys[args[i]] && args[i + 1] && !args[i + 1].startsWith('--') && values[keys[args[i]]] === undefined, 'Unknown/missing/duplicate platform archive option'); values[keys[args[i]]] = args[i + 1] }
    const required = installing ? ['manifestPath', 'expectedManifestSha256', 'artifactDirectory', 'coordinate', 'destination'] : ['family', 'producerDirectory', 'pins', 'licensesDirectory', 'runtimeLicenseFile', 'outDirectory']
    assert.ok(required.every(key => values[key]), 'Explicit family, producer, pins, licenses, runtime license and new output are required')
    if (installing) {
      const expectedDistribution = distributionIdentity({ distributionProfile: values.distributionProfile, policySha256: values.policySha256 })
      console.log(JSON.stringify(installPlatformArchive({ ...values, expectedDistribution })))
    }
    else {
      const result = await buildPlatformArchive({ ...values, expected: JSON.parse(readFileSync(values.pins)) })
      console.log(JSON.stringify({ status: 'prepared-not-published', outDirectory: result.outDirectory, coordinate: result.manifest.artifacts[0].coordinate }))
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
