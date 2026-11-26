// @ts-nocheck
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { test } from 'vitest'
import { JobStore, PreviewStore, callTool, commitRelease, digestDirectory, initProject, inspectProject, listProjectFiles, listReleases, prepareRelease, publishRelease, readProjectFile, rollbackRelease, runScenario, serveMcp, writeProjectFile } from '../src/index.ts'

const errorCode = (error: unknown) => (error as { code?: string } | null)?.code

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'container-agent-test-'))
  await writeFile(join(root, 'project.config.json'), JSON.stringify({ miniprogramRoot: 'dist', srcMiniprogramRoot: '.', appid: 'touristappid' }))
  await writeFile(join(root, 'app.json'), JSON.stringify({ pages: ['pages/index/index'] }))
  await writeFile(join(root, 'app.js'), 'App({})\n')
  return root
}

async function fakeSimulator(root) {
  const script = join(root, 'fake-simulator.mjs')
  await writeFile(script, `import { createServer } from 'node:http'
let stateCalls = 0
let owner = null
const clients = new Set()
const state = () => ({ status: stateCalls++ < 2 ? 'starting' : 'ready', sessionId: 'fake-session', revision: 1, preview: { version: '1.0', epoch: owner ? '1' : '0', ownerClientId: owner, leaseDurationMs: 15000, expired: false }, viewAuthority: { sessionId: 'fake-session', revision: '1', surfaceGeneration: '1', previewEpoch: owner ? '1' : '0' } })
const body = request => new Promise((resolve, reject) => { let value = ''; request.on('data', chunk => { value += chunk }); request.on('end', () => resolve(value ? JSON.parse(value) : {})); request.on('error', reject) })
const broadcast = value => { const wire = 'event: bridge\\ndata: ' + JSON.stringify(value) + '\\n\\n'; for (const client of clients) client.write(wire) }
const server = createServer(async (request, response) => {
  if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html><body><h1 id="status">ready</h1><button id="increment">increment</button><output id="count">0</output><script>document.querySelector("#increment").addEventListener("click", () => { document.querySelector("#count").textContent = String(Number(document.querySelector("#count").textContent) + 1) })</script></body></html>'); return }
  if (request.url === '/api/state') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(state())); return }
  if (request.url === '/api/preview' && request.method === 'POST') { const value = await body(request); if (value.op === 'connect') owner = value.clientId; if (value.op === 'release' && value.clientId === owner) owner = null; response.writeHead(202, { 'content-type': 'application/json' }); response.end(JSON.stringify({ queued: true, requestId: value.requestId })); return }
  if (request.url === '/api/events') { response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); response.write(': ready\\n\\n'); clients.add(response); request.on('close', () => clients.delete(response)); return }
  if (request.url === '/api/bridge' && request.method === 'POST') { const value = await body(request); const messages = (value.messages ?? [value]).map(message => ({ ...message, kind: 'response', payload: { ok: true, echoedPreview: value.preview ?? null } })); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ queued: true })); setTimeout(() => broadcast({ messages }), 10); return }
  response.writeHead(404); response.end()
})
server.listen(0, '127.0.0.1', () => process.stdout.write('weapp-simulator: web surface http://127.0.0.1:' + server.address().port + '\\n'))
`)
  return script
}

test('inspectProject returns bounded project facts and a digest', async () => {
  const root = await fixture()
  const project = await inspectProject(root)
  assert.equal(project.kind, 'native')
  assert.deepEqual(project.pages, ['pages/index/index'])
  assert.match(project.sourceDigest, /^[a-f0-9]{64}$/)
})

test('inspectProject reports source compatibility findings with locations and evidence', async () => {
  const root = await fixture()
  await mkdir(join(root, 'pages/index'), { recursive: true })
  await writeFile(join(root, 'pages/index/index.js'), `Page({
  onLoad() {
    wx.getSystemInfo({ success() {} })
    wx.canIUse('button')
    wx.unknownCapability()
    const api = 'getSystemInfo'
    wx[api]()
    // wx.commentOnly()
  },
})\n`)
  await writeFile(join(root, 'pages/index/index.wxml'), `<view wx:if="{{ready}}">
  <button>Continue</button>
  <template is="row" />
  <unknown-widget />
</view>\n`)
  await writeFile(join(root, 'pages/index/index.wxss'), `.page { display: grid; position: sticky; }\n.box { padding: 12rpx; }\n`)

  const compatibility = (await inspectProject(root)).compatibility
  assert.equal(compatibility.method, 'static-source-scan')
  assert.equal(compatibility.baseline.kind, 'weapp-api-inventory')
  const findings = compatibility.findings
  const systemInfo = findings.find(finding => finding.kind === 'api' && finding.name === 'wx.getSystemInfo')
  assert.equal(systemInfo.status, 'partial')
  assert.equal(systemInfo.path, 'pages/index/index.js')
  assert.equal(systemInfo.line, 3)
  assert.deepEqual(systemInfo.evidence, ['api-unsupported-004', 'provider-system-001', 'provider-system-003', 'provider-system-004', 'provider-account-001', 'provider-ext-config-001', 'provider-system-005', 'provider-system-006', 'provider-system-007', 'provider-system-008'])
  assert.equal(findings.find(finding => finding.name === 'wx.canIUse').status, 'full')
  assert.equal(findings.find(finding => finding.name === 'wx.unknownCapability').status, 'unknown')
  assert.equal(findings.find(finding => finding.name === 'wx[dynamic]').status, 'unknown')
  assert.equal(findings.some(finding => finding.name === 'wx.commentOnly'), false)
  assert.equal(findings.find(finding => finding.kind === 'template' && finding.name === 'wx:if').status, 'unknown')
  assert.equal(findings.find(finding => finding.kind === 'component' && finding.name === 'button').status, 'unknown')
  assert.equal(findings.find(finding => finding.kind === 'component' && finding.name === 'unknown-widget').status, 'unknown')
  assert.equal(findings.find(finding => finding.kind === 'style' && finding.name === 'css-grid').status, 'unknown')
  assert.equal(findings.find(finding => finding.kind === 'style' && finding.name === 'wxss-rpx-units').status, 'unknown')
  assert.ok(compatibility.counts.partial >= 1)
  assert.ok(compatibility.counts.unknown >= 1)
})

test('digestDirectory changes when project source changes', async () => {
  const root = await fixture()
  const before = await digestDirectory(root)
  await writeFile(join(root, 'app.js'), 'App({ data: { changed: true } })\n')
  assert.notEqual(await digestDirectory(root), before)
})

test('project file tools expose source files and write atomically within the project', async () => {
  const root = await fixture()
  assert.ok((await listProjectFiles(root)).files.includes('app.js'))
  assert.equal((await readProjectFile(root, 'app.js')).content, 'App({})\n')
  const written = await writeProjectFile(root, 'pages/index/index.wxml', '<view>hello</view>\n')
  assert.equal(written.path, 'pages/index/index.wxml')
  assert.equal((await readProjectFile(root, 'pages/index/index.wxml')).content, '<view>hello</view>\n')
  await assert.rejects(() => writeProjectFile(root, '../outside.js', 'bad'), error => errorCode(error) === 'ERR_SOURCE_PATH')
  await assert.rejects(() => writeProjectFile(root, 'node_modules/pkg.js', 'bad'), error => errorCode(error) === 'ERR_SOURCE_PATH')
})

test('release lifecycle writes a manifest and current pointer', async () => {
  const root = await fixture()
  const pack = join(root, 'pack')
  const build = { packDirectory: pack, sourceDigest: await digestDirectory(root), compilerCommit: 'unknown', project: await inspectProject(root), generatedAt: new Date().toISOString(), manifest: {} }
  await writeFile(join(root, 'dist-placeholder'), 'x')
  await writeFile(join(root, 'pack-placeholder'), 'x')
  await mkdir(pack, { recursive: true })
  await writeFile(join(pack, 'manifest.json'), '{}')
  const prepared = await prepareRelease(root, '1.0.0', { buildResult: build, evidence: [{ type: 'fixture', status: 'passed' }] })
  assert.equal(prepared.status, 'verified')
  await assert.rejects(() => commitRelease(root, '1.0.0'), error => errorCode(error) === 'ERR_CONFIRMATION_REQUIRED')
  const committed = await commitRelease(root, '1.0.0', { confirmed: true })
  assert.equal(committed.status, 'committed')
  assert.equal((await listReleases(root)).current.version, '1.0.0')
  await assert.rejects(() => rollbackRelease(root, '1.0.0'), error => errorCode(error) === 'ERR_CONFIRMATION_REQUIRED')
  assert.equal((await rollbackRelease(root, '1.0.0', { confirmed: true })).current, '1.0.0')
  const release = JSON.parse(await readFile(join(root, '.weapp-container/releases/1.0.0/release.json'), 'utf8'))
  assert.equal(release.version, '1.0.0')
})

test('concurrent release preparation publishes one complete version', async () => {
  const root = await fixture()
  const pack = join(root, 'pack')
  await mkdir(pack, { recursive: true })
  await writeFile(join(pack, 'manifest.json'), '{}')
  const build = { packDirectory: pack, sourceDigest: await digestDirectory(root), compilerCommit: 'unknown', project: await inspectProject(root), generatedAt: new Date().toISOString(), manifest: {} }
  const prepared = await Promise.allSettled([
    prepareRelease(root, '1.1.0', { buildResult: build, evidence: [{ type: 'fixture', status: 'passed' }] }),
    prepareRelease(root, '1.1.0', { buildResult: build, evidence: [{ type: 'fixture', status: 'passed' }] }),
  ])
  assert.equal(prepared.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(prepared.filter(result => result.status === 'rejected' && errorCode(result.reason) === 'ERR_RELEASE_EXISTS').length, 1)
  const listing = await listReleases(root)
  assert.equal(listing.releases.length, 1)
  assert.equal(listing.releases[0].status, 'verified')
  assert.equal(await readFile(join(root, '.weapp-container/releases/1.1.0/pack/manifest.json'), 'utf8'), '{}')
})

test('initProject creates an explicit local agent marker once', async () => {
  const root = await fixture()
  const initialized = await initProject(root)
  assert.equal(initialized.projectRoot, root)
  await assert.rejects(() => initProject(root), error => errorCode(error) === 'ERR_ALREADY_INITIALIZED')
})

test('JobStore starts work asynchronously and persists durable events', async () => {
  const root = await fixture()
  const jobs = new JobStore(root)
  const job = await jobs.start('test', {}, async () => ({ status: 'passed', value: 42 }))
  assert.equal(job.status, 'queued')
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await jobs.status(job.jobId)
    if (current.status === 'passed') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const current = await jobs.status(job.jobId)
  assert.equal(current.status, 'passed')
  assert.equal(Object.hasOwn(current, 'event'), false)
  assert.ok((await jobs.events(job.jobId)).some(event => event.type === 'job.completed'))
})

test('PreviewStore controls only its authenticated local daemon', async () => {
  const root = await fixture()
  const simulator = join(root, 'fake-simulator.mjs')
  await writeFile(simulator, `import { createServer } from 'node:http'
const server = createServer((request, response) => {
  if (request.url === '/api/state') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'ready' })); return }
  response.writeHead(404); response.end()
})
server.listen(0, '127.0.0.1', () => process.stdout.write('weapp-simulator: web surface http://127.0.0.1:' + server.address().port + '\\n'))
`)
  const preview = new PreviewStore(root)
  let started
  try {
    started = await preview.start({ simulatorCommand: process.execPath, simulatorPrefix: [simulator], timeoutMs: 5000 })
    assert.equal(started.status, 'ready')
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    assert.equal((await preview.status()).status, 'ready')
  } finally {
    await preview.stop()
  }
  assert.equal((await preview.status()).status, 'closed')
})

test('PreviewStore rejects control targets outside loopback before making a request', async () => {
  const root = await fixture()
  const stateRoot = join(root, '.weapp-container')
  await mkdir(stateRoot, { recursive: true })
  await writeFile(join(stateRoot, 'preview.json'), JSON.stringify({
    schemaVersion: 2,
    project: root,
    controlUrl: 'http://example.invalid:1234/',
    token: 'a'.repeat(64),
  }))
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new Error('unexpected network request') }
  try {
    assert.equal((await new PreviewStore(root).status()).status, 'unknown')
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scenario waits for ready and accepts only matching SSE bridge responses', async () => {
  const root = await fixture()
  const simulator = await fakeSimulator(root)
  const preview = new PreviewStore(root)
  try {
    const started = await preview.start({ simulatorCommand: process.execPath, simulatorPrefix: [simulator], timeoutMs: 5000 })
    assert.equal(started.status, 'ready')
    const result = await runScenario({ request: (path, options) => preview.request(path, options), status: () => preview.status() }, {
      steps: [{ op: 'bridge', clientId: 'scenario-client', request: { op: 'view.events', payload: { events: [] } } }],
    })
    assert.equal(result.status, 'passed')
    assert.equal(result.steps[0].value.messages[0].payload.echoedPreview.clientId, 'scenario-client')
  } finally {
    await preview.stop()
  }
})

test('scenario drives a browser page and writes a screenshot artifact', async t => {
  const root = await fixture()
  const simulator = await fakeSimulator(root)
  const preview = new PreviewStore(root)
  try {
    const started = await preview.start({ simulatorCommand: process.execPath, simulatorPrefix: [simulator], timeoutMs: 5000 })
    assert.equal(started.status, 'ready')
    let result
    try {
      result = await runScenario({ request: (path, options) => preview.request(path, options), status: () => preview.status() }, {
        browser: { headless: true },
        steps: [
          { op: 'browser', action: 'goto' },
          { op: 'browser', action: 'locator', selector: '#status', property: 'text', expect: { value: 'ready' } },
          { op: 'browser', action: 'click', selector: '#increment' },
          { op: 'browser', action: 'locator', selector: '#count', property: 'text', expect: { value: '1' } },
          { op: 'browser', action: 'screenshot', path: 'browser/flow.png', expect: { action: 'screenshot' } },
        ],
      }, { projectRoot: root, artifactRoot: join(root, '.weapp-container/agent/artifacts/browser-test') })
    } catch (error) {
      if (errorCode(error) === 'ERR_BROWSER_UNAVAILABLE' || /browser|executable|chromium|chrome/i.test((error as { message?: string } | null)?.message ?? '')) {
        t.skip(`browser unavailable: ${(error as { message?: string } | null)?.message ?? String(error)}`)
        return
      }
      throw error
    }
    assert.equal(result.status, 'passed')
    const screenshot = await readFile(join(root, '.weapp-container/agent/artifacts/browser-test/browser/flow.png'))
    assert.deepEqual([...screenshot.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  } finally {
    await preview.stop()
  }
})

test('callTool reuses the project JobStore so cancellation reaches the running test', async () => {
  const root = await fixture()
  const simulator = await fakeSimulator(root)
  const started = await callTool('container_test_start', {
    projectPath: root,
    preview: { simulatorCommand: process.execPath, simulatorPrefix: [simulator], timeoutMs: 5000 },
    scenario: { steps: [{ op: 'wait', ms: 2000 }] },
  })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  const cancelled = await callTool('container_test_cancel', { projectPath: root, jobId: started.jobId })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await callTool('container_job_status', { projectPath: root, jobId: started.jobId })).status, 'cancelled')
})

test('rollback rejects a prepared release and release commit detects pack tampering', async () => {
  const root = await fixture()
  const pack = join(root, 'pack')
  const build = { packDirectory: pack, sourceDigest: await digestDirectory(root), compilerCommit: 'unknown', project: await inspectProject(root), generatedAt: new Date().toISOString(), manifest: {} }
  await (await import('node:fs/promises')).mkdir(pack, { recursive: true })
  await writeFile(join(pack, 'manifest.json'), '{}')
  await prepareRelease(root, '2.0.0', { buildResult: build, evidence: [{ type: 'fixture', status: 'passed' }] })
  await assert.rejects(() => rollbackRelease(root, '2.0.0', { confirmed: true }), error => errorCode(error) === 'ERR_RELEASE_INVALID_STATE')
  await commitRelease(root, '2.0.0', { confirmed: true })
  await writeFile(join(root, '.weapp-container/releases/2.0.0/pack/tampered.txt'), 'tampered')
  await assert.rejects(() => commitRelease(root, '2.0.0', { confirmed: true }), error => errorCode(error) === 'ERR_RELEASE_INTEGRITY')
})

test('publishRelease requires a committed release and writes a redacted upload receipt', async () => {
  const root = await fixture()
  const pack = join(root, 'pack')
  const key = join(root, 'private.key')
  await writeFile(key, 'test-private-key')
  const build = { packDirectory: pack, sourceDigest: await digestDirectory(root), compilerCommit: 'unknown', project: await inspectProject(root), generatedAt: new Date().toISOString(), manifest: {} }
  await mkdir(pack, { recursive: true })
  await writeFile(join(pack, 'manifest.json'), '{}')
  await prepareRelease(root, '3.0.0', { buildResult: build, evidence: [{ type: 'fixture', status: 'passed' }] })
  await commitRelease(root, '3.0.0', { confirmed: true })
  const calls = []
  const published = await publishRelease(root, '3.0.0', {
    confirmed: true,
    privateKeyPath: key,
    commandRunner: async (command, args, options) => {
      calls.push({ command, args, env: options.env })
      return { code: 0, signal: null, stdout: 'upload complete', stderr: '' }
    },
  })
  assert.equal(published.status, 'uploaded')
  assert.equal(calls[0].args[1], '--upload')
  assert.equal(calls[0].env.WEAPP_CI_PRIVATE_KEY_PATH, key)
  assert.equal(JSON.stringify(published).includes('test-private-key'), false)
})

test('MCP tool failures are tool results with isError', async () => {
  const root = await fixture()
  const chunks = []
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback() } })
  await serveMcp(root, Readable.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'container_job_status', arguments: { jobId: 'bad' } } })}\n`), output)
  const response = JSON.parse(chunks.join(''))
  assert.equal(response.error, undefined)
  assert.equal(response.result.isError, true)
  assert.equal(response.result.structuredContent.code, 'ERR_JOB_NOT_FOUND')
})
