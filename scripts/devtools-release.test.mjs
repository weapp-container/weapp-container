import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { buildDebRoot, createDmg, debianPackageVersion, msiProductCode, msiProductVersion, renderDebControl, renderMsiSource } from './lib/devtools-installers.mjs'
import { collectLicenses, createArchive, packageDevtools } from './package-devtools-release.mjs'
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
  const simulatorExecutable = process.platform === 'win32' ? 'weapp-simulator.exe' : 'weapp-simulator'
  await mkdir(join(installRoot, 'scripts'), { recursive: true })
  await mkdir(join(installRoot, 'bin'), { recursive: true })
  await mkdir(project)
  await writeFile(join(installRoot, 'scripts/devtools-launcher.html'), '<!doctype html><title>DevTools</title>')
  await writeFile(join(installRoot, 'bin', simulatorExecutable), 'fixture')
  await chmod(join(installRoot, 'bin', simulatorExecutable), 0o755)
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

test('installer metadata maps preview versions to native package formats', () => {
  assert.equal(msiProductVersion('0.1.0-preview.7.2'), '0.1.702')
  assert.equal(msiProductVersion('0.1.0'), '0.1.999')
  assert.equal(msiProductVersion('0.1.1-preview.1.0'), '0.1.1100')
  assert.equal(debianPackageVersion('0.1.0-preview.7.2'), '0.1.0~preview.7.2')
  assert.match(renderDebControl('0.1.0-preview.7.2'), /Version: 0\.1\.0~preview\.7\.2/)
  assert.match(renderDebControl('0.1.0-preview.7.2'), /Architecture: amd64/)
  assert.match(renderMsiSource('0.1.0-preview.7.2'), /Version="0\.1\.702"/)
  assert.match(renderMsiSource('0.1.0-preview.7.2'), /InstallScope="perUser"/)
  assert.ok(renderMsiSource('0.1.0-preview.7.2').includes(String.raw`Target="[INSTALLFOLDER]bin\weapp-devtools.vbs"`))
  assert.ok(renderMsiSource('0.1.0-preview.7.2').includes(String.raw`Key="Software\WeappContainer\DevTools"`))
  assert.equal(msiProductCode('0.1.0-preview.7.2'), msiProductCode('0.1.0-preview.7.2'))
  assert.notEqual(msiProductCode('0.1.0-preview.7.1'), msiProductCode('0.1.0-preview.7.2'))
})

test('installer metadata rejects versions that cannot be represented safely', () => {
  assert.throws(() => msiProductVersion('256.0.0'), /Windows Installer version limits/)
  assert.throws(() => msiProductVersion('0.1.0-preview.10.0'), /Windows Installer version limits/)
  assert.throws(() => debianPackageVersion('preview'), /Unsupported DevTools release version/)
})

test('Debian package layout includes launcher, menu entry, icon, licenses, and runtime metadata', async t => {
  const directory = await temporaryDirectory(t)
  const source = join(directory, 'DevTools Bundle')
  const packageRoot = join(directory, 'deb-root')
  const iconPath = join(directory, 'icon.png')
  await mkdir(join(source, 'bin'), { recursive: true })
  await writeFile(join(source, 'bin/weapp-devtools'), 'launcher')
  await writeFile(join(source, 'LICENSE'), 'license')
  await writeFile(join(source, 'README.md'), 'readme')
  await writeFile(iconPath, 'icon')

  await buildDebRoot(source, packageRoot, '0.1.0-preview.7.2', iconPath)

  assert.match(await readFile(join(packageRoot, 'DEBIAN/control'), 'utf8'), /Version: 0\.1\.0~preview\.7\.2/)
  assert.equal(await readFile(join(packageRoot, 'usr/bin/weapp-devtools'), 'utf8'), '#!/bin/sh\nset -eu\nexec /opt/weapp-container-devtools/bin/weapp-devtools "$@"\n')
  assert.match(await readFile(join(packageRoot, 'usr/share/applications/weapp-container-devtools.desktop'), 'utf8'), /Exec=weapp-devtools gui/)
  assert.equal(await readFile(join(packageRoot, 'usr/share/icons/hicolor/128x128/apps/weapp-container-devtools.png'), 'utf8'), 'icon')
  assert.equal(await readFile(join(packageRoot, 'usr/share/doc/weapp-container-devtools/copyright'), 'utf8'), 'license')
})

test('dependency licenses use shallow paths for Windows Installer harvesting', async t => {
  const directory = await temporaryDirectory(t)
  const installRoot = join(directory, 'DevTools Bundle')
  const packageRoot = join(installRoot, 'vendor/weapp-vite/node_modules/@scope/compiler/node_modules/parser/node_modules/types/node_modules/string-utils')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@scope/string-utils', version: '1.2.3' }))
  await writeFile(join(packageRoot, 'LICENSE'), 'license text')

  await collectLicenses(installRoot)

  const licenseDirectory = join(installRoot, 'LICENSES/dependencies')
  const [packageDirectory] = await readdir(licenseDirectory)
  assert.match(packageDirectory, /^@scope\+string-utils-1\.2\.3-[a-f0-9]{8}$/)
  assert.equal(await readFile(join(licenseDirectory, packageDirectory, 'LICENSE'), 'utf8'), 'license text')
  assert.ok(join(licenseDirectory, packageDirectory, 'LICENSE').length < 180)
})

test('macOS DMG contains an Applications shortcut and a runnable app bundle', async t => {
  if (process.platform !== 'darwin') return t.skip('DMG validation requires macOS')
  const directory = await temporaryDirectory(t)
  const source = join(directory, 'DevTools Bundle')
  const output = join(directory, 'weapp-container-devtools.dmg')
  const iconPath = join(process.cwd(), 'assets/brand/png/weapp-container-avatar-128.png')
  const mountPoint = join(directory, 'mounted')
  await mkdir(join(source, 'node/bin'), { recursive: true })
  await mkdir(join(source, 'scripts'), { recursive: true })
  await writeFile(join(source, 'node/bin/node'), 'node')
  await writeFile(join(source, 'scripts/devtools-launcher.mjs'), 'launcher')
  await writeFile(join(source, 'LICENSE'), 'license')
  await writeFile(join(source, 'README.md'), 'readme')
  await mkdir(mountPoint)

  await createDmg({ source, output, version: '0.1.0-preview.7.2', iconPath })
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, output], { stdio: 'ignore' })
  try {
    const app = join(mountPoint, 'Weapp Container DevTools.app')
    assert.equal(await readFile(join(app, 'Contents/Info.plist'), 'utf8').then(value => /CFBundleIdentifier/.test(value)), true)
    assert.equal(await readFile(join(app, 'Contents/MacOS/WeappContainerDevTools'), 'utf8').then(value => value.startsWith('#!/bin/sh')), true)
    assert.equal(await readFile(join(app, 'Contents/Resources/scripts/devtools-launcher.mjs'), 'utf8'), 'launcher')
    assert.equal((await lstat(join(mountPoint, 'Applications'))).isSymbolicLink(), true)
  } finally {
    execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'ignore' })
  }
})

test('package refuses unknown targets before touching the output directory', async t => {
  const directory = await temporaryDirectory(t)
  const output = join(directory, 'must-not-exist')
  await assert.rejects(packageDevtools({ target: 'freebsd-x86_64', output }), /Unsupported target/)
})
