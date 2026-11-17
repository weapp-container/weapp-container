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
const FIXTURE = resolve(ROOT, 'examples/apps/typography-app')
const request = (requestId, op, payload) => ({ protocolVersion: '1.0', sessionId: 'simulator-1', requestId, kind: 'request', op, payload })
const tap = (id, y) => request(id, 'event.batch', { events: [{ type: 'tap', x: 20, y }] })

function inspect(trace, snapshot, native, engine, resized) {
  assert.equal(native.engine, engine)
  assert.equal(native.status, 'passed')
  assert.equal(native.renderer, 'skia-raster', 'this smoke requires real native Skia CPU glyph drawing')
  assert.equal(native.sessionId, 'simulator-1')
  assert.equal(native.route, 'pages/index/index')
  assert.equal(native.lifecycleState, 'Active')
  assert.equal(trace.engine, engine)
  assert.equal(trace.traceSummary.complete, true)
  const records = trace.records ?? trace.events
  assert.equal(records.length, trace.traceSummary.totalRecords)
  assert.equal(records.length, resized ? 8 : 6)
  assert.deepEqual(records.slice(0, 4).map(record => record.request.op), ['app.init', 'app.lifecycle', 'page.push', 'render.commit'])
  for (const record of records) matchedResponse(trace, record.request.requestId, record.request.op)
  assert.deepEqual(records.flatMap(record => record.response.messages)
    .filter(message => message.op === 'error' || message.payload?.ok === false), [])
  const actual = matchedResponse(trace, 'read', 'api.call').result
  const size = resized ? 30 : 20
  assert.equal(actual.data.size, size)
  assert.equal(actual.data.taps, Number(resized), 'font changes must originate in the actual Page tap handler')
  assert.deepEqual(actual.trace, ['load', 'show', 'ready'])
  const [numberParent, numberChild, percentParent, percentChild, multiline, zeroLine, zeroFont] = actual.geometry
  for (const parent of [numberParent, percentParent]) assert.equal(parent['font-size'], `${size}px`)
  for (const child of [numberChild, percentChild]) assert.equal(child['font-size'], `${size / 2}px`)
  assert.equal(numberParent['line-height'], `${size * 1.5}px`)
  assert.equal(numberChild['line-height'], `${size * 0.75}px`)
  assert.equal(percentParent['line-height'], `${size * 1.5}px`)
  assert.equal(percentChild['line-height'], `${size * 1.5}px`, 'inherited percentages have already computed to lengths')
  assert.equal(numberChild.height, size * 0.75)
  assert.equal(percentChild.height, size * 1.5)
  assert.equal(multiline['font-size'], '10px')
  assert.equal(multiline['line-height'], '12px')
  assert.equal(multiline.height, 24, 'two actual newline-separated lines use the shared explicit line height')
  assert.equal(zeroLine.height, 0)
  assert.equal(zeroFont.height, 0)
  assert.equal(zeroFont['font-size'], '0px')
  assert.equal(snapshot.width, 280)
  assert.equal(snapshot.height, 280)
  assert.equal(snapshot.pixels.length, snapshot.stride * snapshot.height)
  const pixels = (left, top, width, height) => {
    const values = []
    for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
      const offset = y * snapshot.stride + x * 4
      values.push(snapshot.pixels.slice(offset, offset + 4))
    }
    return values
  }
  const dark = pixel => pixel[0] < 230 && pixel[1] < 230 && pixel[2] < 230 && pixel[3] === 255
  assert.ok(pixels(8, 80, 60, 12).some(dark), 'native first-line glyph ink')
  assert.ok(pixels(8, 92, 60, 12).some(dark), 'native second-line glyph ink')
  assert.ok(pixels(8, 120, 120, 35).some(pixel => pixel[2] > pixel[0] + 40 && pixel[2] > pixel[1] + 20),
    'zero line height does not erase visible glyph ink')
  assert.ok(pixels(8, 165, 120, 25).every(pixel => pixel.every(channel => channel === 255)),
    'zero font size paints no glyphs')
  return { actual, rgbaSha256: sha256(Buffer.from(snapshot.pixels)), renderer: native.renderer }
}

export async function main(argv = process.argv.slice(2)) {
  const options = {}, names = new Map([['--simulator-bin', 'simulatorBin'], ['--compiler-root', 'compilerRoot'],
    ['--compiler-dist-hashes', 'compilerDistHashes'], ['--out', 'out']])
  for (let i = 0; i < argv.length; i++) {
    const name = names.get(argv[i]); assert.ok(name && argv[i + 1], `unknown or incomplete option: ${argv[i]}`)
    options[name] = resolve(argv[++i])
  }
  for (const name of ['simulatorBin', 'compilerRoot', 'compilerDistHashes', 'out']) assert.ok(options[name], `${name} is required`)
  await mkdir(dirname(options.out), { recursive: true })
  const artifacts = options.out + '.files'
  await mkdir(artifacts)
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-text-'))
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: 180_000 }), { command } = runner
  const report = { schemaVersion: 1, status: 'failed', engines: [], cleanup: {},
    boundary: 'Actual pinned compiler output; native QuickJS/V8, selector results and Skia CPU RGBA. No host-injected Page data/code. Not official DevTools, GPU, device, shaping or performance acceptance.' }
  async function sources() {
    return { fixture: await sourceHashes(FIXTURE), packer: await sourceHashes(resolve(ROOT, 'tools/container-manifest/src')),
      packerBin: await sourceHashes(resolve(ROOT, 'tools/container-manifest/bin')),
      ...Object.fromEntries(await Promise.all(['scripts/typography-smoke.mjs', 'scripts/scrolling-smoke.mjs', 'scripts/simulator-cli-harness.mjs']
        .map(async path => [path, sha256(await readFile(resolve(ROOT, path)))]))) }
  }
  async function save(name, bytes, gzip = false) {
    const data = gzip ? gzipSync(bytes, { mtime: 0 }) : bytes, path = name + (gzip ? '.gz' : '')
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
    report.build = await save('compiler-build.json', Buffer.from(JSON.stringify(await command(process.execPath,
      [resolve(options.compilerRoot, 'packages/weapp-vite/bin/weapp-vite.js'), 'build', project, '-p', 'weapp', '--outDir', dist]), null, 2)))
    report.compiler.after = await validateCompiler(options, command, commit)
    assert.deepEqual(report.compiler.before, report.compiler.after)
    report.rawOutput = await sourceHashes(dist)
    await command(process.execPath, ['tools/container-manifest/bin/container-pack.mjs', dist, '--out', pack, '--compiler-commit', commit])
    assert.deepEqual(await sourceHashes(dist), report.rawOutput)
    const manifestBytes = await readFile(resolve(pack, 'manifest.json')), manifest = JSON.parse(manifestBytes)
    assert.equal(manifest.compiler.commit, commit)
    report.manifest = await save('manifest.json', manifestBytes)
    report.integrityRoot = manifest.integrity.root
    const blobs = {}
    for (const name of await readdir(resolve(pack, 'blobs/sha256'))) {
      const bytes = await readFile(resolve(pack, 'blobs/sha256', name)); assert.equal(sha256(bytes), name)
      blobs[`sha256:${name}`] = [...bytes]
    }
    report.blobs = await save('blobs.json', Buffer.from(JSON.stringify(blobs)), true)
    for (const engine of ['quickjs', 'v8']) {
      const entry = { engine, phases: [] }; report.engines.push(entry)
      for (const resized of [false, true]) {
        const name = resized ? 'resized' : 'initial', prefix = resolve(temporary, `${engine}-${name}`)
        const script = [...(resized ? [tap('resize', 214), request('resized-frame', 'render.commit', {
          templateId: 'template:pages/index/index.wxml', blobs, viewport: { width: 280, height: 280 } })] : []),
          tap('inspect', 249), request('read', 'api.call', { name: 'wx.getStorageSync', key: 'typography:observation' })]
        assert.ok(script.every(message => !['data.patch.batch', 'module.load'].includes(message.op)))
        await writeFile(prefix + '.jsonl', script.map(message => JSON.stringify(message)).join('\n') + '\n')
        await command(options.simulatorBin, ['run', '--pack', pack, '--engine', engine, '--viewport', '280x280',
          '--script', prefix + '.jsonl', '--trace', prefix + '.trace.json', '--snapshot', prefix + '.snapshot.json', '--report', prefix + '.report.json'])
        const trace = await readFile(prefix + '.trace.json'), snapshot = await readFile(prefix + '.snapshot.json'), native = await readFile(prefix + '.report.json')
        const phase = { name, trace: await save(`${engine}-${name}.trace.json`, trace, true),
          snapshot: await save(`${engine}-${name}.snapshot.json`, snapshot, true), native: await save(`${engine}-${name}.report.json`, native) }
        entry.phases.push(phase)
        phase.observation = inspect(JSON.parse(trace), JSON.parse(snapshot), JSON.parse(native), engine, resized)
        phase.status = 'passed'
      }
      entry.status = 'passed'
    }
    assert.deepEqual(report.engines[0].phases.map(phase => phase.observation), report.engines[1].phases.map(phase => phase.observation))
    assert.notEqual(report.engines[0].phases[0].observation.rgbaSha256, report.engines[0].phases[1].observation.rgbaSha256)
    assert.deepEqual(await sourceHashes(dist), report.rawOutput)
    report.rawOutputUnmodified = true
    report.sourceAfter = await sources(); assert.deepEqual(report.sourceBefore, report.sourceAfter)
    assert.equal(sha256(await readFile(options.simulatorBin)), report.simulator.sha256)
    report.status = 'passed'
  } catch (error) {
    report.error = error.stack ?? String(error)
    if (error.result) report.failedCommand = await save('failed-command.json', Buffer.from(JSON.stringify(error.result, null, 2)))
  } finally {
    const cleanupErrors = []
    try { assert.equal(runner.active, null); report.cleanup.childrenStopped = true }
    catch (error) { cleanupErrors.push(error.stack ?? String(error)) }
    try { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporaryRemoved = true }
    catch (error) { cleanupErrors.push(error.stack ?? String(error)) }
    try { runner.dispose() }
    catch (error) { cleanupErrors.push(error.stack ?? String(error)) }
    if (cleanupErrors.length) {
      report.status = 'failed'
      report.cleanup.errors = cleanupErrors
    }
    await writeFile(options.out, JSON.stringify(report, null, 2) + '\n')
  }
  process.stdout.write(JSON.stringify({ status: report.status, report: options.out, cleanup: report.cleanup }) + '\n')
  if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
