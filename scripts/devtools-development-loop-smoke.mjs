#!/usr/bin/env node
/**
 * Exercise the packaged DevTools launcher through a real Web preview.
 *
 * This is a local packaged-launcher check. It does not certify official
 * WeChat DevTools, GPU presentation, an emulator, or a physical device.
 */
import assert from 'node:assert/strict'
import { access, chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import { createLauncher } from './devtools-launcher.mjs'
import { compatibilityMetadata, inspectProject } from './devtools-compatibility.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultProject = resolve(root, 'examples/apps/devtools-loop-app')
const defaultReport = join(homedir(), '.codex/private-validation/weapp-container/devtools-loop/report.json')

class BlockedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BlockedError'
    this.status = 'blocked'
  }
}

function valueAfter(args, index, name) {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

export function parseArgs(args = process.argv.slice(2)) {
  const options = {
    project: defaultProject,
    installRoot: null,
    surface: 'web',
    timeoutMs: 120_000,
    reportPath: defaultReport,
    help: false,
  }
  const seen = new Set()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--' && index === 0) continue
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    const names = new Map([
      ['--project', 'project'],
      ['--install-root', 'installRoot'],
      ['--surface', 'surface'],
      ['--timeout', 'timeoutMs'],
      ['--out', 'reportPath'],
    ])
    const key = names.get(argument)
    if (!key) throw new Error(`Unknown option ${argument}`)
    if (seen.has(argument)) throw new Error(`Duplicate option ${argument}`)
    seen.add(argument)
    const value = valueAfter(args, index, argument)
    index += 1
    if (key === 'timeoutMs') options[key] = Number(value)
    else options[key] = value
  }
  if (!['web', 'desktop'].includes(options.surface)) throw new Error('--surface must be web or desktop')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) throw new Error('--timeout must be an integer of at least 1000 ms')
  options.project = resolve(options.project)
  if (options.installRoot) options.installRoot = resolve(options.installRoot)
  options.reportPath = resolve(options.reportPath)
  return options
}

function usage() {
  return `Usage: pnpm devtools:loop:smoke -- [options]

Options:
  --project <dir>       project to open (default: examples/apps/devtools-loop-app)
  --install-root <dir>  use an existing DevTools bundle instead of a local stage
  --surface <name>      web (default) or desktop
  --timeout <ms>        wait timeout (default: 120000)
  --out <file>          JSON report path (default: ~/.codex/private-validation/weapp-container/devtools-loop/report.json)
`
}

async function exists(path, mode = constants.R_OK) {
  return access(path, mode).then(() => true).catch(() => false)
}

async function findFirstSource(directory, suffixes) {
  const ignored = new Set(['.git', '.weapp-container', 'dist', 'node_modules'])
  const matches = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await visit(join(current, entry.name))
      } else if (entry.isFile() && suffixes.some(suffix => entry.name.endsWith(suffix))) {
        matches.push(join(current, entry.name))
      }
    }
  }
  await visit(directory)
  matches.sort()
  return matches[0] ?? null
}

async function stageInstallRoot() {
  const installRoot = await mkdtemp(join(tmpdir(), 'weapp-devtools-loop-install-'))
  try {
    await mkdir(join(installRoot, 'bin'), { recursive: true })
    await mkdir(join(installRoot, 'node', process.platform === 'win32' ? '' : 'bin'), { recursive: true })
    await mkdir(join(installRoot, 'scripts'), { recursive: true })
    await copyFile(join(root, 'scripts/devtools-launcher.html'), join(installRoot, 'scripts/devtools-launcher.html'))
    const metadata = {
      schemaVersion: 1,
      name: 'weapp-container-devtools',
      version: '0.1.0-development-loop',
      target: `${process.platform}-${process.arch}`,
      arch: process.arch,
      weappViteCommit: compatibilityMetadata().compiler.commit,
      nodeVersion: process.versions.node,
      packageManager: compatibilityMetadata().packageManager,
    }
    await writeFile(join(installRoot, 'weapp-devtools.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    const binaryName = process.platform === 'win32' ? 'weapp-simulator.exe' : 'weapp-simulator'
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
    const simulatorBinary = resolve(root, 'target/debug', binaryName)
    if (!(await exists(simulatorBinary, constants.X_OK))) {
      throw new BlockedError(`debug simulator binary is unavailable: ${simulatorBinary}`)
    }
    const stagedSimulator = join(installRoot, 'bin', binaryName)
    const stagedNode = join(installRoot, 'node', process.platform === 'win32' ? nodeName : 'bin/node')
    if (process.platform === 'win32') {
      await copyFile(simulatorBinary, stagedSimulator)
      await copyFile(process.execPath, stagedNode)
    } else {
      await symlink(simulatorBinary, stagedSimulator)
      await symlink(process.execPath, stagedNode)
    }
    if (process.platform !== 'win32') await chmod(stagedSimulator, 0o755)
    return { installRoot, outputRoot: join(installRoot, '.smoke-output'), owned: true, async cleanup() { await rm(installRoot, { recursive: true, force: true }) } }
  } catch (error) {
    try {
      await rm(installRoot, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `failed to stage the DevTools bundle and clean up ${installRoot}`)
    }
    throw error
  }
}

async function requestJson(url, path, { token, method = 'GET', body } = {}) {
  const response = await fetch(new URL(path, url), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${value.error || 'request failed'}`)
  return value
}

async function waitFor(label, predicate, timeoutMs, delayMs = 100, lastObservation = () => undefined) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(delayMs, Math.max(1, deadline - Date.now()))))
  }
  throw new Error(`timed out waiting for ${label}; last observation: ${JSON.stringify(lastObservation() ?? last)}`)
}

async function writeOwned(path, text, expected, restoring = false) {
  const current = await readFile(path, 'utf8')
  if (!restoring && current !== expected.get(path)) throw new Error(`source changed concurrently: ${path}`)
  if (restoring && current !== expected.get(path)) throw new Error(`source changed while smoke was running: ${path}`)
  await writeFile(path, text)
  expected.set(path, text)
}

async function runDesktopLoop({ pageUrl, token, project, timeoutMs }) {
  await requestJson(pageUrl, '/api/start', { token, method: 'POST', body: { project, surface: 'desktop' } })
  try {
    const state = await waitFor('desktop child start', async () => {
      const value = await requestJson(pageUrl, '/api/status', { token })
      if (value.logs?.some(line => /watching weapp-vite project/i.test(line)) && value.running) return value
      if (value.logs?.some(line => /desktop surface requires/i.test(line))) {
        throw new BlockedError('desktop surface is unavailable in the current debug simulator binary')
      }
      if (!value.running && value.exitCode !== undefined) throw new Error(`desktop simulator exited: ${value.exitCode}; logs: ${JSON.stringify(value.logs?.slice(-20) || [])}`)
      return null
    }, Math.min(timeoutMs, 10_000))
    assert.equal(state.project, project)
    return { desktopProcessStart: 'passed' }
  } finally {
    await requestJson(pageUrl, '/api/stop', { token, method: 'POST', body: {} })
    await waitFor('desktop child cleanup', async () => !(await requestJson(pageUrl, '/api/status', { token })).running, Math.min(timeoutMs, 15_000))
  }
}

async function runWebLoop({ pageUrl, token, project, sourceFiles, timeoutMs, exerciseEdits }) {
  const { appPath, sourceRoot } = await requestJson(pageUrl, '/api/preflight', { token, method: 'POST', body: { project } })
  assert.ok(appPath.startsWith(`${sourceRoot}${sep}`) || appPath === join(sourceRoot, 'app.json'))
  await requestJson(pageUrl, '/api/start', { token, method: 'POST', body: { project, surface: 'web' } })
  let browser
  let context
  let simulatorUrl
  const checks = {
    preflight: 'passed',
    initialPage: 'not_checked',
    interaction: 'not_checked',
    wxssInPlace: 'not_checked',
    jsRestart: 'not_checked',
    buildFailure: 'not_checked',
    recovery: 'not_checked',
  }
  let result
  let operationError
  try {
    const launcherState = await waitFor('web preview URL', async () => {
      const value = await requestJson(pageUrl, '/api/status', { token })
      if (value.previewUrl) return value
      if (!value.running && value.exitCode !== undefined) {
        throw new Error(`simulator exited: ${value.exitCode}; logs: ${JSON.stringify(value.logs?.slice(-20) || [])}`)
      }
      return null
    }, timeoutMs)
    simulatorUrl = launcherState.previewUrl
    const state = () => requestJson(simulatorUrl, '/api/state')
    const snapshot = () => requestJson(simulatorUrl, '/api/snapshot')
    const initial = await waitFor('initial ready generation', async () => {
      const value = await state()
      return value.status === 'ready' && Number(value.revision) > 0 ? value : null
    }, timeoutMs)
    const playwrightPath = pathToFileURL(resolve(root, 'vendor/weapp-vite/node_modules/playwright/index.mjs')).href
    const { chromium } = await import(playwrightPath)
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(simulatorUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'ready', null, { timeout: timeoutMs })
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#screen')
      return Boolean(canvas?.width > 0 && canvas?.height > 0 && canvas.getContext('2d'))
    }, null, { timeout: timeoutMs })
    checks.initialPage = 'passed'
    const initialSnapshot = await snapshot()
    if (!Number.isInteger(initialSnapshot.width) || !Number.isInteger(initialSnapshot.height)
      || initialSnapshot.width <= 0 || initialSnapshot.height <= 0
      || initialSnapshot.pixels?.length !== initialSnapshot.width * initialSnapshot.height * 4) {
      throw new Error('initial Web preview snapshot is not a valid RGBA frame')
    }
    if (exerciseEdits) {
      let inkPixels = 0
      for (let index = 0; index < initialSnapshot.pixels.length; index += 4) {
        if (initialSnapshot.pixels[index] < 100 && initialSnapshot.pixels[index + 1] < 100
          && initialSnapshot.pixels[index + 2] < 100 && initialSnapshot.pixels[index + 3] > 0) inkPixels += 1
      }
      if (inkPixels <= 32) throw new Error('minimal fixture rendered an empty preview')
    }
    if (!exerciseEdits) {
      result = {
        simulatorUrl,
        initialSnapshot: { width: initialSnapshot.width, height: initialSnapshot.height, pixelBytes: initialSnapshot.pixels.length },
        checks,
      }
      return
    }
    const initialPixels = JSON.stringify(initialSnapshot.pixels)
    const canvasBounds = await page.locator('#screen').boundingBox()
    if (!canvasBounds) throw new Error('browser canvas has no layout bounds')
    await page.mouse.click(
      canvasBounds.x + canvasBounds.width * (134 / initialSnapshot.width),
      canvasBounds.y + canvasBounds.height * (148 / initialSnapshot.height),
    )
    await waitFor('canvas interaction', async () => JSON.stringify((await snapshot()).pixels) !== initialPixels, timeoutMs)
    checks.interaction = 'passed'

    await writeOwned(sourceFiles.wxss, `${sourceFiles.originals.get(sourceFiles.wxss)}\n/* DevTools loop WXSS reload ${Date.now()} */\n`, sourceFiles.expected)
    const styled = await waitFor('WXSS in-place reload', async () => {
      const value = await state()
      return value.revision > initial.revision && value.status === 'ready' ? value : null
    }, timeoutMs)
    assert.equal(styled.sessionId, initial.sessionId)
    checks.wxssInPlace = 'passed'

    const changedAppScript = sourceFiles.originals.get(sourceFiles.appScript).replace(
      "fixture: 'devtools-loop'",
      "fixture: 'devtools-loop-restarted'",
    )
    if (changedAppScript === sourceFiles.originals.get(sourceFiles.appScript)) throw new Error('minimal fixture no longer exposes its JS restart marker')
    await writeOwned(sourceFiles.appScript, changedAppScript, sourceFiles.expected)
    const restarted = await waitFor('JS restart', async () => {
      const value = await state()
      return value.revision > styled.revision && value.status === 'ready' ? value : null
    }, timeoutMs)
    assert.notEqual(restarted.sessionId, styled.sessionId)
    checks.jsRestart = 'passed'

    await writeOwned(sourceFiles.appJson, '{ invalid DevTools loop JSON', sourceFiles.expected)
    const broken = await waitFor('build failure diagnostic', async () => {
      const value = await state()
      return value.diagnostics?.some(entry => entry.code === 'BUILD_FAILED') ? value : null
    }, timeoutMs)
    assert.equal(broken.sessionId, restarted.sessionId)
    assert.equal(broken.revision, restarted.revision)
    checks.buildFailure = 'passed'

    await writeOwned(sourceFiles.appJson, sourceFiles.originals.get(sourceFiles.appJson), sourceFiles.expected)
    let lastRecoveryState
    const recovered = await waitFor('build recovery', async () => {
      lastRecoveryState = await state()
      return lastRecoveryState.status === 'ready' && !(lastRecoveryState.diagnostics?.length) ? lastRecoveryState : null
    }, timeoutMs, 100, () => lastRecoveryState)
    assert.ok(recovered.diagnosticHistory?.records?.some(entry => entry.code === 'BUILD_FAILED'))
    checks.recovery = 'passed'
    result = {
      simulatorUrl,
      revisions: { initial: initial.revision, wxss: styled.revision, restart: restarted.revision, recovery: recovered.revision },
      sessions: { initial: initial.sessionId, wxss: styled.sessionId, restart: restarted.sessionId, recovery: recovered.sessionId },
      initialSnapshot: { width: initialSnapshot.width, height: initialSnapshot.height, pixelBytes: initialSnapshot.pixels.length },
      checks,
    }
  } catch (error) {
    error.checks = checks
    operationError = error
  } finally {
    const cleanupErrors = []
    for (const [name, close] of [['browser context', () => context?.close()], ['browser', () => browser?.close()]]) {
      try { await close() } catch (error) { cleanupErrors.push(`${name}: ${error.message}`) }
    }
    try { await requestJson(pageUrl, '/api/stop', { token, method: 'POST', body: {} }) }
    catch (error) { cleanupErrors.push(`simulator stop request: ${error.message}`) }
    try {
      await waitFor('web child cleanup', async () => !(await requestJson(pageUrl, '/api/status', { token })).running, Math.min(timeoutMs, 15_000))
    } catch (error) { cleanupErrors.push(`simulator child: ${error.message}`) }
    if (cleanupErrors.length) {
      const cleanupError = new AggregateError(cleanupErrors.map(message => new Error(message)), cleanupErrors.join('; '))
      operationError = operationError
        ? new AggregateError([operationError, cleanupError], `${operationError.message}; cleanup failed: ${cleanupError.message}`)
        : cleanupError
    }
  }
  if (operationError) throw operationError
  return result
}

async function discoverSourceFiles(project, appPath) {
  let appScript = null
  for (const name of ['app.js', 'app.ts', 'app.mjs']) {
    const candidate = join(dirname(appPath), name)
    if (await exists(candidate)) {
      appScript = candidate
      break
    }
  }
  const wxss = await findFirstSource(project, ['.wxss'])
  if (!appScript) throw new Error('project must provide app.js, app.ts, or app.mjs next to app.json')
  if (!wxss) throw new Error('project must provide at least one source WXSS file')
  const originals = new Map()
  for (const path of [appPath, appScript, wxss]) originals.set(path, await readFile(path, 'utf8'))
  return { appJson: appPath, appScript, wxss, originals, expected: new Map(originals) }
}

export async function runSmoke(options) {
  const startedAt = Date.now()
  const provenance = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'devtools-development-loop',
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    project: options.project,
    surface: options.surface,
    status: 'unknown',
  }
  let stage
  let launcher
  let sourceFiles
  let result
  let error
  const cleanupErrors = []
  try {
    if (!(await exists(options.project))) throw new Error(`project does not exist: ${options.project}`)
    if (options.installRoot) {
      const outputRoot = await mkdtemp(join(tmpdir(), 'weapp-devtools-loop-output-'))
      stage = { installRoot: options.installRoot, outputRoot, owned: false, cleanup: async () => { await rm(outputRoot, { recursive: true, force: true }) } }
    } else {
      stage = await stageInstallRoot()
    }
    const preflight = await inspectProject(options.project, { metadata: compatibilityMetadata() })
    const exerciseEdits = options.surface === 'web' && preflight.project === defaultProject
    if (exerciseEdits) sourceFiles = await discoverSourceFiles(options.project, preflight.appPath)
    launcher = await createLauncher({ installRoot: stage.installRoot, openBrowser: () => {}, software: true, outputRoot: stage.outputRoot })
    const launcherUrl = new URL(launcher.page)
    const token = new URLSearchParams(launcherUrl.hash.slice(1)).get('session')
    assert.ok(token)
    if (options.surface === 'desktop') {
      result = await runDesktopLoop({ pageUrl: launcher.page, token, project: preflight.project, timeoutMs: options.timeoutMs })
    } else {
      result = await runWebLoop({
        pageUrl: launcher.page, token, project: preflight.project, sourceFiles, timeoutMs: options.timeoutMs, exerciseEdits,
      })
    }
    provenance.status = 'passed'
  } catch (caught) {
    error = caught
    provenance.status = caught?.status || 'failed'
  } finally {
    if (sourceFiles) {
      for (const [path, original] of [...sourceFiles.originals].reverse()) {
        if (sourceFiles.expected.get(path) !== original) {
          try { await writeOwned(path, original, sourceFiles.expected, true) }
          catch (caught) { cleanupErrors.push(`restore ${path}: ${caught.message}`) }
        }
      }
    }
    try { await launcher?.close() } catch (caught) { cleanupErrors.push(`launcher: ${caught.message}`) }
    try { await stage?.cleanup() } catch (caught) { cleanupErrors.push(`staging: ${caught.message}`) }
  }
  const report = {
    ...provenance,
    elapsedMs: Date.now() - startedAt,
    ...(result || {}),
    ...(error?.checks ? { checks: error.checks } : {}),
    ...(error ? { error: String(error?.stack || error) } : {}),
    cleanup: { sourceRestored: cleanupErrors.every(value => !value.startsWith('restore ')), ownedStagingRemoved: !stage?.owned || cleanupErrors.every(value => !value.startsWith('staging: ')) },
    ...(cleanupErrors.length ? { cleanupErrors } : {}),
    evidence: options.surface === 'web'
      ? 'local packaged launcher and software Web preview only; official WeChat DevTools, GPU, emulator and device gates are separate'
      : 'local desktop simulator process lifecycle only; window presentation, official WeChat DevTools, GPU, emulator and device gates are separate',
  }
  if (cleanupErrors.length) report.status = 'failed'
  await mkdir(dirname(options.reportPath), { recursive: true })
  await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs()
    if (options.help) process.stdout.write(usage())
    else {
      const report = await runSmoke(options)
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      if (report.status === 'failed') process.exitCode = 1
      else if (report.status === 'blocked') process.exitCode = 2
    }
  } catch (error) {
    process.stderr.write(`devtools-development-loop-smoke: ${error.message}\n`)
    process.exitCode = 1
  }
}
