import assert from 'node:assert/strict'
import test from 'node:test'
import { assertReferenceHostInfo, displayDensityRestore, displaySizeRestore, exerciseAndroidReference, inspectInteractionReceipt, referenceDensityTarget, referenceResizeTarget, referenceTapPoint } from './android-reference-interaction.mjs'

const expected = { sessionId: 'owned-session', engine: 'quickjs', manifestIntegrity: 'a'.repeat(64) }
function hostInfo(value) {
  const raw = value.windowObservation, ratio = raw.density
  const system = { pixelRatio: ratio, screenWidth: Math.round(raw.displayWidth / ratio), screenHeight: Math.round(raw.displayHeight / ratio),
    windowWidth: value.viewport.width, windowHeight: value.viewport.height, statusBarHeight: raw.statusBars.top / ratio, deviceOrientation: raw.deviceOrientation }
  const { deviceOrientation, ...window } = system
  return { window: { ...window, screenTop: raw.windowOrigin.y / ratio }, system,
    device: { platform: 'android' }, settings: { deviceOrientation: raw.deviceOrientation } }
}
function receipt() {
  const value = { schemaVersion: 1, ...expected, status: 'ready', revision: 1,
    viewport: { width: 400, height: 550 }, hostWindow: { width: 400, height: 550 },
    windowObservation: { density: 2, displayWidth: 800, displayHeight: 1200, deviceOrientation: 'portrait',
      windowOrigin: { x: 0, y: 48 }, statusBars: { top: 48 }, safeAreaMapping: 'unknown' },
    surface: { width: 800, height: 1100, density: 2, screenX: 10, screenY: 70, backend: 'skia-gpu-gles', presentedFrameId: 1 },
    page: { route: 'pages/home/index', data: { count: 0,
      lifecycleTrace: ['app:launch', 'app:show', 'page:load', 'page:show', 'page:ready'] } }, lifecycle: [],
    frame: { frame_id: 1, viewport: { x: 0, y: 0, width: 400, height: 550 }, root: { id: 'root', children: [
      { id: 'increment', bounds: { x: 10, y: 20, width: 100, height: 30 } },
      { id: 'component-increment', bounds: { x: 10, y: 80, width: 100, height: 30 } },
      { id: 'component-slot', bounds: { x: 10, y: 140, width: 100, height: 30 } },
      { text: '点击次数：0' }, { text: '组件计数：0' }, { text: '页面 slot：0' },
    ] } } }
  value.displayMetrics = { pixelRatio: 2 }
  value.page.data.moduleScopeHostInfo = hostInfo(value)
  return value
}

test('input coordinates use the physical surface origin and viewport ratio', () => {
  const value = receipt()
  assert.deepEqual(referenceTapPoint(value, 'increment'), { x: 130, y: 140 })
  value.frame.root.children.push({ ...value.frame.root.children[0] })
  assert.throws(() => referenceTapPoint(value, 'increment'), /Expected one/)
  value.frame.root.children.pop()
  value.frame.root.children[0].bounds.y = 900
  assert.throws(() => referenceTapPoint(value, 'increment'), /outside/)
})

test('foreign session and ambiguous display metadata cannot authorize inputs', () => {
  assert.throws(() => inspectInteractionReceipt({ ...receipt(), sessionId: 'other' }, expected), /sessionId changed/)
  assert.equal(displaySizeRestore('Physical size: 1080x2340\n'), 'reset')
  assert.equal(displaySizeRestore('Physical size: 1080x2340\nOverride size: 800x1200\n'), '800x1200')
  assert.equal(referenceResizeTarget('Physical size: 900x1600\n'), '1000x1700')
  assert.equal(referenceResizeTarget('Physical size: 900x1600\nOverride size: 800x1200\n'), '900x1600')
  assert.equal(referenceResizeTarget('Physical size: 1080x2340\nOverride size: 900x1600\n'), '1000x1700')
  assert.throws(() => displaySizeRestore('Override size: 800x1200\n'), /original display/)
  assert.throws(() => displaySizeRestore('Physical size: 1080x2340\nOverride size: 800x1200\nOverride size: 900x1600\n'), /original display/)
})

test('density parser preserves an existing override and rejects ambiguous or zero values', () => {
  assert.equal(displayDensityRestore('Physical density: 440\n'), 'reset')
  assert.equal(displayDensityRestore('Physical density: 440\nOverride density: 320\n'), '320')
  assert.equal(referenceDensityTarget('Physical density: 480\n'), '420')
  assert.equal(referenceDensityTarget('Physical density: 440\nOverride density: 320\n'), '480')
  assert.throws(() => displayDensityRestore('Override density: 320\n'), /original display density/)
  assert.throws(() => displayDensityRestore('Physical density: 0\n'), /original display density/)
  assert.throws(() => displayDensityRestore('Physical density: 440\nOverride density: 0\n'), /original display density/)
  assert.throws(() => displayDensityRestore('Physical density: 440\nOverride density: 320\nOverride density: 480\n'), /original display density/)
})

test('matching receipt values cannot hide wrong density, screen/window conflation or fabricated safe area', () => {
  const display = { width: 800, height: 1200, pixelRatio: 2 }
  const value = receipt()
  assertReferenceHostInfo(value.page.data.moduleScopeHostInfo, value, display)
  const stale = structuredClone(value.page.data.moduleScopeHostInfo)
  stale.window.pixelRatio = 1
  assert.throws(() => assertReferenceHostInfo(stale, value, display), /getWindowInfo.pixelRatio/)
  stale.window.pixelRatio = 2
  stale.system.screenHeight = value.viewport.height
  assert.throws(() => assertReferenceHostInfo(stale, value, display), /getSystemInfoSync.screenHeight/)
  const fabricated = structuredClone(value.page.data.moduleScopeHostInfo)
  fabricated.window.safeArea = { top: 0, left: 0, width: 400, height: 550 }
  assert.throws(() => assertReferenceHostInfo(fabricated, value, display), /unverified safe-area/)
  value.displayMetrics.pixelRatio = value.windowObservation.density = 1
  assert.throws(() => assertReferenceHostInfo(stale, value, display), /differs from wm density/)
})

test('matching absent or non-numeric frame IDs never prove presentation', () => {
  for (const invalid of [undefined, null, NaN, '1', -1, 1.5]) {
    const value = receipt()
    value.frame.frame_id = invalid
    value.surface.presentedFrameId = invalid
    assert.throws(() => inspectInteractionReceipt(value, expected), /frame ID/)
  }
  const value = receipt()
  value.surface.presentedFrameId = undefined
  assert.throws(() => inspectInteractionReceipt(value, expected), /presented frame ID/)
})

function scenario(options = {}) {
  let value = receipt(), time = 0, display = '800x1200', density = '320', page = 0, component = 0
  const commands = [], saved = [], captures = [], evidence = {}
  function commit() {
    value.revision++; value.frame.frame_id++; value.surface.presentedFrameId = value.frame.frame_id
    value.page.data.count = page
    value.frame.root.children.slice(3).forEach((node, i) => { node.text = [`点击次数：${page}`, `组件计数：${component}`, `页面 slot：${page}`][i] })
  }
  function updateWindow() {
    const [width, height] = display.split('x').map(Number), ratio = Number(density) / 160
    Object.assign(value.windowObservation, { displayWidth: width, displayHeight: height, density: ratio })
    Object.assign(value.surface, { width, height: height - 100, density: ratio })
    value.viewport = { width: Math.round(width / ratio), height: Math.round((height - 100) / ratio) }
    Object.assign(value.frame.viewport, value.viewport)
    value.hostWindow = options.staleWindow && display === '900x1600' ? { width: 400, height: 550 } : { ...value.viewport }
    value.displayMetrics = { pixelRatio: ratio }
    value.page.data.resizeHostInfo = hostInfo(value)
    if (options.staleDensity && density === '480') value.page.data.resizeHostInfo.window.pixelRatio = 1
    value.page.data.windowInfo = value.page.data.resizeHostInfo.window
    value.page.data.lifecycleTrace.push('page:resize')
    commit()
  }
  const context = { serial: 'emulator-5580', package: 'com.sonofmagic.weapp.container', expected, evidence,
    now: () => time, timeoutMs: 300, wait: async ms => { time += ms }, assertLive: () => {},
    read: () => structuredClone(value), save: label => saved.push(label), capture: label => { captures.push(label) },
    command(args) {
      commands.push(args)
      if (args[1] === 'input' && args[2] === 'tap') {
        if (args[4] === '260') component++
        else page++
        value.page.data.tapHostInfo = hostInfo(value)
        commit()
      } else if (args.slice(1, 3).join(' ') === 'wm size') {
        if (args.length === 3) return { text: `Physical size: 1080x2340\nOverride size: ${display}\n` }
        display = args[3]
        updateWindow()
      } else if (args.slice(1, 3).join(' ') === 'wm density') {
        if (args.length === 3) return { text: `Physical density: 440\nOverride density: ${density}\n` }
        density = args[3]
        updateWindow()
      } else if (args[2] === 'keyevent') {
        value.status = 'suspended'; value.lifecycle.push({ sequence: value.revision + 1, event: 'hide' })
        value.page.data.lifecycleTrace.push('app:hide')
        if (!options.missingPageCallbacks) value.page.data.lifecycleTrace.push('page:hide')
        commit()
      } else if (args[1] === 'am') {
        value.status = 'ready'; value.lifecycle.push({ sequence: value.revision + 1, event: 'show' })
        value.page.data.showHostInfo = options.staleShowHostInfo ? value.page.data.moduleScopeHostInfo : hostInfo(value)
        value.page.data.lifecycleTrace.push('app:show')
        if (!options.missingPageCallbacks) value.page.data.lifecycleTrace.push('page:show')
        commit()
      }
      return { text: '' }
    },
  }
  return { context, commands, saved, captures, evidence, get value() { return value }, display: () => display, density: () => density }
}

test('reference exercise uses OS inputs, preserves independent state and restores observed display override', async () => {
  const s = scenario()
  await exerciseAndroidReference(s.context)
  assert.equal(s.evidence.status, 'passed')
  assert.equal(s.display(), '800x1200')
  assert.deepEqual(s.captures, ['initial', 'page-tap', 'component-tap', 'slot-tap', 'resize', 'resized-page-tap', 'resize-restored', 'density', 'density-restored', 'resume', 'resume-density-restored'])
  assert.equal(s.density(), '320')
  assert.equal(s.evidence.checks.density.callbackHostInfo.window.pixelRatio, 3)
  assert.equal(s.evidence.checks.lifecycle.pageCount, 3)
  assert.equal(s.evidence.checks.lifecycle.componentCount, 1)
  assert.ok(s.saved.includes('background') && s.saved.includes('resume'))
  assert.equal(s.commands.filter(args => args[2] === 'tap').length, 4)
})

test('onShow must see changes observed while paused and a failure still restores density', async () => {
  const s = scenario({ staleShowHostInfo: true })
  await assert.rejects(exerciseAndroidReference(s.context), /Deadline.*resume/)
  assert.equal(s.evidence.status, 'failed')
  assert.equal(s.evidence.densityCleanup.status, 'passed')
  assert.equal(s.density(), '320')
})

test('input uses the newer accepted capture geometry when the frame advances after polling', async () => {
  const s = scenario()
  s.context.capture = async label => {
    if (label === 'initial') {
      s.value.revision++
      s.value.frame.frame_id++
      s.value.surface.presentedFrameId = s.value.frame.frame_id
      s.value.frame.root.children[0].bounds.x = 30
    }
    return structuredClone(s.value)
  }
  await exerciseAndroidReference(s.context)
  const firstTap = s.commands.find(args => args[1] === 'input' && args[2] === 'tap')
  assert.equal(firstTap[3], '170', 'Tap must use the accepted new x coordinate')
  assert.equal(s.evidence.status, 'passed')
})

test('an asynchronous initial screenshot failure stops the exercise before the first touch', async () => {
  const s = scenario()
  s.context.capture = async label => {
    assert.equal(label, 'initial')
    await Promise.resolve()
    throw new Error('Stable pixels were not observed')
  }
  await assert.rejects(exerciseAndroidReference(s.context), /Stable pixels were not observed/)
  assert.equal(s.evidence.status, 'failed')
  assert.equal(s.commands.filter(args => args[1] === 'input').length, 0)
})

test('a stale density API fails the exercise and restores the original density override', async () => {
  const s = scenario({ staleDensity: true })
  await assert.rejects(exerciseAndroidReference(s.context), /Deadline.*density/)
  assert.equal(s.evidence.status, 'failed')
  assert.equal(s.evidence.densityCleanup.status, 'passed')
  assert.equal(s.density(), '320')
  assert.ok(!s.saved.includes('resume'))
})

test('cancellation after density change restores the exact observed density', async () => {
  const s = scenario()
  let aborted = false
  const execute = s.context.command
  s.context.command = (args, options) => {
    if (aborted && !options?.cleanup) throw new Error('Run aborted')
    return execute(args)
  }
  s.context.capture = label => { if (label === 'density') { aborted = true; throw new Error('Run aborted') } }
  await assert.rejects(exerciseAndroidReference(s.context), /Run aborted/)
  assert.equal(s.evidence.densityCleanup.status, 'passed')
  assert.equal(s.density(), '320')
  assert.equal(s.display(), '800x1200')
})

test('stale runtime window fails resize and still restores the exact original override', async () => {
  const s = scenario({ staleWindow: true })
  await assert.rejects(exerciseAndroidReference(s.context), /window width is stale/)
  assert.equal(s.evidence.status, 'failed')
  assert.equal(s.evidence.displayCleanup.status, 'passed')
  assert.equal(s.display(), '800x1200')
  assert.ok(!s.saved.includes('resume'))
})

test('foreign session fails before issuing any system input', async () => {
  const s = scenario()
  s.context.read = () => ({ ...receipt(), sessionId: 'unowned' })
  await assert.rejects(exerciseAndroidReference(s.context), /sessionId changed/)
  assert.deepEqual(s.commands, [])
})

test('cancellation after resize still permits only cleanup commands to restore display', async () => {
  const s = scenario()
  let aborted = false
  const execute = s.context.command
  s.context.command = (args, options) => {
    if (aborted && !options?.cleanup) throw new Error('Run aborted')
    return execute(args)
  }
  s.context.capture = label => { if (label === 'resize') { aborted = true; throw new Error('Run aborted') } }
  await assert.rejects(exerciseAndroidReference(s.context), /Run aborted/)
  assert.equal(s.evidence.status, 'failed')
  assert.equal(s.evidence.displayCleanup.status, 'passed')
  assert.equal(s.display(), '800x1200')
})

test('failed display restoration remains visible as a failed exercise', async () => {
  const s = scenario()
  const execute = s.context.command
  s.context.command = (args, options) => {
    if (args.join(' ') === 'shell wm size 800x1200') throw new Error('Display transport failed')
    return execute(args, options)
  }
  await assert.rejects(exerciseAndroidReference(s.context), /Display transport failed/)
  assert.equal(s.evidence.status, 'failed')
  assert.equal(s.evidence.displayCleanup.status, 'failed')
  assert.equal(s.display(), '900x1600')
})

test('host lifecycle labels cannot replace actual Page callback evidence', async () => {
  const s = scenario({ missingPageCallbacks: true })
  await assert.rejects(exerciseAndroidReference(s.context), /Deadline.*background/)
  assert.equal(s.evidence.status, 'failed')
  assert.equal(s.display(), '800x1200')
  assert.ok(!s.saved.includes('resume'))
})

test('initial App show after Page load fails before the first touch', async () => {
  const s = scenario()
  const value = receipt()
  value.page.data.lifecycleTrace = ['app:launch', 'page:load', 'page:show', 'page:ready', 'app:show']
  s.context.read = () => value
  await assert.rejects(exerciseAndroidReference(s.context), /Initial callbacks/)
  assert.deepEqual(s.commands, [])
})
