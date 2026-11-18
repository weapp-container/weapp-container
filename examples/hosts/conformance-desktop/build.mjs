#!/usr/bin/env node
/** Exact executable provenance. Dirty builds remain diagnostic and cannot be
 * admitted by driver.mjs. Unrelated SDK/submodule edits are outside this Rust
 * executable's source scope, and are neither reset nor silently rebound. */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBinaryHeader, assertFeatures, engineFeatures, hostProfile, parseOptions, profileForRuntime, profileForTarget, requireEngine } from './host-profile.mjs'

export const SOURCE_SCOPE = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo', 'crates', 'examples/hosts/conformance-desktop']
const hash = value => createHash('sha256').update(value).digest('hex')
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const require = (condition, message) => { if (!condition) throw new Error(message) }

export async function fileReference(root, file) {
  const path = relative(root, resolve(file)).replaceAll('\\', '/')
  require(path && !isAbsolute(path) && !path.split('/').some(part => !part || part === '.' || part === '..'), 'Build artifact must be inside source root')
  let current = root
  for (const part of path.split('/')) {
    current = resolve(current, part)
    require(!(await lstat(current)).isSymbolicLink(), 'Build artifact paths must not contain symlinks')
  }
  const info = await stat(current)
  require(info.isFile() && info.size <= 1024 ** 3, 'Build artifact must be a bounded regular file')
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(current)) digest.update(chunk)
  return { path, sha256: digest.digest('hex'), bytes: info.size }
}

export async function verifyReference(root, reference) {
  require(reference && Object.keys(reference).sort().join(',') === 'bytes,path,sha256', 'Malformed native artifact reference')
  const actual = await fileReference(root, resolve(root, reference.path))
  require(actual.path === reference.path && actual.sha256 === reference.sha256 && actual.bytes === reference.bytes, 'Native artifact bytes differ from build receipt')
  return resolve(root, actual.path)
}

export async function captureSource(root) {
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  require(await realpath(git(['rev-parse', '--show-toplevel']).trim()) === await realpath(root), 'Native build root must be the repository root')
  const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SOURCE_SCOPE]).split('\0').filter(Boolean))].sort()
  require(files.includes('examples/hosts/conformance-desktop/Cargo.lock'), 'Exact native example Cargo.lock is required')
  const sourceFiles = Object.fromEntries(await Promise.all(files.map(async path => {
    const reference = await fileReference(root, resolve(root, path))
    return [path, reference.sha256]
  })))
  return { sourceCommit: git(['rev-parse', 'HEAD']).trim(), sourceSha256: hash(JSON.stringify(sourceFiles)),
    sourceFiles, workingTreeScope: SOURCE_SCOPE,
    workingTreeDirty: Boolean(git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...SOURCE_SCOPE]).trim()) }
}

export function selectExecutable(messages, { root, targetDir, target, engine, host = 'macos', presenter, exceptionChannel = false }) {
  requireEngine(engine)
  const profile = profileForTarget({ host, presenter, target })
  const lines = messages.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
  const finished = lines.filter(line => line.reason === 'build-finished')
  require(finished.length === 1 && finished[0].success === true, 'Cargo did not finish exactly one successful build')
  const candidates = lines.filter(line => line.reason === 'compiler-artifact' && line.target?.name === 'weapp-conformance-desktop' && line.target.kind?.includes('bin'))
  require(candidates.length === 1, 'Cargo did not emit exactly one conformance native executable')
  const artifact = candidates[0]
  assertFeatures(profile, engine, artifact.features, { exceptionChannel })
  const expected = resolve(targetDir, target, 'debug/weapp-conformance-desktop')
  require(resolve(artifact.manifest_path ?? '') === resolve(root, 'examples/hosts/conformance-desktop/Cargo.toml')
    && resolve(artifact.target.src_path ?? '') === resolve(root, 'examples/hosts/conformance-desktop/src/main.rs')
    && resolve(artifact.executable ?? '') === expected, 'Cargo executable source, engine features or output path differs')
  return { path: expected, features: artifact.features, packageId: artifact.package_id, fresh: artifact.fresh === true }
}

async function verifyExecutableHeader(executable, profile) {
  const binary = await open(executable, 'r')
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await binary.read(header, 0, header.length, 0)
    assertBinaryHeader(header.subarray(0, bytesRead), profile)
  } finally { await binary.close() }
}

export async function verifyBuild(root, receipt, engine, { source = true, diagnostic = false, host = 'macos', presenter, target } = {}) {
  require(receipt?.schemaVersion === 1 && receipt.kind === 'weapp-conformance-native-build'
    && (receipt.status === 'passed' && receipt.workingTreeDirty === false
      || diagnostic && receipt.status === 'diagnostic' && typeof receipt.workingTreeDirty === 'boolean')
    && receipt.host === host && receipt.engine === engine
    && (host !== 'linux' || receipt.presenterProfile === 'software')
    && /^[0-9a-f]{40}$/.test(receipt.sourceCommit ?? '') && /^[0-9a-f]{64}$/.test(receipt.sourceSha256 ?? '')
    && receipt.features?.includes(`${engine}-native`) && !receipt.features.includes(`${engine === 'v8' ? 'quickjs' : 'v8'}-native`),
  'Clean successful exact native executable build receipt required')
  const profile = profileForTarget({ host, presenter, target: receipt.target })
  require(target === undefined || target === profile.target, 'Native executable target differs from the execution host')
  assertFeatures(profile, engine, receipt.features, { exceptionChannel: receipt.exceptionChannel === true })
  const executable = await verifyReference(root, receipt.artifact)
  require(receipt.artifactSha256 === receipt.artifact.sha256 && receipt.artifactKind === profile.artifactKind, 'Build executable digest or kind differs')
  await verifyExecutableHeader(executable, profile)
  for (const ref of [receipt.cargoMessages, receipt.cargoDiagnostics]) await verifyReference(root, ref)
  if (source) {
    const actual = await captureSource(root)
    require((diagnostic || actual.workingTreeDirty === false) && actual.workingTreeDirty === receipt.workingTreeDirty
      && actual.sourceCommit === receipt.sourceCommit && actual.sourceSha256 === receipt.sourceSha256,
      'Current native source differs from the clean executable build')
  }
  return executable
}

export function cargoArguments({ root, targetDir, profile, engine, exceptionChannel = false }) {
  return ['build', '--manifest-path', resolve(root, 'examples/hosts/conformance-desktop/Cargo.toml'), '--locked', '--no-default-features',
    '--features', engineFeatures(profile, engine, { exceptionChannel }).join(','), '--target', profile.target, '--target-dir', targetDir, '--message-format=json-render-diagnostics']
}

export async function build({ root, outputDirectory, engine, targetDir, diagnostic = false, cargo = 'cargo', environment = process.env, host = 'macos', presenter, exceptionChannel = false }) {
  root = await realpath(root)
  const profile = profileForRuntime({ host, presenter })
  requireEngine(engine)
  await mkdir(outputDirectory, { recursive: false })
  const before = await captureSource(root)
  await json(resolve(outputDirectory, 'source-before.json'), before)
  require(diagnostic || before.workingTreeDirty === false, 'Native formal build requires clean committed Rust/host/driver source; use --diagnostic to retain a dirty investigation')
  const target = profile.target
  const args = cargoArguments({ root, targetDir, profile, engine, exceptionChannel })
  const startedAt = new Date().toISOString()
  const child = spawn(cargo, args, { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', failure
  const bounded = (which, data) => {
    if (which === 'stdout') stdout += data
    else stderr += data
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 64 * 1024 ** 2) { failure = 'native Cargo logs exceeded 64 MiB'; child.kill('SIGTERM') }
  }
  child.stdout.setEncoding('utf8').on('data', data => bounded('stdout', data))
  child.stderr.setEncoding('utf8').on('data', data => bounded('stderr', data))
  const outcome = await new Promise(resolve => {
    child.once('error', error => { failure = error.message })
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  await writeFile(resolve(outputDirectory, 'cargo.jsonl'), stdout, { flag: 'wx' })
  await writeFile(resolve(outputDirectory, 'cargo.stderr.txt'), stderr, { flag: 'wx' })
  const after = await captureSource(root)
  await json(resolve(outputDirectory, 'source-after.json'), after)
  require(!failure && outcome.exitCode === 0, `Native Cargo build failed: ${failure ?? outcome.signal ?? outcome.exitCode}; logs retained in ${outputDirectory}`)
  require(before.sourceCommit === after.sourceCommit && before.sourceSha256 === after.sourceSha256, 'Native source changed during compilation')
  const selected = selectExecutable(stdout, { root, targetDir, target, engine, host, presenter, exceptionChannel })
  const original = await fileReference(root, selected.path)
  const binary = resolve(outputDirectory, 'weapp-conformance-desktop')
  await copyFile(selected.path, binary, constants.COPYFILE_EXCL)
  await chmod(binary, 0o755)
  const artifact = await fileReference(root, binary)
  const rechecked = await fileReference(root, selected.path)
  await verifyExecutableHeader(binary, profile)
  require(original.sha256 === artifact.sha256 && original.sha256 === rechecked.sha256 && original.bytes === artifact.bytes, 'Cargo binary changed while freezing the execution artifact')
  const receipt = { schemaVersion: 1, kind: 'weapp-conformance-native-build', status: before.workingTreeDirty || after.workingTreeDirty ? 'diagnostic' : 'passed',
    host, engine, target, ...(host === 'linux' ? { presenterProfile: profile.presenter } : {}), profile: 'dev', ...before, workingTreeDirty: before.workingTreeDirty || after.workingTreeDirty,
    ...(exceptionChannel ? { exceptionChannel: true } : {}), features: selected.features, packageId: selected.packageId, cargoFresh: selected.fresh, artifact, artifactSha256: artifact.sha256, artifactKind: profile.artifactKind,
    command: [cargo, ...args], startedAt, endedAt: new Date().toISOString(), ...outcome,
    environment: Object.fromEntries(['SKIA_SOURCE_DIR', 'SKIA_GN_COMMAND', 'SKIA_NINJA_COMMAND', 'SKIA_LIBRARY_SEARCH_PATH', 'SKIA_BUILD_DEFINES', 'SKIA_BINARIES_URL', 'SDKROOT', 'MACOSX_DEPLOYMENT_TARGET', 'CC', 'CXX', 'AR', 'CARGO_BUILD_TARGET', 'RUSTFLAGS', 'RUSTY_V8_ARCHIVE', 'RUSTY_V8_ARCHIVE_SHA256'].filter(key => environment[key] !== undefined).map(key => [key, environment[key]])),
    cargoMessages: await fileReference(root, resolve(outputDirectory, 'cargo.jsonl')), cargoDiagnostics: await fileReference(root, resolve(outputDirectory, 'cargo.stderr.txt')) }
  await json(resolve(outputDirectory, 'build.json'), receipt)
  return receipt
}

export function parseBuildOptions(args, root) {
  const options = parseOptions(args, { values: ['--engine', '--out', '--target-dir', '--host', '--presenter'], flags: ['--diagnostic', '--exception-channel'], required: ['--engine', '--out'] })
  const host = options['--host'] ?? 'macos', presenter = options['--presenter']
  hostProfile({ host, presenter })
  return { root, host, presenter, engine: requireEngine(options['--engine']), outputDirectory: resolve(root, options['--out']),
    targetDir: resolve(root, options['--target-dir'] ?? 'target'), diagnostic: options['--diagnostic'] === true, ...(options['--exception-channel'] === true ? { exceptionChannel: true } : {}) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
    const receipt = await build(parseBuildOptions(process.argv.slice(2), root))
    process.stdout.write(`Native ${receipt.host}/${receipt.engine} build ${receipt.status}: ${receipt.artifact.path}\n`)
  } catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 }
}
