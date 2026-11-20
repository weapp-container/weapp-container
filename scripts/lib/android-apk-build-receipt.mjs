import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { inspectEvidenceSource } from '../evidence-source.mjs'

const COMMIT = /^[0-9a-f]{40}$/
const HASH = /^[0-9a-f]{64}$/
const ANDROID_SOURCE = 'examples/hosts/android'
const RECEIPT_INPUTS = [
  'scripts/build-android-apk.mjs',
  'scripts/lib/android-apk-build-receipt.mjs',
  'scripts/mobile-runtime-smoke.mjs',
  'scripts/pack-execution-evidence.mjs',
]

export function sourceInventorySha256(files) {
  const ordered = [...files].map(({ path, sha256 }) => ({ path, sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path))
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

function expectedSourceFiles(root) {
  const projectFiles = execFileSync('git', ['ls-files', '--', ANDROID_SOURCE], {
    cwd: root,
    encoding: 'utf8',
  }).split(/\r?\n/).filter(Boolean)
  return [...new Set([...projectFiles, ...RECEIPT_INPUTS])].sort()
}

function inspectSourceFiles(root, files) {
  if (!Array.isArray(files) || files.length === 0) return { status: 'incomplete', reason: 'source file inventory is missing' }
  const paths = files.map(file => file?.path)
  if (paths.some(path => typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).includes('..'))
    || new Set(paths).size !== paths.length) {
    return { status: 'incomplete', reason: 'source file inventory has invalid or duplicate paths' }
  }
  if (JSON.stringify([...paths].sort()) !== JSON.stringify(expectedSourceFiles(root))) {
    return { status: 'incomplete', reason: 'source file inventory does not cover the tracked Android project and receipt inputs' }
  }
  const verified = []
  for (const file of files) {
    const absolute = resolve(root, file.path)
    if (!absolute.startsWith(`${resolve(root)}${sep}`)) return { status: 'incomplete', reason: 'source file escapes the checkout' }
    try {
      if (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) {
        return { status: 'incomplete', reason: `source file is not a regular file: ${file.path}` }
      }
      const actual = createHash('sha256').update(readFileSync(absolute)).digest('hex')
      if (!HASH.test(file.sha256 || '') || actual !== file.sha256) {
        return { status: 'incomplete', reason: `source file digest changed: ${file.path}` }
      }
      verified.push(file)
    } catch {
      return { status: 'incomplete', reason: `source file is unavailable: ${file.path}` }
    }
  }
  return { status: 'passed', sha256: sourceInventorySha256(verified) }
}

export function inspectAndroidApkBuildReceipt(receipt, expected) {
  const root = resolve(expected.root)
  const sourceRevision = inspectEvidenceSource(root, receipt?.sourceCommit, expected.expectedSourceCommit)
  const native = receipt?.native
  const nativeSourceRevision = inspectEvidenceSource(root, native?.sourceCommit, expected.expectedSourceCommit)
  const sourceFiles = inspectSourceFiles(root, receipt?.sourceFiles)
  const checks = {
    schema: receipt?.schemaVersion === 1 && receipt?.scope === 'android-apk-build',
    status: receipt?.status === 'passed',
    host: receipt?.host === 'android',
    engine: receipt?.engine === expected.engine,
    source: COMMIT.test(receipt?.sourceCommit || '') && sourceRevision.compatible
      && native?.sourceCommit === receipt?.sourceCommit && nativeSourceRevision.compatible,
    cleanSource: receipt?.workingTreeDirty === false && native?.workingTreeDirty === false,
    sourceFiles: sourceFiles.status === 'passed'
      && HASH.test(receipt?.sourceInventorySha256 || '')
      && sourceFiles.sha256 === receipt.sourceInventorySha256,
    nativeBuild: native?.status === 'passed' && native?.host === 'android'
      && native?.engine === expected.engine && native?.abi === 'arm64-v8a'
      && HASH.test(native?.artifactSha256 || ''),
    gradle: receipt?.gradle?.status === 'passed' && receipt?.gradle?.variant === 'debug',
    gradleNativeInput: receipt?.gradle?.nativeInputArtifactSha256 === native?.artifactSha256,
    gradleStrippedNative: HASH.test(receipt?.gradle?.strippedNativeArtifactSha256 || '')
      && receipt?.package?.strippedNativeArtifactSha256 === receipt.gradle.strippedNativeArtifactSha256,
    packagedNative: receipt?.package?.status === 'passed'
      && receipt.package.abi === 'arm64-v8a'
      && receipt.package.nativeArtifactSha256 === native?.artifactSha256
      && HASH.test(receipt.package.strippedNativeArtifactSha256 || '')
      && receipt.package.embeddedNativeArtifactSha256 === receipt.package.strippedNativeArtifactSha256,
    artifact: HASH.test(expected.artifactSha256 || '') && receipt?.apk?.sha256 === expected.artifactSha256,
  }
  const missing = Object.keys(checks).filter(name => !checks[name])
  return {
    status: missing.length === 0 ? 'passed' : 'incomplete',
    sourceCommit: receipt?.sourceCommit || null,
    artifactSha256: receipt?.apk?.sha256 || null,
    sourceRevision,
    nativeSourceRevision,
    sourceFiles,
    checks,
    missing,
  }
}
