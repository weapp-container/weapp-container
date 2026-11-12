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
const FIXTURE = resolve(ROOT, 'examples/apps/flex-layout-app')
const request = (requestId, op, payload) => ({ protocolVersion: '1.0', sessionId: 'simulator-1', requestId, kind: 'request', op, payload })
const tap = (id, y) => request(id, 'event.batch', { events: [{ type: 'tap', x: 20, y }] })

function inspect(trace, snapshot, native, engine, phase, browser) {
  const narrow = phase === 'narrow', scrolled = phase === 'scrolled'
  assert.equal(native.engine, engine)
  assert.equal(native.status, 'passed')
  assert.equal(native.renderer, 'skia-raster', 'requires actual native CPU rendering')
  assert.equal(native.sessionId, 'simulator-1')
  assert.equal(native.route, 'pages/index/index')
  assert.equal(native.lifecycleState, 'Active')
  assert.equal(trace.engine, engine)
  assert.equal(trace.traceSummary.complete, true)
  const records = trace.records ?? trace.events
  assert.equal(records.length, trace.traceSummary.totalRecords)
  assert.equal(records.length, narrow || scrolled ? 8 : 6)
  assert.deepEqual(records.slice(0, 4).map(record => record.request.op), ['app.init', 'app.lifecycle', 'page.push', 'render.commit'])
  for (const record of records) matchedResponse(trace, record.request.requestId, record.request.op)
  assert.deepEqual(records.flatMap(record => record.response.messages)
    .filter(message => message.op === 'error' || message.payload?.ok === false), [])
  const actual = matchedResponse(trace, 'read', 'api.call').result
  assert.equal(actual.data.wrapWidth, narrow ? 120 : 220)
  assert.equal(actual.data.taps, Number(narrow), 'the actual Page tap handler must change layout')
  assert.equal(actual.data.scrolls, Number(scrolled), 'the real wx.pageScrollTo callback must run')
  assert.equal(actual.data.fixedTaps, Number(scrolled), 'physical viewport coordinates must still hit the fixed node after scrolling')
  assert.deepEqual(actual.trace, ['load', 'show', 'ready'])
  const geometry = Object.fromEntries(actual.geometry.map(node => [node.id, node]))
  assert.equal(actual.geometry.length, 21)
  assert.equal(Object.keys(geometry).length, 21)
  const near = (actual, expected, description) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 0.05,
    `${description}: expected ${expected}, received ${actual}`)
  const box = (id, x, y, width, height) => {
    assert.ok(geometry[id], `missing selector ${id}`)
    if (scrolled && id !== 'fixed') y -= 100
    for (const [key, expected] of Object.entries({ left: x, top: y, width, height })) near(geometry[id][key], expected, `${id}.${key}`)
  }
  box('row-a', 10, 10, 50, 20)
  box('row-b', 60, 10, 50, 20)
  box('grow-a', 10, 50, 100, 30)
  box('grow-b', 110, 50, 200, 30)
  box('shrink-a', 10, 90, 75, 20)
  box('shrink-b', 85, 90, 75, 20)
  box('wrap', 10, 130, narrow ? 120 : 220, 90)
  box('wrap-a', 10, 130, 100, 20)
  box('wrap-b', narrow ? 10 : 120, narrow ? 160 : 130, 100, 20)
  box('wrap-c', 10, narrow ? 190 : 160, 100, 20)
  box('align-a', 10, 250, 50, 20)
  box('align-b', 260, 250, 50, 20)
  box('percent', 10, 310, 200, 80)
  box('percent-child', 20, 320, 90, 30)
  box('percent-grandchild', 20, 320, 45, 15)
  box('absolute', 325, 375, 10, 10)
  box('fixed', 350, 790, 10, 10)
  box('max-item', 10, 510, 80, 30)
  box('min-item', 90, 510, 220, 30)
  for (const id of ['text-a', 'text-b']) {
    near(geometry[id].width, 90, `${id} allocated width`)
    assert.ok(geometry[id].height >= 24, 'text must be measured again at its allocated flex width')
    near(geometry[id].height / 12, Math.round(geometry[id].height / 12), `${id} explicit line boxes`)
  }
  near(geometry['text-b'].left, 100, 'text sibling x')
  if (browser) {
    const expected = browser[phase]
    assert.ok(Array.isArray(expected) && expected.length >= 21)
    for (const id of Object.keys(geometry)) {
      const node = expected.find(node => node.id === id)
      assert.ok(node, `missing browser comparison node ${id}`)
      for (const key of ['left', 'top', 'width', 'height']) {
        // Scalar text wrapping is a documented limitation. Keep the original
        // browser height in the artifact rather than rewriting it to match.
        if (key === 'height' && ['text-a', 'text-b'].includes(node.id)) continue
        near(geometry[node.id][key], node[key], `auxiliary Chrome ${node.id}.${key}`)
      }
    }
  }
  assert.equal(snapshot.width, 360)
  assert.equal(snapshot.height, 800)
  assert.equal(snapshot.pixels.length, snapshot.stride * snapshot.height)
  const pixel = (x, y) => snapshot.pixels.slice(y * snapshot.stride + x * 4, y * snapshot.stride + x * 4 + 4)
  if (!scrolled) {
    assert.deepEqual(pixel(15, 55), [38, 138, 70, 255], 'grown first child paints its accepted box')
    assert.deepEqual(pixel(115, 55), [36, 104, 188, 255], 'grown second child paints its accepted box')
  }
  assert.deepEqual(pixel(15, scrolled ? 65 : narrow ? 195 : 165), [36, 104, 188, 255], 'wrapped third child paints its accepted row')
  assert.deepEqual(pixel(351, 791), [36, 104, 188, 255], 'fixed descendant uses the viewport')
  return { actual, rgbaSha256: sha256(Buffer.from(snapshot.pixels)), renderer: native.renderer }
}

export async function main(argv = process.argv.slice(2)) {
  const options = {}, names = new Map([['--simulator-bin', 'simulatorBin'], ['--compiler-root', 'compilerRoot'],
    ['--compiler-dist-hashes', 'compilerDistHashes'], ['--browser-corpus', 'browserCorpus'], ['--out', 'out']])
  for (let i = 0; i < argv.length; i++) {
    const name = names.get(argv[i]); assert.ok(name && argv[i + 1], `unknown or incomplete option: ${argv[i]}`)
    options[name] = resolve(argv[++i])
  }
  for (const name of ['simulatorBin', 'compilerRoot', 'compilerDistHashes', 'out']) assert.ok(options[name], `${name} is required`)
  await mkdir(dirname(options.out), { recursive: true })
  const artifacts = options.out + '.files'
  await mkdir(artifacts)
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-flex-'))
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: 180_000 }), { command } = runner
  const report = { schemaVersion: 1, status: 'failed', engines: [], cleanup: {},
    boundary: 'Actual pinned compiler output, native QuickJS/V8 Page handlers, selector geometry and complete Skia CPU RGBA. Not official DevTools, inline formatting, GPU, device or performance acceptance.' }
  const sources = async () => ({ fixture: await sourceHashes(FIXTURE), packer: await sourceHashes(resolve(ROOT, 'tools/container-manifest/src')),
    packerBin: await sourceHashes(resolve(ROOT, 'tools/container-manifest/bin')),
    crates: await sourceHashes(resolve(ROOT, 'crates')),
    ...Object.fromEntries(await Promise.all(['Cargo.toml', 'Cargo.lock', 'scripts/flex-layout-smoke.mjs', 'scripts/scrolling-smoke.mjs', 'scripts/simulator-cli-harness.mjs']
      .map(async path => [path, sha256(await readFile(resolve(ROOT, path)))]))) })
  async function save(name, bytes, gzip = false) {
    const data = gzip ? gzipSync(bytes, { mtime: 0 }) : bytes, path = name + (gzip ? '.gz' : '')
    await writeFile(resolve(artifacts, path), data)
    return { path, sha256: sha256(data), ...(gzip ? { rawSha256: sha256(bytes) } : {}) }
  }
  try {
    report.commit = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
    report.sourceBefore = await sources()
    let browser
    if (options.browserCorpus) {
      const bytes = await readFile(options.browserCorpus)
      browser = JSON.parse(bytes)
      assert.equal(browser.schemaVersion, 1)
      assert.deepEqual(browser.fixtureSources, report.sourceBefore.fixture, 'Chrome must use the same fixture bytes')
      report.auxiliaryChrome = { artifact: await save('browser-corpus.json', bytes),
        boundary: browser.boundary, ignoredComparisons: ['text-a.height', 'text-b.height'],
        reason: 'Native scalar word wrapping is not CSS inline/word-break parity; raw browser values remain unchanged.' }
    }
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
      for (const name of ['initial', 'narrow', 'scrolled']) {
        const narrow = name === 'narrow', scrolled = name === 'scrolled', prefix = resolve(temporary, `${engine}-${name}`)
        const script = [...(narrow ? [tap('toggle', 714), request('narrow-frame', 'render.commit', {
          templateId: 'template:pages/index/index.wxml', blobs, viewport: { width: 360, height: 800 } })] : []),
          ...(scrolled ? [tap('scroll', 674), request('fixed-tap', 'event.batch', { events: [{ type: 'tap', x: 351, y: 791 }] })] : []),
          tap('inspect', scrolled ? 654 : 754), request('read', 'api.call', { name: 'wx.getStorageSync', key: 'flex:observation' })]
        await writeFile(prefix + '.jsonl', script.map(message => JSON.stringify(message)).join('\n') + '\n')
        await command(options.simulatorBin, ['run', '--pack', pack, '--engine', engine, '--viewport', '360x800',
          '--script', prefix + '.jsonl', '--trace', prefix + '.trace.json', '--snapshot', prefix + '.snapshot.json', '--report', prefix + '.report.json'])
        const trace = await readFile(prefix + '.trace.json'), snapshot = await readFile(prefix + '.snapshot.json'), native = await readFile(prefix + '.report.json')
        const phase = { name, trace: await save(`${engine}-${name}.trace.json`, trace, true),
          snapshot: await save(`${engine}-${name}.snapshot.json`, snapshot, true), native: await save(`${engine}-${name}.report.json`, native) }
        entry.phases.push(phase)
        phase.observation = inspect(JSON.parse(trace), JSON.parse(snapshot), JSON.parse(native), engine, name, browser)
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
    const errors = []
    try { assert.equal(runner.active, null); report.cleanup.childrenStopped = true } catch (error) { errors.push(String(error)) }
    try { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporaryRemoved = true } catch (error) { errors.push(String(error)) }
    try { runner.dispose() } catch (error) { errors.push(String(error)) }
    if (errors.length) { report.status = 'failed'; report.cleanup.errors = errors }
    await writeFile(options.out, JSON.stringify(report, null, 2) + '\n')
  }
  process.stdout.write(JSON.stringify({ status: report.status, report: options.out, cleanup: report.cleanup }) + '\n')
  if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
