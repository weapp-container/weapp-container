#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants, createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateIOSAppEvidence, validateIOSEmbeddingEvidence } from './validate-ios-app-evidence.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
// These are the inputs to the Rust staticlib, Swift executable and its build
// command. An unrelated dirty submodule cannot give a new identity to these
// bytes, and edits during compilation invalidate the build receipt.
const INPUTS = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo', 'crates',
  'examples/hosts/ios', 'examples/hosts/ios-app', 'scripts/ios-app-smoke', 'scripts/ios-embedding-smoke',
  'scripts/ios-app-execution-evidence.mjs', 'scripts/sync-ios-portable-pack.mjs', 'scripts/portable-pack.mjs',
  'scripts/ios-simulator-apps.mjs', 'scripts/ios-app-screen.mjs', 'scripts/ios-app-startup.mjs',
  'scripts/ios-app-resource-cleanup.mjs', 'scripts/validate-ios-app-evidence.mjs']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
const ENGINE_FEATURES = { quickjs: 'quickjs-native-ios', v8: 'v8-native' }

/** --target-dir overrides both Cargo's environment and its config file. */
export function iosCargoTargetDirectory(root, environment = process.env) {
  return resolve(root, environment.CARGO_TARGET_DIR || 'target')
}

/** Select only the staticlib emitted for this host/build, never a nearby cache. */
export function selectIOSCargoArchive(messages, { root = ROOT, targetDir, target, engine }) {
  if (!ENGINE_FEATURES[engine] || !/^[A-Za-z0-9_-]+$/.test(target || '') || !targetDir) {
    throw new Error('explicit iOS engine, target and Cargo target directory required')
  }
  const records = messages.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
  const completion = records.filter(record => record.reason === 'build-finished')
  if (completion.length !== 1 || completion[0].success !== true) throw new Error('Cargo did not report one successful completed build')
  const expected = resolve(targetDir, target, 'debug/libcontainer_host_ios.a')
  const candidates = records.filter(record => record.reason === 'compiler-artifact'
    && record.target?.name === 'container_host_ios'
    && record.target?.crate_types?.includes('staticlib'))
  if (candidates.length !== 1) throw new Error('Cargo did not emit exactly one iOS host staticlib artifact')
  const artifact = candidates[0]
  const features = artifact.features || []
  if (resolve(artifact.manifest_path || '') !== resolve(root, 'crates/container-host-ios/Cargo.toml')
      || resolve(artifact.target.src_path || '') !== resolve(root, 'crates/container-host-ios/src/lib.rs')
      || !['ios', 'metal', ENGINE_FEATURES[engine]].every(feature => features.includes(feature))
      || features.includes(ENGINE_FEATURES[engine === 'quickjs' ? 'v8' : 'quickjs'])
      || features.includes('quickjs-native')) {
    throw new Error('Cargo staticlib source or selected engine/features differs from this build')
  }
  const archives = (artifact.filenames || []).filter(path => path.endsWith('.a')).map(path => resolve(path))
  if (archives.length !== 1 || archives[0] !== expected) throw new Error('Cargo staticlib path differs from the explicit target directory/target')
  return { path: expected, target, engine, features, packageId: artifact.package_id, fresh: artifact.fresh === true }
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Freeze the linker input so a later Cargo build cannot replace that archive. */
export async function prepareIOSLinkArchive({ root = ROOT, outDir, cargoMessagesPath, targetDir, target, engine }) {
  const messages = readFileSync(cargoMessagesPath, 'utf8')
  const selected = selectIOSCargoArchive(messages, { root, targetDir, target, engine })
  const before = await hashFile(selected.path)
  const linkedPath = resolve(outDir, 'native-input/libcontainer_host_ios.a')
  await mkdir(resolve(outDir, 'native-input'), { recursive: true })
  // COPYFILE_FICLONE uses an independent APFS copy when possible, with a
  // normal copy fallback. A hard link would retain a mutable Cargo alias.
  await copyFile(selected.path, linkedPath, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
  const [after, copied, metadata] = await Promise.all([hashFile(selected.path), hashFile(linkedPath), stat(linkedPath)])
  if (before !== after || before !== copied) throw new Error('Cargo staticlib changed while freezing the exact linker input')
  return {
    schemaVersion: 1, status: 'passed', artifactKind: 'rust-staticlib-link-input',
    ...selected, linkedPath, sha256: copied, bytes: metadata.size,
    targetDir: resolve(targetDir), cargoMessagesPath: resolve(cargoMessagesPath),
    cargoMessagesSha256: sha256(messages),
  }
}

export async function verifyIOSLinkArchive(receipt, engine) {
  if (receipt?.schemaVersion !== 1 || receipt.status !== 'passed' || receipt.engine !== engine
      || receipt.artifactKind !== 'rust-staticlib-link-input' || !receipt.linkedPath
      || !/^[0-9a-f]{64}$/.test(receipt.sha256 || '') || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0) {
    throw new Error('verified exact iOS staticlib linker input is required')
  }
  const metadata = await stat(receipt.linkedPath)
  if (metadata.size !== receipt.bytes || await hashFile(receipt.linkedPath) !== receipt.sha256) {
    throw new Error('iOS staticlib linker input changed during Swift linking/signing')
  }
  return receipt
}

export function captureIOSBuildSource(root = ROOT) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...INPUTS]).split('\0').filter(Boolean))].sort()
  const sourceFiles = Object.fromEntries(files.map(path => [path, sha256(readFileSync(resolve(root, path)))]))
  return {
    sourceCommit: git(['rev-parse', 'HEAD']).trim(),
    sourceSha256: sha256(JSON.stringify(sourceFiles)),
    workingTreeDirty: Boolean(git(['status', '--porcelain', '--untracked-files=all', '--', ...INPUTS]).trim()),
    workingTreeScope: INPUTS, sourceFiles,
  }
}

export function finishIOSBuild(before, after, artifact, engine, nativeArchive, appMode = 'smoke') {
  if (!['quickjs', 'v8'].includes(engine)) throw new Error('invalid iOS engine')
  if (!['smoke', 'embedding'].includes(appMode)) throw new Error('invalid iOS app mode')
  if (nativeArchive?.status !== 'passed' || nativeArchive.engine !== engine
      || !/^[0-9a-f]{64}$/.test(nativeArchive.sha256 || '') || !nativeArchive.linkedPath) {
    throw new Error('verified exact iOS staticlib linker input is required')
  }
  if (before.sourceCommit !== after.sourceCommit || before.sourceSha256 !== after.sourceSha256) {
    throw new Error('iOS source changed during compilation; refusing a build receipt')
  }
  return {
    schemaVersion: 1, status: before.workingTreeDirty || after.workingTreeDirty ? 'unknown' : 'passed',
    host: 'ios', engine, appMode, sourceCommit: before.sourceCommit, sourceSha256: before.sourceSha256,
    workingTreeDirty: before.workingTreeDirty || after.workingTreeDirty,
    workingTreeScope: before.workingTreeScope, artifactSha256: sha256(artifact),
    artifactKind: 'signed-mach-o-executable',
    nativeArchive,
  }
}

export function collectIOSExecution(probe, manifest, build, target, fixtureId) {
  const appMode = build?.appMode ?? 'smoke'
  if (!['smoke', 'embedding'].includes(appMode)) throw new Error('invalid iOS build mode')
  const surface = appMode === 'embedding' ? validateIOSEmbeddingEvidence(probe, manifest) : validateIOSAppEvidence(probe, manifest)
  if (!fixtureId || target?.host !== 'ios' || !['official-simulator', 'device'].includes(target.kind) || !target.id) {
    throw new Error('explicit fixture and iOS execution target required')
  }
  if (build?.host !== 'ios' || build.engine !== probe.engine || !/^[0-9a-f]{64}$/.test(build.artifactSha256 ?? '')) {
    throw new Error('iOS executable build identity missing or engine mismatch')
  }
  const surfaceProbe = Object.fromEntries(Object.entries(probe).filter(([key]) => !['operations', 'startup', 'gpuProbe'].includes(key)))
  return {
    schemaVersion: 1,
    fixture: { id: fixtureId, sourceCommit: build.sourceCommit, manifest },
    receipts: [{ host: 'ios', engine: probe.engine, status: probe.status,
      sourceCommit: build.sourceCommit, artifactSha256: build.artifactSha256, build, target,
      fixtureId, manifestIntegrity: manifest.integrity.root, sessionId: probe.sessionId,
      route: surface.route, operations: probe.operations, surfaceProbe }],
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, out, ...args] = process.argv.slice(2)
    if (operation === 'target-dir') process.stdout.write(`${iosCargoTargetDirectory(out, { CARGO_TARGET_DIR: args[0] })}\n`)
    else if (operation === 'begin') write(resolve(out, 'source-before.json'), captureIOSBuildSource())
    else if (operation === 'archive') {
      const [cargoMessagesPath, targetDir, target, engine] = args
      const receipt = await prepareIOSLinkArchive({ outDir: out, cargoMessagesPath, targetDir, target, engine })
      write(resolve(out, 'native-archive.json'), receipt)
      process.stdout.write(`${receipt.linkedPath}\n`)
    } else if (operation === 'finish') {
      const archive = await verifyIOSLinkArchive(read(resolve(out, 'native-archive.json')), args[1])
      write(resolve(out, 'build.json'), finishIOSBuild(read(resolve(out, 'source-before.json')),
        captureIOSBuildSource(), readFileSync(args[0]), args[1], archive, args[2] ?? 'smoke'))
    } else if (operation === 'collect') {
      const [manifestPath, udid, fixtureId] = args
      const build = read(resolve(out, 'build.json'))
      const probe = read(resolve(out, 'evidence.json'))
      if (sha256(readFileSync(resolve(out, 'frame.png'))) !== probe.drawableReadback?.pngSha256) {
        throw new Error('actual GPU drawable PNG is missing or has another digest')
      }
      write(resolve(out, 'execution-evidence.json'), { sourceCommit: build.sourceCommit, executionEvidence: collectIOSExecution(
        probe, read(manifestPath), build,
        { host: 'ios', kind: 'official-simulator', id: udid }, fixtureId) })
    } else throw new Error('usage: ios-app-execution-evidence.mjs target-dir|begin|archive|finish|collect <output-dir/root> [...]')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
