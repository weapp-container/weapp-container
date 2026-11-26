import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { generateKeyPairSync, sign } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { buildDebRoot, createDmg, debianPackageVersion, msiProductCode, msiProductVersion, renderDebControl, renderMsiSource, validateInstallerSigningEnvironment } from './lib/devtools-installers.mjs'
import { collectLicenses, copyCompiler, createArchive, packageDevtools } from './package-devtools-release.mjs'
import { createLauncher, simulatorArguments } from './devtools-launcher.mjs'
import { canonicalUpdatePayload, checkForUpdate, verifyUpdateManifest } from './lib/devtools-update.mjs'
import { inspectProject } from './devtools-compatibility.mjs'
import { createUpdateManifest } from './create-devtools-update-manifest.mjs'

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
  assert.deepEqual(simulatorArguments(project, 'desktop'), ['dev', '--project', project, '--surface', 'desktop'])
  assert.throws(() => simulatorArguments(project, 'mobile'), /请选择 Web Player 或 Desktop Player/)
  assert.deepEqual(simulatorArguments(project, 'web', { software: true }), ['dev', '--project', project, '--surface', 'web', '--software'])
  assert.deepEqual(simulatorArguments(project, 'web', { outDir: '/tmp/devtools output' }), ['dev', '--project', project, '--surface', 'web', '--out-dir', '/tmp/devtools output'])
})

test('launcher serves a loopback-only authenticated API and owns child shutdown', async t => {
  const directory = await temporaryDirectory(t)
  const installRoot = join(directory, 'DevTools Bundle')
  const project = join(directory, 'Example Mini Program')
  const simulatorExecutable = process.platform === 'win32' ? 'weapp-simulator.exe' : 'weapp-simulator'
  await mkdir(join(installRoot, 'scripts'), { recursive: true })
  await mkdir(join(installRoot, 'bin'), { recursive: true })
  await mkdir(project)
  await writeFile(join(installRoot, 'scripts/devtools-launcher.html'), await readFile(resolve(process.cwd(), 'scripts/devtools-launcher.html'), 'utf8'))
  await writeFile(join(installRoot, 'bin', simulatorExecutable), 'fixture')
  await chmod(join(installRoot, 'bin', simulatorExecutable), 0o755)
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'fixture' }))
  await writeFile(join(project, 'project.config.json'), JSON.stringify({ compileType: 'miniprogram', miniprogramRoot: '.', srcMiniprogramRoot: '.' }))
  await writeFile(join(project, 'app.json'), JSON.stringify({ pages: ['pages/index/index'] }))

  let page
  let spawnArguments
  let spawnOptions
  let ownedChild
  const launcher = await createLauncher({
    installRoot,
    openBrowser: value => { page = value },
    chooseProject: async () => project,
    spawnProcess: (_executable, arguments_, options) => {
      spawnArguments = arguments_
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
  const launcherHtml = await html.text()
  assert.match(launcherHtml, /DevTools/)
  assert.match(launcherHtml, /<option value="desktop" selected>Desktop Player<\/option>/)
  assert.match(launcherHtml, /<option value="web">Web Player<\/option>/)
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

  const preflight = await api('/api/preflight', { project })
  assert.equal(preflight.status, 200)
  assert.equal((await preflight.json()).appPath, join(await realpath(project), 'app.json'))
  const updateCheck = await api('/api/update/check')
  assert.equal(updateCheck.status, 200)
  assert.equal((await updateCheck.json()).status, 'disabled')

  const start = await api('/api/start', { project })
  assert.equal(start.status, 202)
  assert.deepEqual(spawnArguments, ['dev', '--project', await realpath(project), '--surface', 'desktop'])
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

  const webStart = await api('/api/start', { project, surface: 'web' })
  assert.equal(webStart.status, 202)
  assert.deepEqual(spawnArguments, ['dev', '--project', await realpath(project), '--surface', 'web'])
  await api('/api/stop', {})
  await Promise.all([launcher.close(), launcher.close()])
})

test('launcher validates the project and reports malformed project metadata', async t => {
  const directory = await temporaryDirectory(t)
  const installRoot = join(directory, 'distribution')
  const project = join(directory, 'invalid project')
  await mkdir(join(installRoot, 'scripts'), { recursive: true })
  await writeFile(join(installRoot, 'scripts/devtools-launcher.html'), '<!doctype html>')
  await mkdir(project)
  await writeFile(join(project, 'project.config.json'), '{')
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

test('update manifests require an Ed25519 signature and select the newest compatible release', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const unsigned = {
    schemaVersion: 1,
    channel: 'stable',
    releases: [
      { version: '0.2.0', target: 'macos-arm64', arch: 'x64', url: 'https://example.invalid/incompatible.dmg', sha256: 'c'.repeat(64), size: 10 },
      { version: '0.1.0', target: 'macos-arm64', arch: 'arm64', url: 'https://example.invalid/new.dmg', sha256: 'a'.repeat(64), size: 10 },
      { version: '0.0.9', target: 'macos-arm64', arch: 'arm64', url: 'https://example.invalid/old.dmg', sha256: 'b'.repeat(64), size: 10 },
    ],
  }
  const signature = sign(null, Buffer.from(canonicalUpdatePayload(unsigned)), privateKey).toString('base64url')
  const manifest = { ...unsigned, signature }
  assert.deepEqual(verifyUpdateManifest(manifest, { publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }), unsigned)
  const result = await checkForUpdate({
    metadata: {
      version: '0.0.8', target: 'macos-arm64', arch: 'arm64',
      update: { manifestUrl: 'https://example.invalid/updates.json', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) },
    },
    fetchImpl: async () => ({ ok: true, json: async () => manifest }),
  })
  assert.equal(result.status, 'available')
  assert.equal(result.candidate.version, '0.1.0')
  assert.equal(result.candidate.sha256, 'a'.repeat(64))
  assert.throws(() => verifyUpdateManifest({ ...manifest, signature: 'invalid' }, { publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }), /signature/)
  assert.throws(() => verifyUpdateManifest({ ...manifest, releases: [...manifest.releases, { ...manifest.releases[0], version: '0.2.0', url: 'http://example.invalid/bad.dmg' }] }, { publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }), /HTTPS/)
})

test('the fixed compatibility matrix accepts all four published source projects', async () => {
  for (const project of [
    'examples/apps/community/miniprogram-demo-text',
    'examples/apps/community/ant-design-button',
    'examples/apps/community/taro-blended',
    'examples/apps/shop-demo',
  ]) {
    const result = await inspectProject(resolve(process.cwd(), project))
    assert.equal(result.compatibility.projectType, 'weapp-vite-miniprogram', project)
    assert.equal(basename(result.appPath), 'app.json', project)
    assert.equal(result.compatibility.compiler.expected, '0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e')
  }
})

test('stable update manifest generation is deterministic over verified installer assets', async t => {
  const directory = await temporaryDirectory(t)
  const assets = join(directory, 'assets')
  await mkdir(assets)
  for (const filename of ['weapp-container-devtools-macos-arm64.dmg', 'weapp-container-devtools-macos-x86_64.dmg', 'weapp-container-devtools-linux-x86_64.deb', 'weapp-container-devtools-windows-x86_64.msi']) {
    await writeFile(join(assets, filename), `${filename}\n`)
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const manifest = await createUpdateManifest({
    assetsDirectory: assets, version: '1.0.0', tag: 'devtools-v1.0.0', privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  })
  assert.equal(manifest.channel, 'stable')
  assert.equal(manifest.releases.length, 4)
  assert.match(manifest.signature, /^[A-Za-z0-9_-]+$/)
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

test('compiler packaging preserves the runnable CLI entry in both package locations', async t => {
  const directory = await temporaryDirectory(t)
  const sourceWorkspace = join(directory, 'source-workspace')
  const compilerSource = join(sourceWorkspace, 'packages/weapp-vite')
  const targetRoot = join(directory, 'staging')
  const temporaryRoot = join(directory, 'temporary')
  await mkdir(join(compilerSource, 'bin'), { recursive: true })
  await mkdir(join(compilerSource, 'dist'), { recursive: true })
  await writeFile(join(compilerSource, 'package.json'), JSON.stringify({
    name: 'weapp-vite',
    version: '7.5.0',
    type: 'module',
    main: './dist/index.mjs',
    exports: { './*': './*' },
    files: ['bin', 'dist'],
    dependencies: {},
  }))
  await writeFile(join(compilerSource, 'bin/weapp-vite.js'), '#!/usr/bin/env node\n')
  await writeFile(join(compilerSource, 'dist/index.mjs'), 'export {}\n')
  await writeFile(join(compilerSource, 'dist/cli.mjs'), 'export {}\n')
  await mkdir(join(compilerSource, 'src'), { recursive: true })
  await mkdir(join(compilerSource, 'test'), { recursive: true })
  await writeFile(join(compilerSource, 'src/index.ts'), 'export {}\n')
  await writeFile(join(compilerSource, 'test/compiler.test.ts'), 'test.skip()\n')

  await copyCompiler(targetRoot, { node: 'darwin-arm64', os: 'darwin', cpu: 'arm64' }, temporaryRoot, sourceWorkspace)

  for (const location of ['packages/weapp-vite', 'node_modules/weapp-vite']) {
    const packagePath = join(targetRoot, 'vendor/weapp-vite', location)
    assert.equal(await readFile(join(packagePath, 'dist/cli.mjs'), 'utf8'), 'export {}\n')
    await assert.rejects(readFile(join(packagePath, 'src/index.ts')))
    await assert.rejects(readFile(join(packagePath, 'test/compiler.test.ts')))
  }
})

test('installer metadata maps preview versions to native package formats', () => {
  assert.equal(msiProductVersion('0.1.0-preview.7.2'), '0.1.702')
  assert.equal(msiProductVersion('0.1.0'), '0.1.999')
  assert.equal(msiProductVersion('0.1.1-preview.1.0'), '0.1.1100')
  assert.equal(debianPackageVersion('0.1.0-preview.7.2'), '0.1.0~preview.7.2')
  assert.match(renderDebControl('0.1.0-preview.7.2'), /Version: 0\.1\.0~preview\.7\.2/)
  assert.match(renderDebControl('0.1.0-preview.7.2'), /Architecture: amd64/)
  assert.match(renderDebControl('0.1.0-preview.7.2'), /libgtk-3-0/)
  assert.match(renderDebControl('0.1.0-preview.7.2'), /libwebkit2gtk-4\.1-0/)
  assert.match(renderMsiSource('0.1.0-preview.7.2'), /Version="0\.1\.702"/)
  assert.match(renderMsiSource('0.1.0-preview.7.2'), /InstallScope="perUser"/)
  assert.match(renderMsiSource('0.1.0-preview.7.2'), /AllowDowngrades="yes"/)
  assert.doesNotMatch(renderMsiSource('0.1.0-preview.7.2'), /AllowSameVersionUpgrades/)
  assert.ok(renderMsiSource('0.1.0-preview.7.2').includes(String.raw`Target="[INSTALLFOLDER]bin\weapp-devtools.vbs"`))
  assert.ok(renderMsiSource('0.1.0-preview.7.2').includes(String.raw`Key="Software\WeappContainer\DevTools"`))
  assert.equal(msiProductCode('0.1.0-preview.7.2'), msiProductCode('0.1.0-preview.7.2'))
  assert.notEqual(msiProductCode('0.1.0-preview.7.1'), msiProductCode('0.1.0-preview.7.2'))
})

test('launcher refuses malformed installed DevTools metadata', async t => {
  const directory = await temporaryDirectory(t)
  const installRoot = join(directory, 'distribution')
  await mkdir(installRoot, { recursive: true })
  await writeFile(join(installRoot, 'weapp-devtools.json'), '{')
  await assert.rejects(createLauncher({ installRoot, openBrowser() {} }), /JSON|position|property/i)
})

test('installer metadata rejects versions that cannot be represented safely', () => {
  assert.throws(() => msiProductVersion('256.0.0'), /Windows Installer version limits/)
  assert.throws(() => msiProductVersion('0.1.0-preview.10.0'), /Windows Installer version limits/)
  assert.throws(() => debianPackageVersion('preview'), /Unsupported DevTools release version/)
})

test('stable installer signing fails closed while previews may remain unsigned', () => {
  for (const target of ['macos-arm64', 'macos-x86_64']) {
    assert.deepEqual(validateInstallerSigningEnvironment(target, '1.0.0-preview.1.0', {}), { enabled: false, notarize: false })
    assert.throws(() => validateInstallerSigningEnvironment(target, '1.0.0', {}), new RegExp(`Stable ${target} signing requires`))
    assert.deepEqual(validateInstallerSigningEnvironment(target, '1.0.0-preview.1.0', { WEAPP_DEVTOOLS_MACOS_SIGNING_IDENTITY: 'Developer ID Application: Example' }), { enabled: true, notarize: false })
    assert.throws(() => validateInstallerSigningEnvironment(target, '1.0.0-preview.1.0', { WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_PATH: 'key.p8' }), new RegExp(`Preview ${target} signing requires`))
  }
  assert.deepEqual(validateInstallerSigningEnvironment('windows-x86_64', '1.0.0', {
    WEAPP_DEVTOOLS_WINDOWS_SIGNTOOL: 'signtool.exe',
    WEAPP_DEVTOOLS_WINDOWS_SIGNING_CERTIFICATE_PATH: 'certificate.pfx',
    WEAPP_DEVTOOLS_WINDOWS_SIGNING_CERTIFICATE_PASSWORD: 'secret',
  }), { enabled: true })
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
  await mkdir(join(source, 'bin'), { recursive: true })
  await mkdir(join(source, 'node/bin'), { recursive: true })
  await mkdir(join(source, 'scripts'), { recursive: true })
  await writeFile(join(source, 'bin/weapp-devtools-native'), 'native launcher')
  await chmod(join(source, 'bin/weapp-devtools-native'), 0o755)
  await writeFile(join(source, 'node/bin/node'), 'node')
  await writeFile(join(source, 'scripts/devtools-launcher.mjs'), 'launcher')
  await writeFile(join(source, 'LICENSE'), 'license')
  await writeFile(join(source, 'README.md'), 'readme')
  await mkdir(mountPoint)

  const signingEnvironment = ['WEAPP_DEVTOOLS_MACOS_SIGNING_IDENTITY', 'WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_PATH', 'WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_ID', 'WEAPP_DEVTOOLS_MACOS_NOTARY_ISSUER']
  const previousSigningEnvironment = Object.fromEntries(signingEnvironment.map(name => [name, process.env[name]]))
  process.env.WEAPP_DEVTOOLS_MACOS_SIGNING_IDENTITY = '-'
  for (const name of signingEnvironment.slice(1)) delete process.env[name]
  try {
    await createDmg({ target: 'macos-arm64', source, output, version: '0.1.0-preview.7.2', iconPath })
  } finally {
    for (const name of signingEnvironment) {
      if (previousSigningEnvironment[name] === undefined) delete process.env[name]
      else process.env[name] = previousSigningEnvironment[name]
    }
  }
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, output], { stdio: 'ignore' })
  try {
    const app = join(mountPoint, 'Weapp Container DevTools.app')
    assert.equal(await readFile(join(app, 'Contents/Info.plist'), 'utf8').then(value => /CFBundleIdentifier/.test(value)), true)
    const appExecutable = await readFile(join(app, 'Contents/MacOS/WeappContainerDevTools'), 'utf8')
    assert.equal(appExecutable.startsWith('#!/bin/sh'), true)
    assert.match(appExecutable, /exec "\$RESOURCES\/bin\/weapp-devtools-native"/)
    assert.equal(await readFile(join(app, 'Contents/Resources/bin/weapp-devtools-native'), 'utf8'), 'native launcher')
    assert.equal((await lstat(join(app, 'Contents/Resources/bin/weapp-devtools-native'))).mode & 0o111, 0o111)
    assert.equal(await readFile(join(app, 'Contents/Resources/scripts/devtools-launcher.mjs'), 'utf8'), 'launcher')
    assert.equal((await lstat(join(mountPoint, 'Applications'))).isSymbolicLink(), true)
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' })
  } finally {
    execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'ignore' })
  }
})

test('package refuses unknown targets before touching the output directory', async t => {
  const directory = await temporaryDirectory(t)
  const output = join(directory, 'must-not-exist')
  await assert.rejects(packageDevtools({ target: 'freebsd-x86_64', output }), /Unsupported target/)
})
