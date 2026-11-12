#!/usr/bin/env node
// Keep the SDK runtime notices separate from the immutable Cargo notice graph.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARMONY_RELEASE_FEATURES, inspectHarmonyHap, parseHarmonyMetadataJson } from './lib/harmony-artifact-contract.mjs'
import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const runtimePath = 'libs/arm64-v8a/libc++_shared.so'
const sdkRuntime = 'native/llvm/lib/aarch64-linux-ohos/libc++_shared.so'
const noticeName = 'OHOS-NATIVE-NOTICE.txt', sdkName = 'OHOS-NATIVE-SDK.json'
const hashPattern = /^[a-f0-9]{64}$/
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unreviewed platform notice identity fields')
const descriptor = (path, bytes) => ({ path, size: bytes.length, sha256: sha(bytes) })
function read(directory, path, maximum = 16 * 1024 * 1024) {
  assert.ok(!lstatSync(directory).isSymbolicLink(), 'Platform notice input directory cannot be a symlink')
  let current = realpathSync(directory)
  for (const part of path.split('/')) {
    assert.ok(part && part !== '..' && part !== '.' && !/[\\:\x00-\x1f]/.test(part))
    current = resolve(current, part)
    assert.ok(!lstatSync(current).isSymbolicLink(), 'Platform notice inputs cannot be symlinks')
  }
  const stat = lstatSync(current)
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= maximum, 'Bounded ordinary platform notice input required')
  const bytes = readFileSync(current); assert.equal(bytes.length, stat.size)
  return bytes
}
function sdkIdentity(bytes, compileSdk) {
  const sdk = parseHarmonyMetadataJson(bytes)
  keys(sdk, ['apiVersion', 'displayName', 'meta', 'path', 'releaseType', 'version'])
  keys(sdk.meta, ['metaVersion'])
  assert.equal(sdk.path, 'native'); assert.equal(sdk.displayName, 'Native'); assert.equal(sdk.releaseType, 'Release')
  assert.match(sdk.apiVersion, /^[1-9][0-9]{0,3}$/); assert.equal(Number(sdk.apiVersion), Number(compileSdk))
  assert.match(sdk.version, /^[0-9]+(?:\.[0-9]+){3}$/); assert.match(sdk.meta.metaVersion, /^[0-9]+(?:\.[0-9]+){2}$/)
  return { apiVersion: sdk.apiVersion, version: sdk.version }
}
function checkDescriptor(value, path, bytes) {
  keys(value, ['path', 'size', 'sha256'])
  assert.deepEqual(value, descriptor(path, bytes), 'Platform notice file digest/size mismatch')
}
function checkReport(report) {
  assert.equal(report.status, 'passed'); assert.equal(report.profile, 'release'); assert.equal(report.sdkVersion, SDK_RELEASE_VERSION)
  assert.equal(report.artifact.signing, 'unsigned'); assert.match(report.artifact.sha256, hashPattern)
  assert.equal(report.nativeRelease.profile, 'release'); assert.match(report.nativeRelease.sourceCommit, /^[a-f0-9]{40}$/)
  assert.equal(report.nativeRelease.target, 'aarch64-unknown-linux-ohos')
  assert.deepEqual([...report.nativeRelease.features].sort(), [...HARMONY_RELEASE_FEATURES].sort())
  for (const source of [report.sourceBefore, report.sourceAfter]) {
    assert.equal(source.sourceCommit, report.nativeRelease.sourceCommit); assert.equal(source.sourceDirty, false)
  }
}

export function verifyHarmonyPlatformNotices({ directory, report, reportSha256, identitySha256 }) {
  checkReport(report); assert.match(reportSha256, hashPattern)
  assert.ok(directory, 'The packaged OHOS C++ runtime requires its SDK platform notices')
  assert.match(identitySha256 ?? '', hashPattern, 'Independent SDK platform notice identity pin required')
  assert.deepEqual(readdirSync(directory).sort(), ['identity.json', noticeName, sdkName].sort(), 'Unreviewed platform notice closure')
  const identityBytes = read(directory, 'identity.json')
  assert.equal(sha(identityBytes), identitySha256, 'Independent SDK platform notice identity pin mismatch')
  const identity = parseHarmonyMetadataJson(identityBytes)
  keys(identity, ['schemaVersion', 'sdkVersion', 'sourceCommit', 'target', 'producerReportSha256', 'hapSha256', 'sdk', 'runtime', 'notice'])
  assert.equal(identity.schemaVersion, 1); assert.equal(identity.sdkVersion, SDK_RELEASE_VERSION)
  assert.equal(identity.sourceCommit, report.nativeRelease.sourceCommit); assert.equal(identity.target, report.nativeRelease.target)
  assert.equal(identity.producerReportSha256, reportSha256); assert.equal(identity.hapSha256, report.artifact.sha256)
  keys(identity.sdk, ['apiVersion', 'version', 'metadata'])
  const sdkBytes = read(directory, sdkName), sdk = sdkIdentity(sdkBytes, report.sdk.compileSdk)
  assert.equal(identity.sdk.apiVersion, sdk.apiVersion); assert.equal(identity.sdk.version, sdk.version)
  checkDescriptor(identity.sdk.metadata, sdkName, sdkBytes)
  const notice = read(directory, noticeName); checkDescriptor(identity.notice, noticeName, notice)
  keys(identity.runtime, ['path', 'size', 'sha256', 'sdkPath'])
  const member = report.artifact.members.find(value => value.path === runtimePath)
  assert.ok(member, 'Platform notices must belong to a packaged C++ runtime')
  assert.deepEqual(identity.runtime, { ...member, sdkPath: sdkRuntime }, 'SDK C++ runtime identity differs from HAP')
  return {
    identity,
    files: new Map([['platform-notices/identity.json', identityBytes], [`platform-notices/${noticeName}`, notice], [`platform-notices/${sdkName}`, sdkBytes]]),
  }
}

export function collectHarmonyPlatformNotices({ producerDirectory, sdkDirectory, outDirectory }) {
  const producer = realpathSync(producerDirectory), reportBytes = read(producer, 'build-report.json'), report = JSON.parse(reportBytes)
  checkReport(report)
  const sdk = realpathSync(sdkDirectory)
  assert.equal(sdk, realpathSync(report.sdk.source), 'Platform notice SDK must match the HAP producer SDK')
  const hap = realpathSync(report.artifact.path), hapRelative = relative(producer, hap)
  assert.ok(hapRelative && hapRelative !== '..' && !hapRelative.startsWith(`..${sep}`), 'HAP must belong to its producer run')
  const hapBytes = read(producer, hapRelative.split(sep).join('/'), 128 * 1024 * 1024)
  assert.equal(sha(hapBytes), report.artifact.sha256); assert.equal(hapBytes.length, report.artifact.bytes)
  assert.deepEqual(inspectHarmonyHap(hap, report.nativeRelease, { metadata: report.generatedMetadata ?? [] }), report.artifact.members)
  const runtime = read(sdk, sdkRuntime, 128 * 1024 * 1024), member = report.artifact.members.find(value => value.path === runtimePath)
  assert.ok(member, 'HAP does not redistribute the expected SDK C++ runtime')
  assert.deepEqual(member, descriptor(runtimePath, runtime), 'SDK libc++ runtime differs from the packaged HAP bytes')
  const notice = read(sdk, 'native/NOTICE.txt'), sdkBytes = read(sdk, 'native/oh-uni-package.json'), sdkVersion = sdkIdentity(sdkBytes, report.sdk.compileSdk)
  const identity = {
    schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, sourceCommit: report.nativeRelease.sourceCommit, target: report.nativeRelease.target,
    producerReportSha256: sha(reportBytes), hapSha256: report.artifact.sha256,
    sdk: { ...sdkVersion, metadata: descriptor(sdkName, sdkBytes) }, runtime: { ...member, sdkPath: sdkRuntime }, notice: descriptor(noticeName, notice),
  }
  const out = resolve(outDirectory)
  mkdirSync(dirname(out), { recursive: true }); mkdirSync(out)
  const identityBytes = json(identity)
  for (const [name, bytes] of [[noticeName, notice], [sdkName, sdkBytes], ['identity.json', identityBytes]]) writeFileSync(resolve(out, name), bytes, { flag: 'wx' })
  verifyHarmonyPlatformNotices({ directory: out, report, reportSha256: sha(reportBytes), identitySha256: sha(identityBytes) })
  return { status: 'collected-verified', directory: out, identitySha256: sha(identityBytes), identity }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), names = { '--producer': 'producerDirectory', '--sdk': 'sdkDirectory', '--out': 'outDirectory' }, options = {}
    for (let i = 0; i < args.length; i += 2) {
      assert.ok(names[args[i]] && args[i + 1] && !args[i + 1].startsWith('--') && !options[names[args[i]]], 'Unknown/missing/duplicate platform notice option')
      options[names[args[i]]] = args[i + 1]
    }
    assert.equal(Object.keys(options).length, 3, 'Explicit producer, SDK and new notice directory required')
    console.log(JSON.stringify(collectHarmonyPlatformNotices(options), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
