#!/usr/bin/env node
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createOwnedCommandRunner, matchedResponse, sha256, sourceHashes } from './simulator-cli-harness.mjs'
import { validateCompiler } from './scrolling-smoke.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE = resolve(ROOT, 'examples/apps/style-conditions-app')
const PHASES = [
  { name: 'narrow', width: 100, height: 200, panel: [40, 40], color: [229, 57, 53, 255], imported: [255, 255, 255, 255] },
  { name: 'wide', width: 200, height: 100, panel: [80, 40], color: [25, 118, 210, 255], imported: [128, 64, 192, 255] },
  { name: 'square', width: 200, height: 200, panel: [80, 60], color: [0, 160, 96, 255], imported: [128, 64, 192, 255] },
  { name: 'narrow-again', width: 100, height: 200, panel: [40, 40], color: [229, 57, 53, 255], imported: [255, 255, 255, 255] },
]
const request = (requestId, op, payload) => ({ protocolVersion: '1.0', sessionId: 'simulator-1', requestId, kind: 'request', op, payload })
const tap = (id, x, y) => request(id, 'event.batch', { events: [{ type: 'tap', x, y }] })

function scriptFor(index, blobs) {
  return PHASES.slice(0, index + 1).flatMap((phase, i) => [
    request(`frame-${i}`, 'render.commit', { templateId: 'template:pages/index/index.wxml', blobs,
      viewport: { width: phase.width, height: phase.height } }),
    tap(`panel-${i}`, 20, 20),
    request(`updated-frame-${i}`, 'render.commit', { templateId: 'template:pages/index/index.wxml', blobs,
      viewport: { width: phase.width, height: phase.height } }),
    tap(`inspect-${i}`, 20, 80),
    request(`read-${i}`, 'api.call', { name: 'wx.getStorageSync', key: 'styles:observation' }),
  ])
}

function inspect(trace, snapshot, native, engine, index) {
  const phase = PHASES[index]
  assert.equal(native.engine, engine)
  assert.equal(native.status, 'passed')
  assert.equal(native.lifecycleState, 'Active')
  assert.equal(native.sessionId, 'simulator-1')
  assert.equal(native.route, 'pages/index/index')
  assert.equal(trace.engine, engine)
  assert.equal(trace.traceSummary.complete, true, 'native evidence retains the full trace')
  assert.equal(native.traceSummary.complete, true)
  const records = trace.records ?? trace.events
  assert.equal(records.length, trace.traceSummary.totalRecords)
  assert.equal(records.length, 4 + 5 * (index + 1), 'canonical startup and exactly one replay of each requested phase')
  assert.deepEqual(records.slice(0, 4).map(record => record.request.op), ['app.init', 'app.lifecycle', 'page.push', 'render.commit'])
  for (const record of records) matchedResponse(trace, record.request.requestId, record.request.op)
  assert.deepEqual(records.flatMap(record => record.response.messages)
    .filter(message => message.op === 'error' || message.payload?.ok === false), [])
  const actual = matchedResponse(trace, `read-${index}`, 'api.call').result
  assert.deepEqual(actual.trace, ['load', 'show', 'ready'], 'viewport commits preserve actual lifecycle')
  assert.equal(actual.data.count, index + 1, 'only actual Page tap handlers update the counter')
  assert.equal(actual.route, 'pages/index/index')
  assert.deepEqual(actual.geometry.map(rect => [rect.width, rect.height]), [phase.panel, [20, 20]])
  assert.equal(snapshot.width, phase.width)
  assert.equal(snapshot.height, phase.height)
  assert.equal(snapshot.stride, phase.width * 4)
  assert.ok(['rgba8', 'rgba8-premultiplied'].includes(snapshot.format))
  assert.equal(snapshot.pixels.length, snapshot.stride * snapshot.height)
  const pixel = (x, y) => snapshot.pixels.slice(y * snapshot.stride + x * 4, y * snapshot.stride + x * 4 + 4)
  assert.deepEqual(pixel(20, 20), phase.color, 'actual condition-selected panel pixels')
  assert.deepEqual(pixel(80, 65), phase.imported, 'actual conditional shared stylesheet pixels')
  return { actual, rgbaSha256: sha256(Buffer.from(snapshot.pixels)), renderer: native.renderer }
}

export async function main(argv = process.argv.slice(2)) {
  const options = {}
  const names = new Map([['--simulator-bin', 'simulatorBin'], ['--compiler-root', 'compilerRoot'],
    ['--compiler-dist-hashes', 'compilerDistHashes'], ['--out', 'out']])
  for (let i = 0; i < argv.length; i++) {
    const name = names.get(argv[i]); assert.ok(name && argv[i + 1], `unknown or incomplete option: ${argv[i]}`)
    options[name] = resolve(argv[++i])
  }
  for (const name of ['simulatorBin', 'compilerRoot', 'compilerDistHashes', 'out']) assert.ok(options[name], `${name} is required`)
  await mkdir(dirname(options.out), { recursive: true })
  const artifacts = options.out + '.files'
  await mkdir(artifacts)
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-wxss-'))
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: 180_000 })
  const { command } = runner
  const report = { schemaVersion: 1, status: 'failed', engines: [], cleanup: {},
    boundary: 'Real pinned weapp-vite output, native QuickJS/V8 and software RGBA. Fresh process per phase replay; viewport changes within each replay preserve one session. No official DevTools, GPU, device or performance acceptance.' }
  async function sources() {
    const files = { fixture: await sourceHashes(FIXTURE), packer: await sourceHashes(resolve(ROOT, 'tools/container-manifest/src')),
      packerBin: await sourceHashes(resolve(ROOT, 'tools/container-manifest/bin')) }
    for (const path of ['scripts/wxss-conditions-smoke.mjs', 'scripts/scrolling-smoke.mjs', 'scripts/simulator-cli-harness.mjs']) files[path] = sha256(await readFile(resolve(ROOT, path)))
    return files
  }
  async function save(name, bytes, gzip = false) {
    const data = gzip ? gzipSync(bytes, { mtime: 0 }) : bytes
    const path = name + (gzip ? '.gz' : '')
    await writeFile(resolve(artifacts, path), data)
    return { path, sha256: sha256(data), ...(gzip ? { rawSha256: sha256(bytes) } : {}) }
  }
  try {
    report.commit = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
    report.sourceBefore = await sources()
    report.simulator = { path: options.simulatorBin, sha256: sha256(await readFile(options.simulatorBin)) }
    const commit = (await command('git', ['rev-parse', 'HEAD:vendor/weapp-vite'])).stdout.trim()
    report.compiler = { before: await validateCompiler(options, command, commit) }
    const project = resolve(temporary, 'project'), dist = resolve(temporary, 'dist'), pack = resolve(temporary, 'pack')
    await cp(FIXTURE, project, { recursive: true })
    const build = await command(process.execPath, [resolve(options.compilerRoot, 'packages/weapp-vite/bin/weapp-vite.js'),
      'build', project, '-p', 'weapp', '--outDir', dist])
    report.build = await save('compiler-build.json', Buffer.from(JSON.stringify(build, null, 2)))
    report.compiler.after = await validateCompiler(options, command, commit)
    assert.deepEqual(report.compiler.before, report.compiler.after)
    report.rawOutput = await sourceHashes(dist)
    await command(process.execPath, ['tools/container-manifest/bin/container-pack.mjs', dist, '--out', pack, '--compiler-commit', commit])
    assert.deepEqual(await sourceHashes(dist), report.rawOutput, 'packing preserves original weapp-vite output')
    const manifestBytes = await readFile(resolve(pack, 'manifest.json'))
    const manifest = JSON.parse(manifestBytes)
    assert.equal(manifest.compiler.commit, commit)
    report.manifest = await save('manifest.json', manifestBytes)
    report.integrityRoot = manifest.integrity.root
    const blobs = {}
    for (const name of await readdir(resolve(pack, 'blobs/sha256'))) {
      const bytes = await readFile(resolve(pack, 'blobs/sha256', name))
      assert.equal(sha256(bytes), name)
      blobs[`sha256:${name}`] = [...bytes]
    }
    for (const style of manifest.styles) assert.equal(JSON.parse(Buffer.from(blobs[style.wxssIr])).version, 2)
    report.blobs = await save('blobs.json', Buffer.from(JSON.stringify(blobs)), true)
    for (const engine of ['quickjs', 'v8']) {
      const entry = { engine, phases: [] }; report.engines.push(entry)
      for (let index = 0; index < PHASES.length; index++) {
        const prefix = resolve(temporary, `${engine}-${index}`), script = scriptFor(index, blobs)
        assert.ok(script.every(message => !['data.patch.batch', 'module.load'].includes(message.op)))
        assert.ok(script.filter(message => message.op === 'render.commit').every(message => !('data' in message.payload) && !('frame' in message.payload)))
        await writeFile(prefix + '.jsonl', script.map(message => JSON.stringify(message)).join('\n') + '\n')
        await command(options.simulatorBin, ['run', '--pack', pack, '--engine', engine, '--viewport', '100x200',
          '--script', prefix + '.jsonl', '--trace', prefix + '.trace.json', '--snapshot', prefix + '.snapshot.json', '--report', prefix + '.report.json'])
        const trace = await readFile(prefix + '.trace.json'), snapshot = await readFile(prefix + '.snapshot.json'), native = await readFile(prefix + '.report.json')
        const phase = { name: PHASES[index].name, trace: await save(`${engine}-${index}.trace.json`, trace, true),
          snapshot: await save(`${engine}-${index}.snapshot.json`, snapshot, true), native: await save(`${engine}-${index}.report.json`, native) }
        entry.phases.push(phase)
        phase.observation = inspect(JSON.parse(trace), JSON.parse(snapshot), JSON.parse(native), engine, index)
        phase.status = 'passed'
      }
      entry.status = 'passed'
    }
    assert.deepEqual(report.engines[0].phases.map(phase => phase.observation), report.engines[1].phases.map(phase => phase.observation))
    assert.deepEqual(await sourceHashes(dist), report.rawOutput, 'runtime execution preserves original weapp-vite output')
    report.rawOutputUnmodified = true
    report.sourceAfter = await sources()
    assert.deepEqual(report.sourceBefore, report.sourceAfter)
    assert.equal(sha256(await readFile(options.simulatorBin)), report.simulator.sha256,
      'the native executable is unchanged throughout the run')
    report.status = 'passed'
  } catch (error) {
    report.error = error.stack ?? String(error)
    if (error.result) report.failedCommand = await save('failed-command.json', Buffer.from(JSON.stringify(error.result, null, 2)))
  }
  finally {
    // Every command promise waits for the owned child close event, including
    // timeout/signal failures. Do not call a synchronous stop a completed wait.
    try {
      assert.equal(runner.active, null, 'all owned command children have exited')
      report.cleanup.childrenStopped = true
    }
    finally {
      try { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporaryRemoved = true }
      finally { runner.dispose(); await writeFile(options.out, JSON.stringify(report, null, 2) + '\n') }
    }
  }
  process.stdout.write(JSON.stringify({ status: report.status, report: options.out, cleanup: report.cleanup }) + '\n')
  if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
