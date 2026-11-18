/** Exact native host policy shared by construction and observation. These
 * checks establish declared identity; only real execution produces evidence. */
const require = (condition, message) => { if (!condition) throw new Error(message) }
export function requireEngine(engine) {
  require(['quickjs', 'v8'].includes(engine), 'Explicit quickjs/v8 engine required')
  return engine
}

export function hostProfile({ host = 'macos', presenter, arch = 'arm64' } = {}) {
  if (host === 'macos') {
    require((presenter === undefined || presenter === 'metal') && arch === 'arm64', 'macOS requires native aarch64 Metal')
    return Object.freeze({ host, presenter: 'metal', platform: 'darwin', arch, target: 'aarch64-apple-darwin', artifactKind: 'mach-o-executable' })
  }
  require(host === 'linux' && presenter === 'software' && ['x64', 'arm64'].includes(arch), 'Linux requires explicit software presenter and native x64/arm64 GNU target')
  return Object.freeze({ host, presenter, platform: 'linux', arch,
    target: arch === 'x64' ? 'x86_64-unknown-linux-gnu' : 'aarch64-unknown-linux-gnu', artifactKind: 'elf-executable' })
}

export function profileForTarget({ host = 'macos', presenter, target }) {
  const arch = target === 'x86_64-unknown-linux-gnu' ? 'x64' : 'arm64'
  const profile = hostProfile({ host, presenter, arch })
  require(target === profile.target, 'Explicit supported native target required')
  return profile
}

// A supplied system is a pure unit-test seam, never an execution receipt.
export function profileForRuntime(options, system = process) {
  const profile = hostProfile({ ...options, arch: system.arch })
  require(system.platform === profile.platform, `Native ${profile.host} driver requires a real ${profile.platform}/${profile.arch} execution host`)
  return profile
}

export function engineFeatures(profile, engine, { exceptionChannel = false } = {}) {
  requireEngine(engine)
  require(typeof exceptionChannel === 'boolean', 'Explicit exception-channel build policy must be boolean')
  return [`${engine}-native`, ...(profile.host === 'linux' || exceptionChannel ? ['conformance-observation'] : []), ...(exceptionChannel ? ['conformance-exception-channel'] : [])]
}

export function assertFeatures(profile, engine, features, { exceptionChannel = false } = {}) {
  const expected = engineFeatures(profile, engine, { exceptionChannel })
  require(Array.isArray(features) && expected.every(feature => features.includes(feature))
    && features.includes('conformance-exception-channel') === exceptionChannel
    && (profile.host !== 'linux' || features.length === expected.length && new Set(features).size === expected.length)
    && !features.includes(`${engine === 'v8' ? 'quickjs' : 'v8'}-native`), 'Cargo engine/observation features selection differs from the exact native profile')
}

export function assertBinaryHeader(bytes, profile) {
  if (profile.host === 'macos') {
    require(bytes.subarray(0, 4).toString('hex') === 'cffaedfe', 'Native binary is not the expected 64 bit Mach-O executable')
    return
  }
  require(bytes.length >= 64 && bytes.subarray(0, 4).toString('hex') === '7f454c46'
    && bytes[4] === 2 && bytes[5] === 1 && bytes[6] === 1
    && [0, 3].includes(bytes[7]) && bytes.readUInt32LE(20) === 1
    && [2, 3].includes(bytes.readUInt16LE(16))
    && bytes.readUInt16LE(18) === (profile.arch === 'x64' ? 62 : 183)
    && bytes.readUInt16LE(52) === 64, 'Native binary is not an exact supported Linux 64 bit little-endian executable')
}

export function buildEnvironmentKey(profile, engine) {
  requireEngine(engine)
  return `WEAPP_CONFORMANCE_${profile.host.toUpperCase()}_${engine.toUpperCase()}_BUILD`
}

export function nativeArguments(profile, { pack, engine, sessionId }) {
  requireEngine(engine)
  require(typeof pack === 'string' && pack && typeof sessionId === 'string' && sessionId, 'Native pack/session identity required')
  return ['--pack', pack, '--engine', engine, '--session', sessionId, '--timeout-ms', '120000',
    ...(profile.host === 'linux' ? ['--presenter', 'software'] : [])]
}

export function assertStartup(profile, startup, { host, engine, sessionId, manifestIntegrity, pid }) {
  require(host === profile.host && startup?.status === 'passed' && startup.host === host && startup.engine === engine
    && startup.sessionId === sessionId && startup.manifestIntegrity === manifestIntegrity
    && startup.target?.kind === 'native-window' && startup.target.pid === pid,
  'Native startup host/engine/window/session/pack identity differs')
  if (profile.host !== 'linux') return
  const surface = startup.surfaceProbe
  const snapshot = JSON.parse(startup.operations?.['render.snapshot']?.json ?? 'null')
  require(startup.presenterProfile === 'software' && startup.target.host === host
    && typeof startup.target.id === 'string' && startup.target.id.length > 0
    && surface?.schemaVersion === 1 && surface.status === 'passed' && surface.host === host && surface.engine === engine
    && surface.sessionId === sessionId && surface.manifestIntegrity === manifestIntegrity
    && surface.hostSurfaceAttached === true && surface.containerSurfaceAttached === false && surface.gpuSurface === false
    && surface.rendererBackend === 'software-fallback' && surface.presenterBackend === 'softbuffer-raster'
    && surface.evidenceBoundary === 'runtime-software-native-window' && surface.presentationCompletion === 'buffer-submitted'
    && !Object.hasOwn(surface, 'gpuCompletion')
    && Number.isSafeInteger(surface.frameId) && surface.frameId > 0 && snapshot?.frame_id === surface.frameId
    && /^[0-9a-f]{64}$/.test(surface.snapshotSha256 ?? '') && snapshot?.sha256 === surface.snapshotSha256,
  'Linux startup lacks the exact presented software window identity; it cannot claim GPU evidence')
}

export function assertCleanup(profile, cleanup, { outcome, protocolError }) {
  require(cleanup?.ownedResourcesReleased === true && cleanup.borrowedResourcesPreserved === true
    && outcome?.exitCode === 0 && !protocolError, 'Native window/context/session cleanup failed; inspect native-session.json')
  if (profile.host === 'linux') require(cleanup.presenterProfile === 'software' && cleanup.softwarePresenterRetired === true
    && cleanup.sessionUnloaded === true && cleanup.eventLoopReturned === true && cleanup.windowOwnerDropped === true
    && !Object.hasOwn(cleanup, 'metalContextDetached'), 'Linux software presenter/session/window cleanup barrier was not observed')
}

/** Strict CLI grammar avoids ambiguous defaults, repeated values and unknown
 * flags. A repeated-list option is explicit in the caller's specification. */
export function parseOptions(args, { values = [], flags = [], repeat = [], required = [] } = {}) {
  const result = {}
  for (let at = 0; at < args.length; at++) {
    const key = args[at]
    require([...values, ...flags, ...repeat].includes(key), `Unknown native option: ${key}`)
    require(repeat.includes(key) || !Object.hasOwn(result, key), `Duplicate native option: ${key}`)
    if (flags.includes(key)) { result[key] = true; continue }
    const value = args[++at]
    require(typeof value === 'string' && value && !value.startsWith('--'), `Missing native option value: ${key}`)
    if (repeat.includes(key)) {
      result[key] ??= []
      require(!result[key].includes(value), `Duplicate native option value: ${key}`)
      result[key].push(value)
    } else result[key] = value
  }
  require(required.every(key => Object.hasOwn(result, key)), `Required native options: ${required.join(', ')}`)
  return result
}
