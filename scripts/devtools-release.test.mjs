import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { createArchive, packageDevtools } from './package-devtools-release.mjs'
import { createLauncher, simulatorArguments } from './devtools-launcher.mjs'

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.exitCode = null
    this.signalCode = null
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
  }

  kill(signal) {
    if (this.exitCode !== null || this.signalCode !== null) return true
    setImmediate(() => {
      this.signalCode = signal
      this.emit('exit', null, signal)
      this.stdout.end()
      this.stderr.end()
    })
    return true
  }
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'weapp-devtools-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('simulator CLI arguments keep paths with spaces as one argument', () => {
  const project = '/tmp/example mini program'
  assert.deepEqual(simulatorArguments(project, 'web'), ['dev', '--project', project, '--surface', 'web'])
  assert.throws(() => simulatorArguments(project, 'mobile'), /请选择 Web Player 或 Desktop Player/)
})

test('launcher serves a loopback-only authenticated API and owns child shutdown', async t => {
  const directory = await temporaryDirectory(t)
  const installRoot = join(directory, 'DevTools Bundle')
  const project = join(directory, 'Example Mini Program')
  await mkdir(join(installRoot, 'scripts'), { recursive: true })
  await mkdir(join(installRoot, 'bin'), { recursive: true })
  await mkdir(project)
  await writeFile(join(installRoot, 'scripts/devtools-launcher.html'), '<!doctype html><title>DevTools</title>')
  await writeFile(join(installRoot, 'bin/weapp-simulator'), 'fixture')
  await chmod(join(installRoot, 'bin/weapp-simulator'), 0o755)
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'fixture' }))

  let page
  let spawnOptions
  let ownedChild
  const launcher = await createLauncher({
    installRoot,
    openBrowser: value => { page = value },
    chooseProject: async () => project,
    spawnProcess: (_executable, _arguments, options) => {
      spawnOptions = options
      ownedChild = new FakeChild()
      setImmediate(() => ownedChild.stdout.write('weapp-simulator: web surface http://127.0.0.1:43121\n'))
      return ownedChild
    },
  })
  t.after(() => launcher.close())

  const pageUrl = new URL(page)
  const html = await fetch(pageUrl)
  assert.equal(html.status, 200)
  assert.match(await html.text(), /DevTools/)
  const token = new URLSearchParams(pageUrl.hash.slice(1)).get('session')
  const api = async (path, body, headers = {}) => fetch(new URL(path, pageUrl), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  assert.equal((await fetch(`http://localhost:${pageUrl.port}/api/status`, { headers: { authorization: `Bearer ${token}` } })).status, 403)
  assert.equal((await api('/api/status', undefined, { origin: 'http://example.invalid' })).status, 403)
  const browse = await api('/api/browse', {})
  assert.deepEqual((await browse.json()).project, project)

  const start = await api('/api/start', { project, surface: 'web' })
  assert.equal(start.status, 202)
  assert.equal(spawnOptions.cwd, await realpath(project))
  assert.ok(spawnOptions.env.PATH.includes(join(installRoot, 'bin')))
  assert.equal((await api('/api/start', { project, surface: 'web' })).status, 409)
  await new Promise(resolve => setTimeout(resolve, 10))
  const state = await (await api('/api/status')).json()
  assert.equal(state.running, true)
  assert.equal(state.previewUrl, 'http://127.0.0.1:43121')

  const stopped = await api('/api/stop', {})
  assert.equal(stopped.status, 200)
  assert.equal(ownedChild.signalCode, 'SIGINT')
  assert.equal((await (await api('/api/status')).json()).running, false)
})

test('launcher validates the project and reports malformed project metadata', async t => {
  const directory = await temporaryDirectory(t)
  const installRoot = join(directory, 'distribution')
  const project = join(directory, 'invalid project')
  await mkdir(join(installRoot, 'scripts'), { recursive: true })
  await writeFile(join(installRoot, 'scripts/devtools-launcher.html'), '<!doctype html>')
  await mkdir(project)
  await writeFile(join(project, 'package.json'), '{')
  let page
  const launcher = await createLauncher({ installRoot, openBrowser: value => { page = value } })
  t.after(() => launcher.close())
  const pageUrl = new URL(page)
  const response = await fetch(new URL('/api/start', pageUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${new URLSearchParams(pageUrl.hash.slice(1)).get('session')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ project, surface: 'web' }),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /JSON/)
})

test('Linux and macOS archives contain the package root and preserve relative paths', async t => {
  if (process.platform === 'win32') return t.skip('tar.gz validation runs on Unix')
  const directory = await temporaryDirectory(t)
  const source = join(directory, 'DevTools Bundle')
  await mkdir(join(source, 'bin'), { recursive: true })
  await writeFile(join(source, 'bin/weapp-devtools'), 'launcher')
  const archive = join(directory, 'DevTools Bundle.tar.gz')
  await createArchive(source, archive, 'linux-x86_64')
  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
  assert.match(listing, new RegExp(`^${basename(source)}/bin/weapp-devtools$`, 'm'))
})

test('package refuses unknown targets before touching the output directory', async t => {
  const directory = await temporaryDirectory(t)
  const output = join(directory, 'must-not-exist')
  await assert.rejects(packageDevtools({ target: 'freebsd-x86_64', output }), /Unsupported target/)
})
