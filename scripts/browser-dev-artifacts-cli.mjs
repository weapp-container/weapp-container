#!/usr/bin/env node
/** One finite artifact job. No Cargo, Worker, AppService, HTTP server or browser.
 * The Rust owner owns this child, its deadline, its files and final publication
 * check. A successful result is static assembly, never runtime readiness. */
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBrowserRuntimeBundle, retainBrowserRuntimeBundle, stageBrowserPackGeneration } from './browser-dev-artifacts.mjs'

const REQUEST_BYTES = 2 * 1024 * 1024, RESULT_BYTES = 16 * 1024 * 1024
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const exactKeys = (value, allowed) => assert.ok(record(value) && Object.keys(value).every(key => allowed.includes(key)), 'Unknown artifact job field')
const boundedMessage = error => {
  const text = String(error?.message ?? 'Artifact job failed') || 'Artifact job failed'
  let output = '', bytes = 0
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (bytes + size > 2048) break
    output += character; bytes += size
  }
  return output
}

async function requestAt(path) {
  assert.ok(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, 'Request must be a canonical absolute file')
  const expected = await lstat(path)
  assert.ok(expected.isFile() && !expected.isSymbolicLink(), 'Request must be a regular nonsymlink file')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    assert.ok(stat.isFile() && stat.dev === expected.dev && stat.ino === expected.ino
      && stat.size > 0 && stat.size <= REQUEST_BYTES, 'Artifact request changed or exceeds its byte budget')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const part = await file.read(bytes, offset, bytes.length - offset, offset)
      assert.ok(part.bytesRead > 0, 'Artifact request shortened during read'); offset += part.bytesRead
    }
    const probe = await file.read(Buffer.alloc(1), 0, 1, offset), after = await file.stat()
    assert.ok(probe.bytesRead === 0 && after.size === stat.size && after.mtimeMs === stat.mtimeMs
      && after.ctimeMs === stat.ctimeMs, 'Artifact request changed during read')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally { await file.close() }
}

/** The returned native paths belong only in the private child result file.
 * Serving resources requires the owner's independent allowlist and byte leases. */
export async function runBrowserDevArtifactRequest(request) {
  exactKeys(request, ['schemaVersion', 'requestId', 'op', 'runtime', 'stage'])
  assert.equal(request.schemaVersion, 1); assert.ok(id(request.requestId), 'Invalid artifact request identity')
  assert.ok(record(request.runtime), 'Exact runtime producer/bundle pins are required')
  let bundle
  if (request.op === 'retain-runtime') {
    assert.equal(request.stage, undefined, 'Runtime acquisition cannot stage application files')
    exactKeys(request.runtime, ['builtSiteDirectory', 'destination', 'expected'])
    bundle = await retainBrowserRuntimeBundle(request.runtime)
  } else {
    assert.equal(request.op, 'stage-pack', 'Unknown artifact operation')
    exactKeys(request.runtime, ['directory', 'expectedBundleSha256', 'expected'])
    exactKeys(request.stage, ['packDirectory', 'destination', 'expected', 'runId', 'siteId',
      'publicationToken', 'inputBindingSha256', 'startupIntentJson'])
    assert.ok(hash(request.stage.inputBindingSha256), 'Bound stage input ticket is required')
    assert.ok(typeof request.stage.startupIntentJson === 'string', 'Exact startup intent bytes are required')
    bundle = await openBrowserRuntimeBundle(request.runtime)
  }
  const runtime = { directory: bundle.directory, bundleId: bundle.bundleId, descriptorSha256: bundle.descriptorSha256,
    producer: bundle.producer, runtimeFiles: bundle.runtimeFiles, provenance: bundle.provenance }
  const stage = request.op === 'stage-pack'
    ? await stageBrowserPackGeneration({ ...request.stage, runtimeBundle: bundle }) : undefined
  return { schemaVersion: 1, requestId: request.requestId, op: request.op, status: 'staged-static', runtime,
    ...(stage === undefined ? {} : { stage }), runtimeReady: false, presentedReady: false }
}

export async function runBrowserDevArtifactCli(args) {
  assert.ok(args.length === 4 && args[0] === '--request' && args[2] === '--result', 'Expected --request <file> --result <file>')
  const input = args[1], output = args[3]
  assert.ok(isAbsolute(input) && isAbsolute(output) && resolve(output) === output && input !== output,
    'Request and result must be distinct absolute files')
  const parent = dirname(input)
  assert.ok(dirname(output) === parent && await realpath(parent) === parent
    && basename(output) !== '.' && basename(output) !== '..', 'Result must be in the canonical private request directory')
  // Reserve the exact result before any staging side effect. Only this child
  // writes this descriptor; the parent waits for actual process retirement
  // before reading it. A crash/partial result remains an explicit failure.
  const target = await open(output, 'wx', 0o600)
  try {
    let request, result, error
    try { request = await requestAt(input); result = await runBrowserDevArtifactRequest(request) }
    catch (failure) {
      error = failure
      result = { schemaVersion: 1, requestId: id(request?.requestId) ? request.requestId : null, status: 'failed',
        code: 'ERR_BROWSER_DEV_ARTIFACT', message: boundedMessage(failure),
        runtimeReady: false, presentedReady: false }
    }
    const bytes = Buffer.from(JSON.stringify(result) + '\n')
    assert.ok(bytes.length <= RESULT_BYTES, 'Artifact result exceeds its byte budget')
    await target.writeFile(bytes)
    return { exitCode: error ? 1 : 0 }
  } finally { await target.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await runBrowserDevArtifactCli(process.argv.slice(2))).exitCode }
  catch (error) { process.stderr.write(`ERR_BROWSER_DEV_ARTIFACT: ${boundedMessage(error)}\n`); process.exitCode = 1 }
}
