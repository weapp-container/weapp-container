/** TEST ONLY: synthetic offline reader coverage, never a process observation.
 * Paired with createSyntheticPinnedCompilerBuild, this fabricates explicit
 * process/load records to test full pinned-source gate admission. The actual
 * materialize/seal/spawn/finish path is independently exercised by
 * conformance-compiler-use.test.mjs. Production code must never import this. */
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archiveCompilerBuildBytes } from '../conformance-compiler-build.mjs'
import { compilerUseMemberClosure } from '../conformance-compiler-use.mjs'

const common = new Map()
const producerPath = fileURLToPath(new URL('../conformance-compiler-use.mjs', import.meta.url))
const preloadPath = fileURLToPath(new URL('../conformance-compiler-use-preload.cjs', import.meta.url))

export function createSyntheticCompilerUse({ root, directory, compilerBuild, attestation, caseId, sourceSha256, caseSourcePath,
  startedAt = new Date().toISOString(), endedAt = startedAt, pid = 10101 }) {
  const requestedRoot = resolve(root)
  root = realpathSync(root)
  directory = resolve(root, relative(requestedRoot, resolve(directory)))
  const put = bytes => archiveCompilerBuildBytes({ root, directory, bytes })
  const key = JSON.stringify([root, compilerBuild])
  let shared = common.get(key)
  if (!shared) {
    const build = attestation ?? JSON.parse(readFileSync(join(root, compilerBuild.path)))
    const members = compilerUseMemberClosure(build, ref => readFileSync(join(root, ref.path)))
      .map(({ artifact, transform, mode, ...item }) => item)
    const ownerId = randomUUID(), checkout = join(root, 'SYNTHETIC-OFFLINE-CONSUMER-NOT-EXECUTED')
    const before = put(JSON.stringify({ ownerId, checkout, members }))
    const preload = put(readFileSync(preloadPath)), producer = put(readFileSync(producerPath))
    const entry = members.find(item => item.path === 'packages/weapp-vite/dist/index.mjs')
      ?? members.find(item => build.build.requiredOutputs.includes(item.path))
    if (!entry) throw new Error('Synthetic compiler use needs an actual archived compiler output member')
    shared = { ownerId, checkout, before, preload, producer, entry }
    common.set(key, shared)
  }
  const { ownerId, checkout, before, preload, producer, entry } = shared
  const runAt = startedAt
  const nodeOptions = '--require="/SYNTHETIC-OFFLINE-READER-TEST-NOT-EXECUTED/compiler-use-preload.cjs"'
  const configValue = { runId: ownerId, caseId, sourceSha256, caseSourcePath, checkout,
    logDirectory: '/SYNTHETIC-OFFLINE-READER-TEST-NOT-EXECUTED/loader-logs', evidenceRoot: root,
    membersReference: before, allowedModuleRoots: [], runnerFiles: [] }
  const config = put(JSON.stringify(configValue))
  const base = { runId: ownerId, caseId, sourceSha256, caseSourcePath, pid, ppid: 1, threadId: 0, isMainThread: true, at: runAt }
  const logs = put([
    { ...base, kind: 'start', argv: ['/SYNTHETIC-NOT-EXECUTED/node', join(checkout, caseSourcePath)], execArgv: [], nodeOptions, preloadSha256: preload.sha256 },
    { ...base, kind: 'load', file: join(checkout, entry.path), path: entry.path, sha256: entry.sha256, bytes: entry.bytes,
      loadedSourceSha256: entry.sha256, format: 'module', classification: 'bound' },
  ].map(item => JSON.stringify(item)).join('\n') + '\n')
  const value = { schemaVersion: 1, kind: 'weapp-container.compiler-use', status: 'used', ownerId, compilerBuild, caseId, sourceSha256, caseSourcePath,
    checkout, patches: [], before, after: before, preload, producer, staticProfileInputs: ['conformance-static-cli-profile.mjs', 'conformance-fixture-project.mjs'].map(name => ({ path: `scripts/${name}`, artifact: put(readFileSync(new URL(`../${name}`, import.meta.url))) })), config, nodeOptions, allowedModuleRoots: [], runnerFiles: [],
    startedAt, endedAt, process: { exitCode: 0, signal: null, pid }, logs: [logs] }
  const reference = put(JSON.stringify(value, null, 2) + '\n')
  return { reference, attestation: value, compilerUse: reference }
}
