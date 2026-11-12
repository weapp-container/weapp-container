#!/usr/bin/env node
/** Explicit Harmony target + task-owned bundle; never boots or resets a device. */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const requireValue = (condition, message) => { if (!condition) throw new Error(message) }
const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const defaultExecute = (command, args, { timeoutMs }) => spawnSync(command, args, {
  encoding: null, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
})
const asBytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value || '')
const json = path => JSON.parse(readFileSync(path, 'utf8'))

export function parseArgs(args) {
  const names = new Map([
    ['--target', 'target'], ['--hap', 'hap'], ['--build-receipt', 'buildReceipt'],
    ['--bundle', 'bundle'], ['--out-dir', 'outDir'], ['--hdc', 'hdc'],
    ['--engine', 'engine'], ['--route', 'route'], ['--tap-x', 'tapX'], ['--tap-y', 'tapY'],
    ['--timeout-ms', 'timeoutMs'], ['--poll-ms', 'pollMs'], ['--surface-id', 'surfaceId'],
  ])
  const result = {}
  for (let index = 0; index < args.length; index += 1) {
    const key = names.get(args[index])
    requireValue(key && args[index + 1] && !args[index + 1].startsWith('--'), `Unknown option or missing value: ${args[index]}`)
    requireValue(result[key] === undefined, `Duplicate option: ${args[index]}`)
    result[key] = args[++index]
  }
  return result
}

function validateOptions(raw) {
  for (const key of ['target', 'hap', 'buildReceipt', 'bundle', 'outDir', 'tapX', 'tapY']) {
    requireValue(typeof raw[key] === 'string' && raw[key].length > 0, `Missing required option: ${key}`)
  }
  requireValue(/^[A-Za-z0-9_.:-]+$/.test(raw.target), 'Invalid explicit hdc target')
  requireValue(/^com\.sonofmagic\.weapp\.container\.(?:smoke|live)[a-f0-9]{8,32}$/.test(raw.bundle), 'Bundle must have a task-unique smoke/live hexadecimal suffix')
  const options = { ...raw, hap: resolve(raw.hap), buildReceipt: resolve(raw.buildReceipt), outDir: resolve(raw.outDir),
    engine: raw.engine || 'quickjs', route: raw.route || 'pages/home/index', surfaceId: raw.surfaceId || null,
    hdc: raw.hdc || 'hdc', timeoutMs: Number(raw.timeoutMs || 30_000), pollMs: Number(raw.pollMs || 150), tapX: Number(raw.tapX), tapY: Number(raw.tapY) }
  requireValue(['quickjs', 'v8'].includes(options.engine), 'Explicit engine must be quickjs or v8')
  requireValue(/^[A-Za-z0-9_/-]+$/.test(options.route) && !options.route.split('/').includes('..'), 'Invalid explicit page route')
  requireValue(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 100 && options.timeoutMs <= 120_000, 'Invalid timeout')
  requireValue(Number.isSafeInteger(options.pollMs) && options.pollMs > 0 && options.pollMs <= 5_000, 'Invalid poll interval')
  requireValue([options.tapX, options.tapY].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000), 'Tap coordinates must be non-negative physical integers')
  requireValue(existsSync(options.hap) && existsSync(options.buildReceipt), 'HAP and build receipt must exist')
  requireValue(!existsSync(options.outDir) || readdirSync(options.outDir).length === 0, 'Output directory must be empty; evidence is not overwritten')
  return options
}

export function inspectBuildReceipt(path, artifactSha256, bundle) {
  const receipt = json(path)
  requireValue(receipt.schemaVersion === 1 && receipt.scope === 'harmony-hap-build' && receipt.status === 'passed', 'Official Harmony HAP build receipt did not pass')
  requireValue(receipt.bundle === bundle && receipt.artifact?.sha256 === artifactSha256, 'HAP bytes or task bundle differ from build receipt')
  requireValue(Array.isArray(receipt.sourceFiles) && receipt.sourceFiles.length > 0
    && receipt.sourceFiles.every(file => typeof file.path === 'string' && /^[a-f0-9]{64}$/.test(file.sha256)), 'Build receipt source snapshot is missing')
  requireValue(/^[a-f0-9]{64}$/.test(receipt.rustLibrary?.sha256 || ''), 'Build receipt native input SHA-256 is missing')
  return { status: 'passed', receiptPath: resolve(path), sha256: sha256(readFileSync(path)),
    artifactSha256, bundle, rustLibrarySha256: receipt.rustLibrary.sha256, sourceFiles: receipt.sourceFiles,
    evidenceBoundary: 'Exact HAP hash and isolated SDK-build snapshot receipt; Rust source provenance requires the separate native build receipt' }
}

export function processIdentity(text, pid) {
  const closing = text.lastIndexOf(')')
  requireValue(text.startsWith(`${pid} (`) && closing > 0, 'Process stat does not match owned PID')
  const fields = text.slice(closing + 1).trim().split(/\s+/)
  requireValue(/^\d+$/.test(fields[19] || ''), 'Process start ticks are unavailable')
  return { pid, startTicks: fields[19] }
}

export function parseLiveStates(text, pid, sessionId) {
  const states = []
  for (const line of text.split(/\r?\n/)) {
    // HiLog can insert its hexadecimal chain/span/parent trace tuple after
    // the JSAPP tag on resume. Accept only that bounded, canonical tuple;
    // arbitrary log text before a marker cannot become runtime evidence.
    const match = /^\d{2}-\d{2}[ \t]+\d{2}:\d{2}:\d{2}\.\d{3}[ \t]+([1-9]\d*)[ \t]+[1-9]\d*[ \t]+I[ \t]+A03d00\/JSAPP:[ \t]+(?:\[[a-f0-9]{1,16}, [a-f0-9]{1,8}, [a-f0-9]{1,8}\][ \t]+)?WEAPP_CONTAINER_LIVE_STATE[ \t]+(\{[^\r\n]*\})[ \t]*$/.exec(line)
    if (!match || Number(match[1]) !== pid) continue
    let value
    try { value = JSON.parse(match[2]) } catch { continue }
    if (value.sessionId === sessionId) states.push(value)
  }
  return states.sort((left, right) => left.revision - right.revision)
}

export function validateObservation(value, expected) {
  requireValue(value?.schemaVersion === 1 && value.evidenceBoundary === 'sample-runtime-observation', 'Unknown live observation schema or boundary')
  for (const key of ['sessionId', 'engine', 'route']) requireValue(value[key] === expected[key], `Live ${key} changed`)
  for (const key of ['revision', 'frameId', 'presentationSequence']) requireValue(Number.isSafeInteger(value[key]) && value[key] > 0, `Invalid live ${key}`)
  requireValue(Number.isSafeInteger(value.presentedFrameId) && value.presentedFrameId >= 0 && value.presentedFrameId <= value.frameId, 'Invalid presented frame identity')
  requireValue(value.page?.route === expected.route && Number.isSafeInteger(value.page?.id) && value.page.id > 0, 'Missing active AppService page identity')
  requireValue(Array.isArray(value.diagnostics) && value.diagnostics.length === 0, `Runtime diagnostics: ${JSON.stringify(value.diagnostics)}`)
  for (const key of ['width', 'height', 'surfaceWidth', 'surfaceHeight']) requireValue(Number.isSafeInteger(value[key]) && value[key] > 0, `Missing observed ${key}`)
  const data = value.page.data
  requireValue(data && ['count', 'timerCount', 'microtaskCount'].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0 && data[key] <= 1), 'Reference fixture counters are invalid')
  requireValue(Array.isArray(data.lifecycleTrace) && data.lifecycleTrace.every(item => typeof item === 'string'), 'Reference lifecycle trace is missing')
  return value
}

function bounds(value) {
  if (typeof value === 'string') {
    const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value)
    if (match) return { left: Number(match[1]), top: Number(match[2]), right: Number(match[3]), bottom: Number(match[4]) }
  }
  if (value && ['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(value[key]))) return value
  return null
}

/** Platform layout proof is deliberately strict: unknown focus formats fail. */
export function inspectForegroundLayout(layout, bundle, surfaceId, point) {
  const surfaces = [], inputPlanes = []
  let focusedBundle = null
  let focusedOwnedRoot = false
  const enabled = attributes => (attributes.visible === true || attributes.visible === 'true')
    && (attributes.enabled === true || attributes.enabled === 'true')
  const matchesId = (attributes, id) => ['id', 'key', 'accessibilityId'].some(key => attributes[key] === id)
  function walk(node, inheritedBundle = '', inheritedFocus = false) {
    if (!node || typeof node !== 'object') return
    const attributes = node.attributes || node
    const owner = attributes.bundleName || inheritedBundle
    const focused = attributes.focused === true || attributes.focused === 'true' || attributes.isFocused === true || attributes.isFocused === 'true'
    if (focused) {
      if (owner) {
        requireValue(focusedBundle === null || focusedBundle === owner, 'Multiple focused bundles in OS layout')
        focusedBundle = owner
      }
    }
    const ownRoot = owner === bundle && focused && attributes.type === 'root' && enabled(attributes)
    if (ownRoot) focusedOwnedRoot = true
    const ownFocus = owner === bundle && (ownRoot || inheritedFocus)
    if (ownFocus && attributes.type === 'XComponent' && enabled(attributes) && (!surfaceId || matchesId(attributes, surfaceId))) {
      surfaces.push(bounds(attributes.bounds))
    }
    if (ownFocus && matchesId(attributes, 'weapp-container-input')) {
      requireValue(enabled(attributes), 'Owned input plane is not visible and enabled')
      inputPlanes.push(bounds(attributes.bounds))
    }
    if (Array.isArray(node.children)) for (const child of node.children) walk(child, owner, ownFocus)
  }
  if (Array.isArray(layout.windows)) for (const window of layout.windows) walk(window)
  else walk(layout)
  requireValue(focusedBundle === bundle && focusedOwnedRoot, 'OS layout does not prove the owned bundle is foreground')
  requireValue(surfaces.length === 1, 'OS layout must contain exactly one owned XComponent surface')
  const rectangle = surfaces[0]
  requireValue(rectangle && rectangle.right > rectangle.left && rectangle.bottom > rectangle.top, 'Owned XComponent bounds are invalid')
  requireValue(inputPlanes.length <= 1, 'OS layout has multiple owned input planes')
  const inputPlane = inputPlanes[0] || null
  if (inputPlanes.length) requireValue(inputPlane && ['left', 'top', 'right', 'bottom'].every(key => inputPlane[key] === rectangle[key]),
    'Owned input plane bounds do not match the XComponent surface')
  if (point) requireValue(point.x >= rectangle.left && point.x < rectangle.right && point.y >= rectangle.top && point.y < rectangle.bottom,
    'Requested OS tap is outside the owned XComponent bounds')
  return { bundle, surfaceId, surfaceIdentification: surfaceId ? 'explicit-id' : 'unique-visible-enabled-XComponent',
    bounds: rectangle, inputPlane, point: point || null }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})
function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function pngMetadata(bytes) {
  requireValue(bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'OS screenshot did not produce PNG bytes')
  let offset = 8, header = null, ended = false
  const imageData = []
  while (offset < bytes.length) {
    requireValue(offset + 12 <= bytes.length, 'OS screenshot PNG has a truncated chunk')
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length
    requireValue(end <= bytes.length, 'OS screenshot PNG has truncated chunk bytes')
    const type = bytes.toString('ascii', offset + 4, offset + 8), data = bytes.subarray(offset + 8, end - 4)
    requireValue(crc32(bytes.subarray(offset + 4, end - 4)) === bytes.readUInt32BE(end - 4), 'OS screenshot PNG chunk checksum failed')
    if (!header) requireValue(type === 'IHDR' && length === 13, 'OS screenshot PNG header is missing')
    if (type === 'IHDR') { requireValue(!header, 'OS screenshot PNG has duplicate headers'); header = data }
    else if (type === 'IDAT') imageData.push(data)
    else if (type === 'IEND') { requireValue(length === 0 && end === bytes.length, 'OS screenshot PNG has an invalid end'); ended = true }
    offset = end
  }
  requireValue(ended && imageData.length > 0, 'OS screenshot PNG image data or end is missing')
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), depth = header[8], color = header[9]
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(color)
  const depths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]).get(color)
  requireValue(width > 0 && height > 0 && width <= 16384 && height <= 16384 && channels && depths.includes(depth)
    && header[10] === 0 && header[11] === 0 && header[12] <= 1, 'OS screenshot PNG geometry or format is invalid')
  let decoded
  try { decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: 128 * 1024 * 1024 }) }
  catch { throw new Error('OS screenshot PNG compressed pixels are invalid or oversized') }
  if (header[12] === 0) requireValue(decoded.length === height * (1 + Math.ceil(width * channels * depth / 8)), 'OS screenshot PNG pixel rows are truncated')
  return { width, height, size: bytes.length, sha256: sha256(bytes), structureValidation: 'png-chunks-crc-and-zlib' }
}

function nativeSuccess(text, operation) {
  requireValue(/success(?:ful(?:ly)?)?/i.test(text) && !/\b(?:failed|failure|error)\b/i.test(text), `${operation} did not report success: ${text}`)
}

export async function runHarmonyAppSmoke(rawOptions, dependencies = {}) {
  const options = validateOptions(rawOptions)
  const execute = dependencies.execute || defaultExecute, now = dependencies.now || Date.now, wait = dependencies.wait || sleep
  const unique = (dependencies.uuid || randomUUID)().replace(/-/g, '')
  requireValue(/^[a-f0-9]{8,32}$/.test(unique), 'Invalid task UUID')
  const sessionId = `harmony-smoke-${unique}`
  const remotePrefix = `/data/local/tmp/weapp-harmony-${unique}`
  mkdirSync(options.outDir, { recursive: true })
  mkdirSync(join(options.outDir, 'commands'))
  const report = { schemaVersion: 1, scope: 'harmony-owned-app-os-interaction', status: 'failed',
    startedAt: new Date(now()).toISOString(), target: options.target, bundle: options.bundle, engine: options.engine, route: options.route,
    sessionId, hap: options.hap, artifactSha256: sha256(readFileSync(options.hap)), harnessSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    ownsInstallation: false, process: null, phases: {}, screenshots: {}, commands: [], diagnostics: [], cleanup: { status: 'not-needed' },
    limitations: ['OS screenshots require separate visual glyph/content review', 'Attached/presented Skia frames do not establish physical GPU acceleration',
      'Reference interaction only; fixed-version official DevTools comparison, rotation, other hosts and performance gates remain separate',
      'Foreground timer execution is covered; background scheduling semantics are not certified'] }
  let number = 0, installAttempted = false, baselineAbsent = false, owned = null
  const remoteFiles = new Set()
  const expected = { sessionId, engine: options.engine, route: options.route }
  const aborted = () => requireValue(!dependencies.signal?.aborted, 'Harmony smoke aborted')
  function run(command, args, { timeoutMs = 5_000, allowFailure = false, cleanup = false } = {}) {
    if (!cleanup) aborted()
    const id = String(++number).padStart(3, '0'), startedAt = new Date(now()).toISOString()
    let result
    try { result = execute(command, args, { timeoutMs }) }
    catch (error) { result = { status: null, error, stdout: '', stderr: '' } }
    const stdout = asBytes(result.stdout), stderr = asBytes(result.stderr)
    writeFileSync(join(options.outDir, 'commands', `${id}.stdout`), stdout)
    writeFileSync(join(options.outDir, 'commands', `${id}.stderr`), stderr)
    const entry = { id, command, args, startedAt, completedAt: new Date(now()).toISOString(), exitCode: result.status,
      signal: result.signal || null, error: result.error?.message || null, stdout: `commands/${id}.stdout`, stderr: `commands/${id}.stderr`,
      stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr), cleanup }
    report.commands.push(entry)
    const ok = result.status === 0 && !result.error
    requireValue(ok || allowFailure, `Command failed: ${command} ${args.join(' ')}: ${stderr.toString('utf8') || stdout.toString('utf8') || entry.error}`)
    return { ok, text: stdout.toString('utf8'), errorText: stderr.toString('utf8'), entry }
  }
  const hdc = (args, config) => run(options.hdc, ['-t', options.target, ...args], config)
  function packagePresent(cleanup = false) {
    const response = hdc(['shell', 'bm', 'dump', '-a'], { cleanup })
    requireValue(!/\b(?:error|failed|failure)\b/i.test(response.text), 'Cannot inspect installed bundles')
    return [...response.text.matchAll(/[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/g)].some(match => match[0] === options.bundle)
  }
  function identity({ allowMissing = false, cleanup = false } = {}) {
    const response = hdc(['shell', 'pidof', options.bundle], { allowFailure: true, cleanup })
    const values = response.text.trim().split(/\s+/).filter(Boolean)
    if (allowMissing && values.length === 0 && !response.errorText.trim()) return null
    requireValue(response.ok && values.length === 1 && /^[1-9]\d*$/.test(values[0]), 'Cannot establish one owned app PID')
    const pid = Number(values[0])
    requireValue(Number.isSafeInteger(pid), 'Invalid app PID')
    return processIdentity(hdc(['shell', 'cat', `/proc/${pid}/stat`], { cleanup }).text, pid)
  }
  function assertIdentity() {
    const current = identity()
    requireValue(current.pid === owned.pid && current.startTicks === owned.startTicks, 'Owned app process restarted or PID was reused')
    return current
  }
  function remotePath(label, extension) {
    const path = `${remotePrefix}-${label}.${extension}`
    remoteFiles.add(path)
    return path
  }
  function readLayout(label, point = null) {
    assertIdentity()
    const remote = remotePath(`layout-${label}-${number + 1}`, 'json')
    const local = join(options.outDir, `layout-${label}-${number + 1}.json`)
    hdc(['shell', 'uitest', 'dumpLayout', '-p', remote, '-m', 'true'])
    hdc(['file', 'recv', remote, local])
    const proof = inspectForegroundLayout(json(local), options.bundle, options.surfaceId, point)
    assertIdentity()
    return proof
  }
  function readStates() {
    assertIdentity()
    const logs = hdc(['shell', 'hilog', '-x', '-P', String(owned.pid)])
    const states = parseLiveStates(logs.text, owned.pid, sessionId)
    return states
  }
  const presented = value => value.status === 'ready' && value.foreground === true && value.presentedFrameId === value.frameId
  async function poll(label, predicate, minimumRevision = 0) {
    const deadline = now() + options.timeoutMs
    let last
    while (now() < deadline) {
      aborted()
      const value = readStates().filter(value => value.revision >= minimumRevision).at(-1)
      if (value) {
        // Startup can publish before the XComponent has physical geometry.
        if (value.status !== 'waiting-surface') last = validateObservation(value, expected)
        if (value.status !== 'waiting-surface' && predicate(last)) {
          writeFileSync(join(options.outDir, `${label}.state.json`), `${JSON.stringify(last, null, 2)}\n`)
          report.phases[label] = { status: 'passed', file: `${label}.state.json`, sha256: sha256(readFileSync(join(options.outDir, `${label}.state.json`))),
            process: { ...owned }, revision: last.revision, frameId: last.frameId }
          return last
        }
      }
      await wait(options.pollMs)
    }
    if (last) writeFileSync(join(options.outDir, `${label}-timeout.state.json`), `${JSON.stringify(last, null, 2)}\n`)
    throw new Error(`Deadline waiting for Harmony phase: ${label}`)
  }
  async function capture(label, current) {
    const foregroundBefore = readLayout(`${label}-before`), processBefore = assertIdentity()
    const remote = remotePath(`screen-${label}`, 'png'), path = join(options.outDir, `${label}.png`)
    hdc(['shell', 'uitest', 'screenCap', '-p', remote])
    hdc(['file', 'recv', remote, path])
    const metadata = pngMetadata(readFileSync(path))
    const processAfter = assertIdentity(), foregroundAfter = readLayout(`${label}-after`)
    const after = await poll(`${label}-capture`, value => presented(value) && value.frameId === current.frameId
      && value.presentedFrameId === current.presentedFrameId && value.width === current.width && value.height === current.height
      && JSON.stringify(value.page.data) === JSON.stringify(current.page.data), current.revision)
    report.screenshots[label] = { status: 'captured', path: `${label}.png`, ...metadata, processBefore, processAfter,
      foregroundBefore, foregroundAfter, frameId: after.frameId, revision: after.revision,
      visualStatus: 'unknown', evidenceBoundary: 'OS PNG with stable owned PID/session/frame and foreground geometry; pixels require independent review' }
    return after
  }
  try {
    report.build = inspectBuildReceipt(options.buildReceipt, report.artifactSha256, options.bundle)
    const packagedJson = run('unzip', ['-p', options.hap, 'module.json']).text
    const packaged = JSON.parse(packagedJson)
    requireValue(packaged.app?.bundleName === options.bundle && packaged.module?.name === 'entry', 'Packaged HAP module metadata differs from task-owned bundle')
    report.packagedModuleSha256 = sha256(Buffer.from(packagedJson))
    requireValue(!packagePresent(), 'Task bundle is already installed; refusing to replace a preexisting application')
    baselineAbsent = true
    installAttempted = true
    nativeSuccess(hdc(['install', options.hap], { timeoutMs: 30_000 }).text, 'hdc install')
    requireValue(packagePresent(), 'Installed task bundle is absent after install')
    report.ownsInstallation = true
    const startArgs = ['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', options.bundle,
      '--ps', 'weappContainerEngine', options.engine, '--ps', 'weappContainerRoute', options.route,
      '--ps', 'weappContainerSessionId', sessionId]
    nativeSuccess(hdc(startArgs, { timeoutMs: 15_000 }).text, 'aa start')
    const processDeadline = now() + options.timeoutMs
    do {
      owned = identity({ allowMissing: true })
      if (owned) break
      await wait(options.pollMs)
    } while (now() < processDeadline)
    requireValue(owned, 'Owned app PID did not appear')
    report.process = { ...owned }
    let current = await poll('initial', value => presented(value))
    requireValue(['count', 'timerCount', 'microtaskCount'].every(key => current.page.data[key] === 0), 'Initial reference counters are not pristine')
    requireValue(JSON.stringify(current.page.data.lifecycleTrace) === JSON.stringify(['app:launch', 'app:show', 'page:load', 'page:show', 'page:ready']), 'Reference startup lifecycle differs')
    current = await capture('initial', current)
    const beforeTap = current.revision
    const tapProof = readLayout('tap', { x: options.tapX, y: options.tapY })
    const click = hdc(['shell', 'uitest', 'uiInput', 'click', String(options.tapX), String(options.tapY)])
    requireValue(/\bNo Error\b/.test(click.text), `OS click was rejected: ${click.text}`)
    report.tap = { commandId: click.entry.id, ...tapProof, evidenceBoundary: 'Actual OS uitest click within observed owned XComponent bounds' }
    current = await poll('tap', value => presented(value) && value.page.data.count === 1, beforeTap + 1)
    current = await poll('timer', value => presented(value) && value.page.data.count === 1
      && value.page.data.timerCount === 1 && value.page.data.microtaskCount === 1, current.revision)
    current = await capture('timer', current)
    const beforeHide = current.revision
    readLayout('home')
    const home = hdc(['shell', 'uitest', 'uiInput', 'keyEvent', 'Home'])
    requireValue(/\bNo Error\b/.test(home.text), `OS Home key was rejected: ${home.text}`)
    const hidden = await poll('background', value => value.foreground === false && value.status === 'suspended'
      && value.page.data.lifecycleTrace.slice(-2).join(',') === 'app:hide,page:hide', beforeHide + 1)
    requireValue(hidden.page.data.count === 1 && hidden.page.data.timerCount === 1 && hidden.page.data.microtaskCount === 1, 'Background transition lost page state')
    // No new Want/session parameters on resume: the original Ability must survive.
    nativeSuccess(hdc(['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', options.bundle], { timeoutMs: 15_000 }).text, 'aa resume')
    current = await poll('resumed', value => presented(value) && value.page.data.count === 1
      && value.page.data.timerCount === 1 && value.page.data.microtaskCount === 1
      && value.page.data.lifecycleTrace.slice(-2).join(',') === 'app:show,page:show', hidden.revision + 1)
    await capture('resumed', current)
    requireValue(sha256(readFileSync(options.hap)) === report.artifactSha256, 'HAP changed during the installed run')
    report.status = 'passed'
  } catch (error) {
    report.diagnostics.push({ message: error.message, commandNumber: number })
  } finally {
    const failures = []
    let packageAbsent = null, processAbsent = null
    if (baselineAbsent && installAttempted) {
      try {
        if (packagePresent(true)) {
          report.ownsInstallation = true
          for (const args of [['shell', 'aa', 'force-stop', options.bundle], ['uninstall', options.bundle]]) {
            try {
              const result = hdc(args, { timeoutMs: 30_000, allowFailure: true, cleanup: true })
              if (!result.ok || !/success(?:ful(?:ly)?)?/i.test(result.text) || /\b(?:failed|failure|error)\b/i.test(result.text)) failures.push(`Owned cleanup failed: ${args.join(' ')}`)
            } catch (error) { failures.push(error.message) }
          }
        }
      } catch (error) { failures.push(error.message) }
      try { packageAbsent = !packagePresent(true); if (!packageAbsent) failures.push('Owned task bundle remains installed') } catch (error) { failures.push(error.message) }
      try { processAbsent = !identity({ allowMissing: true, cleanup: true }); if (!processAbsent) failures.push('Owned app process remains alive') } catch (error) { failures.push(error.message) }
    }
    for (const remote of remoteFiles) {
      try {
        const removed = hdc(['shell', 'rm', '-f', remote], { allowFailure: true, cleanup: true })
        if (!removed.ok) failures.push(`Could not remove owned capture: ${remote}`)
        const observed = hdc(['shell', 'ls', remote], { allowFailure: true, cleanup: true })
        const absence = `${observed.text}\n${observed.errorText}`
        if (!/No such file|does not exist/i.test(absence)) failures.push(`Owned remote capture absence is unverified: ${remote}`)
      } catch (error) { failures.push(error.message) }
    }
    report.cleanup = { status: failures.length ? 'failed' : baselineAbsent && installAttempted ? 'passed' : 'not-needed',
      ownedBundle: report.ownsInstallation ? options.bundle : null, packageAbsent, processAbsent, remoteFiles: [...remoteFiles], failures,
      evidenceBoundary: 'Only this run\'s previously absent bundle and exact remote capture paths were cleaned; borrowed target and global logs preserved' }
    if (failures.length) report.status = 'failed'
    report.completedAt = new Date(now()).toISOString()
    writeFileSync(join(options.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    const report = await runHarmonyAppSmoke(parseArgs(process.argv.slice(2)), { signal: controller.signal })
    process.stdout.write(`${JSON.stringify({ status: report.status, sessionId: report.sessionId, process: report.process,
      cleanup: report.cleanup, diagnostics: report.diagnostics, report: resolve(parseArgs(process.argv.slice(2)).outDir, 'report.json') }, null, 2)}\n`)
    process.exitCode = report.status === 'passed' ? 0 : 1
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
}
