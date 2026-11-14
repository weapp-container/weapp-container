import { createRequire } from 'node:module'
import { sha256 } from './host-api-matrix.mjs'

const { parse: parseJavaScript, tokenizer: tokenizeJavaScript, version: parserVersion } = createRequire(
  new URL('../tools/container-manifest/package.json', import.meta.url),
)('acorn')
if (parserVersion !== '8.15.0') throw new Error('Core source inventory requires the reviewed Acorn 8.15.0 parser')

const sourcePaths = {
  workspaceManifest: 'Cargo.toml',
  workspaceLock: 'Cargo.lock',
  coreAssembly: 'crates/container-core/src/lib.rs',
  quickjsExecution: 'crates/container-engine-quickjs/src/execution.rs',
  terminalResources: 'crates/container-core/src/engine_terminal_resources.rs',
  engineExecution: 'crates/container-core/src/engine_execution.rs',
  bufferURLs: 'crates/container-core/src/buffer-url.js',
  bufferURLStore: 'crates/container-core/src/buffer_urls.rs',
  bufferURLProjection: 'crates/container-runtime/src/buffer_urls.rs',
  imageResources: 'crates/container-runtime/src/images.rs',
  workerDOM: 'examples/hosts/web-wasm/worker-dom-adapter.mjs',
  workerRuntime: 'examples/hosts/web-wasm/worker-runtime.mjs',
  coreManifest: 'crates/container-core/Cargo.toml',
  commonHost: 'crates/container-host-common/src/lib.rs',
  runtime: 'crates/container-runtime/src/lib.rs',
  snapshots: 'crates/container-runtime/src/host_environment.rs',
  strictProvider: 'crates/container-runtime/src/strict_provider.rs',
  geometry: 'crates/container-runtime/src/host_geometry.rs',
  windowMetrics: 'crates/container-runtime/src/window_metrics.rs',
  nativeProvider: 'crates/container-sdk/src/lib.rs',
  hostServices: 'crates/container-runtime/src/host_services.rs',
  asyncHost: 'crates/container-runtime/src/async_host.rs',
  boundary: 'crates/container-core/src/host-bridge.js',
  console: 'crates/container-core/src/dev-console.js',
  logManager: 'crates/container-core/src/log-manager.js',
  logJournal: 'crates/container-core/src/log_manager.rs',
  simulatorWeb: 'crates/container-simulator/src/web.rs',
  environment: 'crates/container-core/src/host_environment.rs',
  syncFiles: 'crates/container-runtime/src/sync_files.rs',
  syncDescriptors: 'crates/container-runtime/src/sync_file_descriptors.rs',
  syncStats: 'crates/container-runtime/src/sync_file_stats.rs',
  syncCodecs: 'crates/container-runtime/src/sync_file_codecs.rs',
  performance: 'crates/container-core/src/performance.js',
  moduleOwner: 'crates/container-core/src/modules.js',
  performanceLifetime: 'crates/container-core/src/performance_lifetime.rs',
  eventChannel: 'crates/container-core/src/event-channel.js',
  storage: 'crates/container-core/src/storage.js',
  storageCore: 'crates/container-core/src/storage.rs',
  storageTransactions: 'crates/container-runtime/src/storage_transactions.rs',
  lifecycleNotifications: 'crates/container-core/src/lifecycle-notifications.js',
  errorNotifications: 'crates/container-core/src/error-notifications.js',
  pageNotFoundNotifications: 'crates/container-core/src/page-not-found-notifications.js',
  unhandledRejections: 'crates/container-core/src/unhandled-rejections.js',
  windowResizeNotifications: 'crates/container-core/src/window-resize-notifications.js',
  finiteNotifications: 'crates/container-core/src/finite-notifications.js',
  finiteNotificationResources: 'crates/container-runtime/src/finite_notifications.rs',
  randomValues: 'crates/container-core/src/random-values.js',
  randomValuesRuntime: 'crates/container-runtime/src/random_values.rs',
  timerTasks: 'crates/container-core/src/timer-tasks.js',
  turnScheduler: 'crates/container-core/src/turn-scheduler.js',
  runtimeTurnScheduler: 'crates/container-runtime/src/turn_scheduler.rs',
  componentEvents: 'crates/container-core/src/component-events.js',
  componentRelations: 'crates/container-core/src/component-relations.js',
  engineBatch: 'crates/container-core/src/engine-batch-call.js',
  routeNotifications: 'crates/container-core/src/route-transaction.js',
  routeLease: 'crates/container-core/src/route_transaction.rs',
  runtimeRoutes: 'crates/container-runtime/src/route_transaction.rs',
  hostInstaller: 'crates/container-core/src/host-environment-install.js',
  mediaQueries: 'crates/container-core/src/media-query-observers.js',
  intersectionQueries: 'crates/container-core/src/intersection-observers.js',
  observerComponents: 'crates/container-runtime/src/components.rs',
  browserView: 'crates/container-runtime/src/browser_view.rs',
  renderProfiles: 'crates/container-ir/src/rendering.rs',
  sdkFfi: 'crates/container-sdk-ffi/src/lib.rs',
  webHost: 'crates/container-host-web/src/lib.rs',
  selectorQueries: 'crates/container-core/src/selector-query.js',
  privateSelectors: 'crates/container-runtime/src/private_selector.rs',
  nativeQueries: 'crates/container-runtime/src/native_query.rs',
  browserQueries: 'crates/container-runtime/src/browser_query.rs',
  selectorGeometry: 'crates/container-runtime/src/selector_geometry.rs',
  domPresenter: 'examples/hosts/web-wasm/dom-presenter.mjs',
  domSessionClient: 'examples/hosts/web-wasm/dom-session-client.mjs',
  pageMirror: 'crates/container-core/src/page-mirror.js',
  runtimeLifecycle: 'crates/container-runtime/src/lifecycle_notifications.rs',
  animation: 'crates/container-core/src/animation.js',
  bridgeOperations: 'crates/container-bridge/src/lib.rs',
  viewRuntime: 'crates/container-core/src/view.rs',
  viewLegacy: 'crates/container-core/src/view.js',
  viewModern: 'crates/container-core/src/modern_view.js',
  irAssembly: 'crates/container-ir/src/lib.rs',
  irMarkup: 'crates/container-ir/src/markup.rs',
  irBindingProvenance: 'crates/container-ir/src/binding_provenance.rs',
  animationBindings: 'crates/container-runtime/src/animation_bindings.rs',
  animationClock: 'crates/container-runtime/src/animation_clock.rs',
  animationTimeline: 'crates/container-runtime/src/animation_timeline.rs',
  animationProtocol: 'crates/container-runtime/src/animation_protocol.rs',
  animationPlayback: 'crates/container-runtime/src/animation_playback.rs',
  animationSession: 'crates/container-runtime/src/animation_session.rs',
  animationNative: 'crates/container-runtime/src/animation_native.rs',
  browserAnimation: 'crates/container-runtime/src/browser_animation.rs',
  frameInput: 'crates/container-runtime/src/frame_input.rs',
  viewExecution: 'crates/container-runtime/src/view_execution.rs',
  renderWork: 'crates/container-runtime/src/render_work.rs',
  engineTurn: 'crates/container-runtime/src/engine_turn.rs',
  devLogicalResize: 'crates/container-runtime/src/dev_logical_resize.rs',
  styleTransforms: 'crates/container-runtime/src/style_transforms.rs',
  rendererAnimation: 'crates/container-runtime/src/render_backend/animation.rs',
  domAnimationSample: 'examples/hosts/web-wasm/dom-animation-sample.mjs',
  presentationScheduler: 'examples/hosts/web-wasm/presentation-scheduler.mjs',
  workerBridgeTransport: 'examples/hosts/web-wasm/worker-bridge-transport.mjs',
  workerSessionClient: 'examples/hosts/web-wasm/worker-session-client.mjs',
  workerWebSession: 'examples/hosts/web-wasm/worker-web-session.mjs',
  canvas: 'crates/container-core/src/canvas.js',
  canvasArcTo: 'crates/container-render-skia/src/canvas_arcto.rs',
  canvasBatch: 'crates/container-render-skia/src/canvas_batch.rs',
  canvasClip: 'crates/container-render-skia/src/canvas_clip.rs',
  canvasService: 'crates/container-render-skia/src/canvas_service.rs',
  canvasRaster: 'crates/container-render-skia/src/lib.rs',
  canvasStroke: 'crates/container-render-skia/src/canvas_stroke.rs',
  quickjs: 'crates/container-engine-quickjs/src/lib.rs',
  v8: 'crates/container-engine-v8/src/lib.rs',
  observers: 'crates/container-runtime/src/observers.rs',
  navigation: 'crates/container-runtime/src/navigation_layout.rs',
  renderer: 'crates/container-runtime/src/render_backend.rs',
  tabBar: 'crates/container-core/src/tab-bar.js',
  tabBarState: 'crates/container-runtime/src/tab_bar.rs',
  chrome: 'crates/container-runtime/src/chrome.rs',
  manifestPacker: 'tools/container-manifest/src/index.ts',
  flutterController: 'sdk/flutter/weapp_container/lib/src/controller.dart',
  flutterView: 'sdk/flutter/weapp_container/lib/src/view.dart',
  playerModel: 'apps/dev-player/lib/src/player_model.dart',
  playerChrome: 'apps/dev-player/lib/src/mini_program_chrome.dart',
  playerMain: 'apps/dev-player/lib/main.dart',
  flutterAndroid: 'sdk/flutter/weapp_container_android/android/src/main/kotlin/dev/weapp/container/flutter/WeappContainerAndroidPlugin.kt',
  androidSession: 'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/WeappContainerSession.kt',
  flutterIos: 'sdk/flutter/weapp_container_ios/ios/Classes/WeappContainerIosPlugin.swift',
  iosTypes: 'sdk/ios/Sources/WeappContainer/Types.swift',
  iosSession: 'sdk/ios/Sources/WeappContainer/Session.swift',
  flutterMacos: 'sdk/flutter/weapp_container_macos/macos/Classes/WeappContainerMacosPlugin.mm',
  desktopRegistry: 'sdk/flutter/native_desktop/src/registry.cpp',
  nativePreview: 'sdk/flutter/native_desktop/include/native_preview_texture.hpp',
  nativeChrome: 'sdk/flutter/native_desktop/include/native_chrome_overlay.hpp',
  flutterWindows: 'sdk/flutter/weapp_container_windows/windows/weapp_container_windows_plugin.cpp',
  flutterLinux: 'sdk/flutter/weapp_container_linux/linux/weapp_container_linux_plugin.cc',
}
const assert = (value, message) => { if (!value) throw new Error(message) }
const quoted = source => [...source.matchAll(/"([A-Za-z0-9_.:]+)"/g)].map(match => match[1])
function between(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length)
  assert(first >= 0 && last > first, `Core source inventory anchor missing: ${start}`)
  return source.slice(first, last)
}
function functionBlock(source, name, { lexical = false } = {}) {
  const start = lexical ? `const ${name} = function(` : `function ${name}(`, first = source.indexOf(start)
  assert(first >= 0, `Core JS function missing: ${name}`)
  const last = source.indexOf(lexical ? '\n};' : '\nfunction ', first + start.length)
  assert(last > first, `Core JS function boundary missing: ${name}`)
  return source.slice(first, last)
}
const containsAll = (source, anchors) => anchors.every(anchor => source.includes(anchor))

// Acorn parses original JavaScript bytes. AST identity is the source evidence
// gate; token anchors only retain useful diagnostics for changed reviewed code.
// Rust token anchors below provide diagnostics only. Reviewed whole-file byte
// identity supplies the scheduler Rust source-evidence boundary.
const javascriptOptions = { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }
const javascriptProgram = source => parseJavaScript(source, javascriptOptions)
function canonicalJavaScript(value) {
  if (typeof value === 'bigint') return { bigintValue: value.toString() }
  if (typeof value === 'number' && !Number.isFinite(value)) return { numberValue: String(value) }
  if (value instanceof RegExp) return { regexpValue: { source: value.source, flags: value.flags } }
  if (Array.isArray(value)) return value.map(canonicalJavaScript)
  if (!value || typeof value !== 'object') return value
  const node = typeof value.type === 'string'
  return Object.fromEntries(Object.keys(value).sort().filter(key =>
    !(node && ['start', 'end', 'loc', 'range'].includes(key))
    && !(value.type === 'Literal' && key === 'raw'),
  ).map(key => [key, canonicalJavaScript(value[key])]))
}
const javascriptShape = node => sha256(JSON.stringify(canonicalJavaScript(node)))
const reviewedJavaScriptShapes = Object.freeze({
  "finiteNotifications": "03e6eb2ef4a54c35489276c39f534ae8a53dde00c74104c4d2a11f1e87cbb4d4",
  "logManager": "8bbe05244b02c9dfd3b7b3f1d0c9aace9a14dd73f42ecf5dcbca94a02d70ea2b",
  "scheduler": "82a92a30696b92ae3300362e993fa78a9f3ae21d8399ba0c18a87f815f259420",
  "installer": "0233e8ae61b96d0f92288797708c81b32c107e407d2c429e26ac9457474c8f01",
  "lifecycle": "1f555c771395a58b8bd42e05cfc63c70e93b35e548e36edb246ebeacc1d11971",
  "routeCleanup": "b7295e63230bc296900bae33db9e52cae4b24b69ca6500ecd4f405e00cca5114",
  "pageNotFoundCleanup": "6629b09f211fe584c4ecbb38271206d1211b359c9ffcc9902e5b0d817468a60b",
  "unhandledRejectionRemoval": "8f16bc8103d2d26e8d39f5789af95aebf3ba647a4ec402977c7d59a4e9e10135",
  "windowResizeRemoval": "ff062042e31dc7c507fcb432972788b7dd1e63b242871584f2ede8d176d10ef0",
  "cleanupBoundary": "43bd008d976ffde0234b531a49e955e9258244ae147fd8055bdd3257d44f6e9b",
  "performanceDisconnect": "2f894aea5749e14c65f934529d673cd59d308f61b23171d153b749504784cf47"
})
function javascriptTokens(source) {
  const tokens = [], reader = tokenizeJavaScript(source, javascriptOptions)
  for (let token = reader.getToken(); token.type.label !== 'eof'; token = reader.getToken()) {
    const label = token.type.label
    if (label === 'string') tokens.push({ kind: 'string', value: token.value })
    else if (label === 'num' || label === 'bigint') tokens.push({ kind: 'number', value: String(token.value) })
    else if (label === 'regexp') tokens.push({ kind: 'regexp', value: token.value.pattern + '/' + token.value.flags })
    else if (label === 'name' || token.type.keyword) tokens.push({ kind: 'word', value: String(token.value ?? token.type.keyword) })
    else tokens.push({ kind: 'punctuation', value: String(token.value ?? label) })
  }
  return tokens
}
function javascriptIife(program, name) {
  const declarations = program.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
    .filter(node => node.id.type === 'Identifier' && node.id.name === name)
  assert(declarations.length === 1 && declarations[0].init?.type === 'CallExpression'
    && declarations[0].init.callee.type === 'FunctionExpression', `Reviewed JavaScript closure boundary changed: ${name}`)
  return declarations[0].init.callee.body
}
function javascriptDirectStatement(block, source) {
  const expected = javascriptShape(javascriptProgram(source).body[0])
  for (const statement of block.body) {
    if (['ReturnStatement', 'ThrowStatement'].includes(statement.type)) return false
    if (javascriptShape(statement) === expected) return true
  }
  return false
}
function sourceCode(source, language = 'js') {
  if (language !== 'rust') return javascriptTokens(source)
  const result = [], rust = true
  const append = (kind, value) => result.push({ kind, value })
  const escape = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }
  let index = 0
  while (index < source.length) {
    const rest = source.slice(index), char = source[index]
    if (/\s/.test(char)) { index++; continue }
    if (rest.startsWith('//')) {
      const end = source.indexOf('\n', index + 2)
      index = end < 0 ? source.length : end + 1; continue
    }
    if (rest.startsWith('/*')) {
      index += 2; let depth = 1
      while (index < source.length && depth) {
        if (rust && source.startsWith('/*', index)) { depth++; index += 2 }
        else if (source.startsWith('*/', index)) { depth--; index += 2 }
        else index++
      }
      assert(depth === 0, 'Source inventory cannot parse an unterminated comment')
      continue
    }
    const raw = rust && /^(?:br|r)(#*)"/.exec(rest)
    if (raw) {
      const start = index + raw[0].length, suffix = '"' + raw[1], end = source.indexOf(suffix, start)
      assert(end >= 0, 'Source inventory cannot parse an unterminated Rust raw string')
      append(raw[0].startsWith('br') ? 'byteString' : 'string', source.slice(start, end)); index = end + suffix.length; continue
    }
    // Rust lifetimes are identifiers, not opening character literals.
    const lifetime = rust && /^'[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (lifetime && source[index + lifetime[0].length] !== "'") {
      append('word', lifetime[0]); index += lifetime[0].length; continue
    }
    if (char === '"' || char === "'") {
      const quote = char; let value = '', ended = false; index++
      while (index < source.length) {
        const next = source[index++]
        if (next === quote) { ended = true; break }
        if (next !== '\\') { value += next; continue }
        assert(index < source.length, 'Source inventory cannot parse an incomplete string escape')
        const escaped = source[index++]
        if (escaped === '\n') continue
        if (escaped === '\r') { if (source[index] === '\n') index++; continue }
        if (escaped === 'x' || escaped === 'u') {
          const braced = escaped === 'u' && source[index] === '{'
          const end = braced ? source.indexOf('}', ++index) : index + (escaped === 'x' ? 2 : 4)
          const digits = source.slice(index, end)
          assert(end >= index && /^[0-9a-f]+$/i.test(digits), 'Source inventory cannot parse a string code point')
          value += String.fromCodePoint(Number.parseInt(digits, 16)); index = end + (braced ? 1 : 0)
        } else value += Object.hasOwn(escape, escaped) ? escape[escaped] : escaped
      }
      assert(ended, 'Source inventory cannot parse an unterminated string')
      append(quote === '`' ? 'template' : 'string', value); continue
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest)
    if (word) { append('word', word[0]); index += word[0].length; continue }
    const number = /^(?:0[xob][0-9a-f_]+|[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:e[+-]?[0-9]+)?)(?:[a-z][a-z0-9_]*)?/i.exec(rest)
    if (number) { append('number', number[0]); index += number[0].length; continue }
    const operator = /^(?:===|!==|\.\.\.|\.\.=|=>|==|!=|&&|\|\||>=|<=|\+=|-=|\+\+|--|::|\.\.|\?\.|\?\?)/.exec(rest)
    append('punctuation', operator ? operator[0] : char); index += operator ? operator[0].length : 1
  }
  return result
}
const equalCode = (left, right) => left.length === right.length
  && left.every((token, index) => token.kind === right[index].kind && token.value === right[index].value)
function codePositions(tokens, pattern, language = 'js') {
  const target = typeof pattern === 'string' ? sourceCode(pattern, language) : pattern, positions = []
  for (let index = 0; index <= tokens.length - target.length; index++) {
    if (equalCode(tokens.slice(index, index + target.length), target)) positions.push(index)
  }
  return positions
}
const containsCode = (tokens, anchors, language = 'js') => anchors.every(anchor => codePositions(tokens, anchor, language).length > 0)
function closeCode(tokens, start) {
  const closing = { '(': ')', '[': ']', '{': '}' }, stack = []
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.kind !== 'punctuation') continue
    if (closing[token.value]) stack.push(closing[token.value])
    else if ([')', ']', '}'].includes(token.value)) {
      assert(stack.pop() === token.value, 'Source inventory cannot parse unbalanced delimiters')
      if (!stack.length) return index
    }
  }
  throw new Error('Source inventory cannot parse an incomplete block')
}
function codeBlock(tokens, signature, language = 'js') {
  const positions = codePositions(tokens, signature, language)
  assert(positions.length === 1, `Executable source inventory needs one block: ${signature}`)
  const start = tokens.findIndex((token, index) => index >= positions[0] && token.kind === 'punctuation' && token.value === '{')
  assert(start >= 0, `Executable source inventory block missing: ${signature}`)
  return tokens.slice(start + 1, closeCode(tokens, start))
}
function conditionalCeiling(tokens) {
  const positions = codePositions(tokens, 'let ceiling = if', 'rust')
  assert(positions.length === 1, 'TabBar explicit presenter admission and Partial ceiling changed')
  const first = positions[0] + 4, open = tokens.findIndex((token, index) => index >= first && token.kind === 'punctuation' && token.value === '{')
  const end = closeCode(tokens, open), otherwise = end + 2
  assert(tokens[end + 1]?.value === 'else' && tokens[otherwise]?.value === '{', 'TabBar explicit presenter admission and Partial ceiling changed')
  const condition = tokens.slice(first, open), parts = []; let start = 0
  for (let index = 0; index < condition.length; index++) {
    const token = condition[index]
    if (token.kind === 'punctuation' && ['(', '[', '{'].includes(token.value)) index = closeCode(condition, index)
    else if (token.value === '||') { parts.push(condition.slice(start, index)); start = index + 1 }
  }
  parts.push(condition.slice(start))
  return { condition, parts, partial: tokens.slice(open + 1, end), full: tokens.slice(otherwise + 1, closeCode(tokens, otherwise)) }
}
// One reviewed byte identity per source, shared by every evidence scope.
// Update only after reviewing the complete delta and its boundary tests; see
// docs/host-services/source-review.md. These pins never grant SDK acceptance.
const reviewedSourceSha256 = Object.freeze({
  "quickjs": "e87e970390b93e89f56c98e02af1b31183376b5ae52c9d88f71ff2827968c28f",
  "v8": "70a0a54ba87bd8995ea2038df7e01669206df8d913a72dc3971acb259f94aafa",
  "runtime": "d23d9274ad94f4c5fdbcc2b86b057babcf8b8b9f7dcf66eae0614426640624c8",
  "runtimeTurnScheduler": "4fa75f511dd8655da2e540b6a3487d39a48116f2143577d1817586a00ca2b3b6",
  "runtimeRoutes": "2c6d7576fa806268005af696cdf1a7f0b054249cb37cf1f70e529fd459be415e",
  "hostServices": "fa059a3b1da09361c00da6ee3c29e4aee7d5c9762cc313d1e5576fbd0194ca60",
  "runtimeLifecycle": "5b48c668e941f7a5699264575543108994cf52b3c919924d7842b2756d0b4b80",
  "manifestPacker": "8ccb528afab024bbd23927a1095814f65401511054b3dde7f427a54b5e6956e2",
  "finiteNotificationResources": "40e629a4cba3d4dff1e2fe68d9de15fc16b8ce0b3926650318f27d2920b6bc59",
  "coreAssembly": "3c537fa5e0fccf44dcce64f73f8c387d58c9a4a5be22eca3fd74b92767902591",
  "quickjsExecution": "c8c1dc74b22b0954e6a2524ba26dd9e4512771c928253f5a054a7fd6495213b0",
  "terminalResources": "072d04a08a6141bf4da22496b3764a58447d54a93e6b0c31888d18cf0bce7622",
  "engineExecution": "dcb1004751b96f078a103b937d8ebe731105f4a95507f0261342a3940435f51d",
  "finiteNotifications": "bfae0275239b3d6cc98ad9b9e7b2be15f5808af2504db60d3f5e13e011a819ec",
  "boundary": "66b718761ec282646b8e1c4e7c7506ad32f285c7dfc714c4af0cef8da4047629",
  "hostInstaller": "5197f8df3b7c273fb70430bd2de1bf6c3fae352a4d7c476f27d26a944991f40e",
  "asyncHost": "5374301e39469b1759187b636f47045b383e5471270391c688400d949fbb4d2a",
  "logJournal": "332a7d543327192e419a8ae8d15b2594cff418de266133a3f7fcb96514d78c1f",
  "nativeProvider": "81ef905a37908face8798be6868d0d7ff93b7a08deacf2d62c9a223eaa6a144a",
  "simulatorWeb": "99815135af22c7c208a385cdc64bfb7f765a50f0afd47db4b67063c25b206a05",
  "snapshots": "9f42b04de5564eecad51b3396af3087a8c34f91c29415ad8a0c05cf0d6d6d4fb",
  "webHost": "1dcbf654da6cc5e77ac0f7003761bc39045b8e7058e664adf281270e0978a49f",
  "coreManifest": "7d1ea5920ce8f189074e99405f4325843831412aee5e0239c9a15efe62d7511a",
  "workspaceManifest": "b4b42531ff0258486c26f055c2d614f8431e686c13b430928d814c0c2484194b",
  "workspaceLock": "010461656092c5f08cf8622efe1760837ef239067d66310fb7f31aa4890e5834",
  "environment": "c67ea05a80cd516662fb841c56e82ed88c1f9e65ab130b7f415e3a0b87ef29d7",
  "moduleOwner": "bfbd9c03906c7cb7355b5f6bc2ee90a65f4379a2d8f984f5f55fd43473152960",
  "performanceLifetime": "0d1535cb4d1ba22eb488828cac290b3a8610604cb1490263b8329d97870bd577",
  "engineBatch": "cbe83a3ec34f118994d568a05014ace743dcb1359610a69868f121435d5eec45",
  "lifecycleNotifications": "30f624b3231f8513b24fe66e04654a364faa18c5a51f57953a5beedb02d7d89f",
  "bufferURLs": "ba48c4775debafcc5bdb2ad275882a08c6cfd6725a275bc6712f62bcd114cb3e",
  "bufferURLStore": "6669205abc4afd633c1f784c0d7c05aad9fbbbcec80840d55091bc0cd3c0fce5",
  "bufferURLProjection": "690d885a67a7f969c2744b179ac85b4e77c8624cfb2721a41313697a5b517c7e",
  "imageResources": "f859ccee08d6fec8b1c01816e5b2d4da02f8e4c17f6aae8c4b0ecfe7eec02ded",
  "workerDOM": "adbae704cafb1442551708d4fca56f63c6afb47ec235a9006e72e4313ca5921d",
  "workerRuntime": "2ed207869872ed6f3d224bed8f11657df57adff75e5b4fbd20804fbcb370ae26",
  "commonHost": "7819ab02d61f7472cd05eac8e23ccb1916bb381eba272fef979c19257fcd481f",
  "browserView": "e5f775f3e7e7cabda15ce514bb9d7124b81eaa00fcb6ad2268d4fb26bf1b4a2e",
  "renderer": "b1a8f36c1bb64fbb3052d271c0e802895865dcce1d77ce58abc0b5fa511eca3a"
})
function selectReviewedSources(...ids) {
  return Object.freeze(Object.fromEntries(ids.map(id => {
    assert(sourcePaths[id] && reviewedSourceSha256[id], `Unreviewed source identity: ${id}`)
    return [id, reviewedSourceSha256[id]]
  })))
}

// This source-evidence grant deliberately binds the entire reviewed Rust
// bootstrap file. A partial Rust tokenizer cannot establish string emission or
// name binding. Even benign edits require an explicit new byte-pin review.
const reviewedEnvironmentSha256 = reviewedSourceSha256.environment
// The same boundary covers native scheduler drivers and their parameter, cfg,
// import and caller context. Method-body token identity cannot bind these.
// These hashes identify reviewed source; they do not prove compiled semantics
// or actual host pumps. Any change, including Rust trivia, requires review.
const reviewedSchedulerRustSha256 = selectReviewedSources(
  'quickjs',
  'v8',
  'runtime',
  'runtimeTurnScheduler',
)

// Cleanup evidence additionally binds native owner/registration and route policy
// context. Full files include imports, parameters, cfg and callers. These are
// reviewed source identities, never native execution or platform acceptance.
const reviewedCleanupRustSha256 = selectReviewedSources(
  'runtimeRoutes',
  'hostServices',
)

// These additional complete sources bind terminal native ownership and the
// absence of implicit manifest grants for the two retained listener removals.
// Shared bootstrap/Session/engine/host registry identities above remain required.
const reviewedRetainedRemovalSourceSha256 = selectReviewedSources(
  'runtimeLifecycle',
  'manifestPacker',
)

// Full identities cover the private active-id replacement, cancellation/ACK
// and retained native capture/retirement context. The hub AST and all shared
// bootstrap/engine/Session identities below are required as well. These are
// source-review grants, never native execution or public SDK acceptance.
const reviewedFiniteNotificationSourceSha256 = selectReviewedSources(
  'finiteNotificationResources',
  'runtimeLifecycle',
  'manifestPacker',
  'coreAssembly',
  'quickjsExecution',
  'terminalResources',
  'engineExecution',
)

// Exact reviewed object-owner source bytes include the shared private hub,
// primitive factory/receiver binding, typed native retirement before Promise
// settlement, complete creator cancellation and retained ACK. Shared consumers
// above keep their exact updated identities; no old/new identity alternatives.
const reviewedObjectNotificationSourceSha256 = selectReviewedSources(
  'finiteNotifications',
  'boundary',
  'hostInstaller',
  'quickjs',
  'v8',
  'finiteNotificationResources',
  'hostServices',
  'asyncHost',
)

// Full source identities bind the dedicated journal and both real diagnostic consumers.
const reviewedLogManagerRustSha256 = selectReviewedSources(
  'logJournal',
  'nativeProvider',
  'simulatorWeb',
  'asyncHost',
  'snapshots',
  'runtimeLifecycle',
  'coreAssembly',
  'quickjsExecution',
  'terminalResources',
  'engineExecution',
  'webHost',
  'coreManifest',
  'workspaceManifest',
  'workspaceLock',
  'manifestPacker',
)

const reviewedPerformanceSourceSha256 = selectReviewedSources(
  'environment',
  'coreAssembly',
  'moduleOwner',
  'performanceLifetime',
  'engineBatch',
  'hostInstaller',
  'lifecycleNotifications',
  'runtimeLifecycle',
  'asyncHost',
  'runtime',
  'quickjs',
  'v8',
)
const reviewedBufferURLSourceSha256 = selectReviewedSources(
  'bufferURLs',
  'bufferURLStore',
  'bufferURLProjection',
  'imageResources',
  'workerDOM',
  'workerRuntime',
  'coreManifest',
  'commonHost',
  'environment',
  'quickjs',
  'v8',
  'runtime',
  'runtimeLifecycle',
  'asyncHost',
  'hostServices',
  'browserView',
  'webHost',
  'renderer',
  'boundary',
  'hostInstaller',
  'lifecycleNotifications',
  'coreAssembly',
  'quickjsExecution',
  'terminalResources',
  'engineExecution',
  'workspaceLock',
)

// This inventory lists actual implementation/bridge regions. Catalog owner is
// only the security boundary and is never sufficient implementation evidence.
// SandboxProvider is deliberately excluded from every source role.
export async function inventoryCoreApis(catalog, read) {
  const entries = await Promise.all(Object.entries(sourcePaths).map(async ([id, path]) => {
    const text = await read(path)
    return [id, { path, sha256: sha256(text), text }]
  }))
  const units = Object.fromEntries(entries), apis = new Map(), nativeFileApis = new Map(), tabBarApis = new Map(), known = new Set(catalog.apis.map(api => api.name))
  const add = (name, role, ids, scope, missing = []) => {
    if (!known.has(name)) return
    const existing = apis.get(name) ?? { sources: [], scopes: [], missing: [] }
    for (const id of ids) if (!existing.sources.some(source => source.id === id && source.role === role)) existing.sources.push({ id, role })
    if (scope && !existing.scopes.includes(scope)) existing.scopes.push(scope)
    existing.missing.push(...missing.filter(value => !existing.missing.includes(value)))
    apis.set(name, existing)
  }
  for (const api of catalog.apis) if (api.owner === 'runtime') add(api.name, 'protectedBoundary', ['boundary'], null)

  // The shared environment installs these console methods before modules run;
  // the opt-in diagnostics queue reaches the native batch drain in both engines.
  // Catalog receiver names alone do not establish this executable chain.
  assert(units.environment.text.includes('include_str!("dev-console.js")'), 'Shared console environment installation changed')
  for (const id of ['quickjs', 'v8']) {
    assert(units[id].text.includes('container_core::app_service_environment_bootstrap(MINI_PROGRAM_BOOTSTRAP)') && units[id].text.includes('batch.console = __dev_console();'), `Shared console engine transport changed: ${id}`)
  }
  const consoleLevels = quoted(between(units.console.text.replaceAll("'", '"'), 'for (const level of [', 'globalThis.console = console;'))
  for (const method of ['debug', 'error', 'info', 'log', 'warn', 'group', 'groupEnd']) {
    assert(consoleLevels.includes(method), `Shared console method missing: ${method}`)
    const grouping = method === 'group' || method === 'groupEnd'
    assert(units.console.text.includes(grouping ? `data(console, '${method}', function(` : 'data(console, level, function(...args) { emit(level, args); });'), `Shared console dispatch changed: ${method}`)
    add(`object:Console.${method}`, 'runtimeImplementation', ['console', 'environment', 'quickjs', 'v8'], grouping
      ? 'Opt-in shared console diagnostic groups: groupDepth and indentation survive bounded native drains, groupEnd reduces depth, disabling diagnostics clears state; depth/queue overflow records dropped messages. This is console, not LogManager'
      : 'Bootstrap-owned synchronous console entry with opt-in, bounded, accessor-safe native diagnostic drain; disabled diagnostics discard logs')
  }

  const logManagerReviewed = javascriptShape(javascriptProgram(units.logManager.text)) === reviewedJavaScriptShapes.logManager
    && units.environment.sha256 === reviewedEnvironmentSha256
    && ['quickjs', 'v8', 'runtime'].every(id => units[id].sha256 === reviewedSchedulerRustSha256[id])
    && units.hostServices.sha256 === reviewedCleanupRustSha256.hostServices
    && javascriptShape(javascriptProgram(units.hostInstaller.text)) === reviewedJavaScriptShapes.installer
    && javascriptShape(javascriptProgram(units.lifecycleNotifications.text)) === reviewedJavaScriptShapes.lifecycle
    && javascriptShape(javascriptProgram(units.boundary.text)) === reviewedJavaScriptShapes.cleanupBoundary
    && Object.entries(reviewedLogManagerRustSha256).every(([id, hash]) => units[id].sha256 === hash)
  if (logManagerReviewed) {
    // Dedicated journal and actual native/Web consumers; never console's opt-in
    // 16-argument / 2048-character formatter. Fixed-reference projection, byte
    // accounting, persistence and upload parity remain explicitly unproven.
    assert(units.environment.text.includes('include_str!("log-manager.js")')
      && containsAll(units.logManager.text, ["const writer = globalThis.__container_host_log_manager_write;", "delete globalThis.__container_host_log_manager_write;", "const limit = 102400;", "function project(args)", "define(wx, 'getLogManager'", "install(__container_capabilities);"])
      && containsAll(units.logJournal.text, ['pub struct LogManagerJournal', 'MAX_DRAIN_BYTES: usize = 256 * 1024', 'std::panic::catch_unwind', 'state.records.front()', 'pub fn retire(&self)'])
      && containsAll(units.runtime.text, ['self.log_manager.take()', '"source": "logManager"', 'fn log_manager_capability('])
      && units.nativeProvider.text.includes('fn console_events(batch: &BridgeBatch)')
      && units.simulatorWeb.text.includes('const MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;'), 'Dedicated native LogManager chain changed')
    for (const id of ['quickjs', 'v8']) assert(containsAll(units[id].text, ['__container_host_log_manager_write', 'take_log_manager_records', '__container_log_manager.trace("lifecycle", "App."', '__container_log_manager.trace("lifecycle", "Page."']), `Dedicated LogManager engine producer changed: ${id}`)
    for (const name of ['wx.getLogManager', 'object:LogManager.debug', 'object:LogManager.info', 'object:LogManager.log', 'object:LogManager.warn']) {
      add(name, 'runtimeImplementation', ['logManager', 'environment', 'hostInstaller', 'lifecycleNotifications', 'boundary', 'quickjs', 'v8', 'runtime', 'hostServices', ...Object.keys(reviewedLogManagerRustSha256)], 'Dedicated Session-owned native journal captures explicit arbitrary-argument graphs and default App/Page/wx producers; level 1 excludes automatic records. Native/Web diagnostic wire carries full records with a 256KiB/128-entry drain, bounded 5MiB volatile retention and exact-once retained tails. Projection, projected UTF8 100KiB accounting, repeated-factory policy, persistence/upload and Web/native retention parity are container policy, not established complete WeChat parity', ['fixedLogManagerProjectionBudgetPersistenceUploadParity'])
    }

  }

  // ManagedSyncFileSystem is linked and bound by the native SDK, not by the
  // browser/Worker host. Keep a host-specific inventory rather than letting a
  // std::fs implementation promote Web's missing synchronous persistence.
  const fileMembers = quoted(between(units.syncFiles.text, 'const MEMBERS:', 'static NEXT_WRITE:'))
  const descriptorMembers = quoted(between(units.syncDescriptors.text, 'const MEMBERS:', 'const MAX_DESCRIPTORS:'))
  const fileDispatch = units.syncFiles.text.slice(units.syncFiles.text.indexOf('    fn call('))
  assert(fileMembers.length > 0 && fileDispatch.includes('match member'), 'Synchronous managed file dispatch changed')
  assert(units.syncFiles.text.includes('#[path = "sync_file_descriptors.rs"]') && fileDispatch.includes('descriptors::MEMBERS.contains(&member)') && fileDispatch.includes('return self.descriptor_call(member, &payload);'), 'Synchronous descriptor delegation changed')
  assert(descriptorMembers.length > 0 && descriptorMembers.every(member => fileMembers.includes(member)), 'Synchronous descriptor registration changed')
  assert(units.syncFiles.text.includes('self.provider.retire()') && units.syncFiles.text.includes('impl Drop for SyncBinding') && units.syncFiles.text.includes('self.retired.store(true, Ordering::Release);'), 'Synchronous descriptor retirement changed')
  assert(units.nativeProvider.text.includes('container_runtime::ManagedSyncFileSystem::new(') && units.nativeProvider.text.includes('session.bind_sync_host_api(') && units.nativeProvider.text.includes('container_core::SyncHostApi::supported_apis(&provider)'), 'Native managed synchronous file installation changed')
  assert(units.boundary.text.includes('member.kind === "syncLocal"') && units.boundary.text.includes('__container_host_sync_call(api,'), 'Synchronous native object facade changed')
  for (const member of fileMembers) {
    const name = `object:FileSystemManager.${member}`
    const descriptor = descriptorMembers.includes(member)
    const codec = ['appendFileSync', 'readFileSync', 'writeFileSync', 'writeSync'].includes(member)
    assert(known.has(name) && (descriptor ? units.syncDescriptors.text.includes(`member == "${member}"`) : fileDispatch.includes(`"${member}"`)), `Synchronous managed file implementation missing: ${member}`)
    if (member === 'readSync') assert(units.boundary.text.includes('value.arrayBuffer = readTarget;'), 'Synchronous readSync no longer returns the caller-owned buffer')
    nativeFileApis.set(name, {
      sources: [{ id: 'boundary', role: 'jsFacade' }, { id: 'syncFiles', role: 'runtimeImplementation' }, ...(codec ? [{ id: 'syncCodecs', role: 'runtimeImplementation' }] : []), ...(descriptor ? [{ id: 'syncDescriptors', role: 'runtimeImplementation' }] : []), ...(['statSync', 'fstatSync'].includes(member) ? [{ id: 'syncStats', role: 'runtimeImplementation' }] : []), { id: 'hostServices', role: 'runtimeBridge' }, { id: 'nativeProvider', role: 'runtimeImplementation' }],
      scopes: [descriptor
        ? 'Configured native managed_files_root lease and synchronous std::fs descriptor dispatch; at most 64 owner-local opaque descriptors; close/retirement release handles; readSync mutates and returns the original ArrayBuffer. Budget accounts for current disk bytes and this owner\'s live handles; cross-owner unlinked handles are not a shared hard quota. Encoding and complete locked-parameter scope remain limited'
        : 'Configured native SDK managed_files_root lease → bootstrap synchronous host call → serialized, account-scoped std::fs operation; no async outbox or UI wait. Encoding, quota, recursive-stat and complete locked-parameter scope remain limited'],
      missing: ['fullLockedFileParameterScope'],
    })
    if (codec) nativeFileApis.get(name).scopes.push('Shared private UTF-16 code-unit projection preserves isolated surrogates across JSON; native text codec supports all 11 locked aliases for actual disk and descriptor I/O. UTF-8 replacement, ASCII read masking, hex truncation, Base64 whitespace/URL alphabet and UTF-16LE odd-byte handling follow Node-style encoding semantics; this closes encoding transport only. Managed-user paths, chunk/JSON/owner quotas, complete remaining locked options and real SDK acceptance remain separate and Partial')
  }
  const stats = between(units.boundary.text, '  function materializeStats(', '  function decodeNative(')
  assert(containsAll(stats, ['hasOwn(value, "__weappFsStats") && value.__weappFsStats === true', 'hasOwn(value, "isDirectory")', 'hasOwn(value, "isFile")', 'const directory = value.isDirectory, file = value.isFile;', 'typeof directory !== "boolean" || typeof file !== "boolean"', 'delete value.__weappFsStats;', 'value.isDirectory = function() { return directory; };', 'value.isFile = function() { return file; };']), 'Managed Stats snapshot materialization changed')
  assert(containsAll(stats, ['if (!nativeIsArray(value)) return materializeStats(value);', 'hasOwn(entry, "stats")) entry.stats = materializeStats(entry.stats);']), 'Managed recursive FileStats materialization changed')
  const genericDecoder = between(units.boundary.text, '  function decodeNative(', '  function nativeSnapshot(')
  assert(!genericDecoder.includes('materializeStats(') && !genericDecoder.includes('materializeStatResult('), 'Generic native data must not materialize Stats markers')
  const statsDecoder = between(units.boundary.text, '  function decodeApiResult(', '  globalThis.__container_resolve_api = function(')
  assert(containsAll(statsDecoder, ['result = decodeNative(result, 0, httpBytes);', 'if (name === "object:FileSystemManager.statSync") return materializeStatResult(result);', 'if (name === "object:FileSystemManager.fstatSync") return materializeStats(result);', 'hasOwn(result, "stats")', 'if (name === "object:FileSystemManager.stat") result.stats = materializeStatResult(result.stats);', 'else if (name === "object:FileSystemManager.fstat") result.stats = materializeStats(result.stats);']) && (statsDecoder.match(/materializeStat(?:s|Result)\(/g) ?? []).length === 4, 'Stats producer-specific decoding changed')
  assert(containsAll(units.boundary.text, ['const value = decodeApiResult(envelope.value, api);', 'return resolveApi(id, null, null, deliveryTicket, decodeApiResult);', 'result = decodeApiResult(result, pending && pending.name);']), 'Stats API-aware sync and retained result decoding changed')
  assert(units.syncFiles.text.includes('#[path = "sync_file_codecs.rs"]')
    && units.syncFiles.text.includes('if let Some(bytes) = codecs::encode(payload)?')
    && units.syncFiles.text.includes('codecs::decode(&payload, &bytes)?')
    && containsAll(units.boundary.text, ['syncFileTextInput(api, payload);', 'if (name === "object:FileSystemManager.readFileSync") return syncFileTextResult(result);'])
    && containsAll(units.syncCodecs.text, ['fn units(data: &Value)', 'String::from_utf16_lossy(&units)', 'Encoding::Utf16 => units.iter().flat_map', '.as_chunks::<2>()', '"__weappSyncText"', '"utf8" | "utf-8"', '"ucs2" | "ucs-2" | "utf16le" | "utf-16le"']), 'Shared synchronous file text projection or encoding dispatch changed')
  assert(containsCode(sourceCode(units.syncCodecs.text, 'rust'), [
    '"utf8" | "utf-8" => Self::Utf8', '"ucs2" | "ucs-2" | "utf16le" | "utf-16le" => Self::Utf16',
    '"ascii" => Self::Ascii', '"binary" | "latin1" => Self::Latin1', '"base64" => Self::Base64', '"hex" => Self::Hex',
  ], 'rust') && containsAll(units.boundary.text, [
    'function encodeNativeWire(value) {', 'return JSON.parse(encodeNativeWire(value));',
    '__container_host_sync_call(api, encodeNativeWire(payload))',
    'const units = nativeSetPrototype([], null);', 'units[index] = nativeCharCodeAt(text, index);',
  ]), 'Shared synchronous file aliases or single-serialization UTF-16 transport changed')
  assert(units.syncFiles.text.includes('#[path = "sync_file_stats.rs"]') && units.syncFiles.text.includes('mod stats;'), 'Shared Stats converter installation changed')
  const statsProducer = units.syncStats.text.slice(0, units.syncStats.text.indexOf('#[cfg(test)]'))
  assert(containsAll(statsProducer, ['struct StatsSnapshot {', 'StatsTimes::read(metadata.accessed(), metadata.modified())?', 'size: metadata.len()', 'metadata.mode()', 'directory: metadata.is_dir()', 'file: metadata.is_file()', '"__weappFsStats": true', '"lastAccessedTime": timestamp_number(self.times.accessed)', '"lastModifiedTime": timestamp_number(self.times.modified)', '"isDirectory": self.directory', '"isFile": self.file', 'StatsSnapshot::read(metadata).map(StatsSnapshot::into_value)']), 'Shared actual-metadata Stats snapshot changed')
  assert(containsAll(statsProducer, ['cannot read Stats.lastAccessedTime: {error}', 'cannot read Stats.lastModifiedTime: {error}', '-i128::from(distance.as_secs()) - i128::from(distance.subsec_nanos() != 0)', 'fn timestamp_number(seconds: i128) -> Number', 'i64::try_from(seconds)', 'u64::try_from(seconds)', 'Number::from_f64(seconds as f64)']), 'Shared Stats signed timestamp or error boundary changed')
  const statSyncProducer = between(units.syncFiles.text, '            "statSync" => {', '            _ => Err("synchronous file method is unavailable".into()),')
  const fstatSyncProducer = between(units.syncDescriptors.text, '        if member == "fstatSync" {', '        if member == "ftruncateSync" {')
  assert(statSyncProducer.includes('let metadata = fs::metadata(path("path", true)?).map_err(|e| e.to_string())?;') && statSyncProducer.includes('stats::from_metadata(metadata)') && /return descriptors\.files\[fd\]\s*\.file\s*\.metadata\(\)\s*\.map_err\(\|e\| e\.to_string\(\)\)\s*\.and_then\(stats::from_metadata\)/.test(fstatSyncProducer), 'Stats predicates require actual path and opened-file metadata')
  for (const member of ['isDirectory', 'isFile', 'lastAccessedTime', 'lastModifiedTime', 'mode', 'size']) nativeFileApis.set(`object:Stats.${member}`, {
    sources: [{ id: 'boundary', role: 'jsFacade' }, { id: 'syncFiles', role: 'runtimeImplementation' }, { id: 'syncDescriptors', role: 'runtimeImplementation' }, { id: 'syncStats', role: 'runtimeImplementation' }, { id: 'nativeProvider', role: 'runtimeImplementation' }],
    scopes: ['Configured native managed statSync/fstatSync returns actual filesystem metadata; API-aware decoding materializes captured synchronous isDirectory/isFile functions only for stat/statSync/fstat/fstatSync, including recursive FileStats[]. Native synchronous producer installation is counted; async-provider availability, complete locked file parameters and Web persistence are not inferred'],
    missing: ['fullLockedFileParameterScope'],
  })
  // Returned Stats implements the locked zero-argument
  // local predicates. Producer availability and producer option restrictions
  // are separate from this receiver contract. Timestamp fields are reviewed below;
  // The remaining returned numeric fields are reviewed independently below.
  for (const member of ['isDirectory', 'isFile']) {
    const name = `object:Stats.${member}`, existing = nativeFileApis.get(name)
    nativeFileApis.set(name, { ...existing, missing: [], scopes: existing.scopes.map(scope => `${scope}; complete locked zero-argument boolean predicate on a returned metadata snapshot; producer APIs and their parameter scopes remain separate`) })
  }


  // The two returned timestamp fields have an independent Number snapshot
  // contract. Both installed producers use the same signed POSIX converter;
  // unrelated file options and the non-Unix fabricated mode remain separate.
  for (const member of ['lastAccessedTime', 'lastModifiedTime']) {
    const name = `object:Stats.${member}`, existing = nativeFileApis.get(name)
    const contract = catalog.apis.find(api => api.name === name)
    assert(contract?.property === true && contract.writable === true && contract.signatures?.length === 1
      && contract.signatures[0].parameters.length === 0 && contract.signatures[0].returns === 'number', `Stats timestamp locked signature changed: ${member}`)
    nativeFileApis.set(name, { ...existing, missing: [], scopes: [...existing.scopes, 'Complete returned writable Number snapshot of signed whole POSIX seconds (st_atime/st_mtime). One actual Metadata snapshot supplies both fields; pre-epoch fractional instants floor toward the preceding second, required timestamp errors fail the producer atomically, and finite Number conversion retains JavaScript precision. Configured native statSync/fstatSync installation is counted; async-producer parameters, Web persistence and per-platform acceptance remain separate'] })
  }

  // Returned size and Unix mode already read the same real Metadata snapshot.
  // Their finite writable Number contract does not inherit producer options.
  assert(containsAll(statsProducer, ['size: u64,', 'mode: u32,', 'size: metadata.len()', '"size": self.size', '"mode": self.mode', '#[cfg(unix)]', 'use std::os::unix::fs::MetadataExt;', 'metadata.mode()', '#[cfg(not(unix))]']), 'Stats returned size and mode snapshot changed')
  for (const member of ['size', 'mode']) {
    const name = `object:Stats.${member}`, existing = nativeFileApis.get(name)
    const contract = catalog.apis.find(api => api.name === name)
    assert(contract?.property === true && contract.writable === true && contract.signatures?.length === 1
      && contract.signatures[0].parameters.length === 0 && contract.signatures[0].returns === 'number', `Stats numeric snapshot locked signature changed: ${member}`)
    nativeFileApis.set(name, { ...existing, missing: [], scopes: [...existing.scopes, member === 'size'
      ? 'Existing returned writable Number snapshot of actual Metadata.len (st_size), including ordinary JavaScript rounding beyond safe integers; no u32 truncation or safe-integer rejection. Real statSync/fstatSync and snapshot isolation are covered on macOS QJS/V8; full u64 evidence is converter/wire only, and real sparse files above 2^53 remain ignored. Configured native installation is counted; producer options, Web and other-platform acceptance remain separate'
      : 'Existing Unix returned writable Number snapshot of all actual MetadataExt.mode bits (st_mode), including file type and permissions. Real chmod, path/open-descriptor identity and snapshot isolation are covered on macOS QJS/V8; Android/iOS/Linux/OHOS execution and public SDK acceptance remain pending. The non-Unix synthetic mode is excluded by host-specific accounting below'] })
  }


  // A dynamic chrome producer counts only with an installed, opted-in consumer.
  // Keep these five APIs host-specific: a shared facade or SDK flag by itself
  // cannot promote built-in Web/Harmony or an unimplemented SDK presenter.
  const tabBar = units.tabBar.text, tabState = units.tabBarState.text
  const systemTabApis = ['wx.setTabBarBadge', 'wx.removeTabBarBadge', 'wx.showTabBarRedDot', 'wx.hideTabBarRedDot', 'wx.setTabBarStyle']
  const registeredTabApis = quoted(between(tabState, 'pub(crate) const APIS:', 'pub(crate) fn is_api('))
  assert(JSON.stringify(registeredTabApis) === JSON.stringify(systemTabApis), 'System TabBar five-operation registration changed')
  assert(units.environment.text.includes('include_str!("tab-bar.js")'), 'Shared TabBar installation changed')
  for (const id of ['quickjs', 'v8']) assert(units[id].text.includes('container_core::app_service_environment_bootstrap(MINI_PROGRAM_BOOTSTRAP)'), `Shared TabBar engine installation changed: ${id}`)
  assert(containsAll(tabBar, ['const define = Object.defineProperty, own = Object.getOwnPropertyDescriptor;', 'const create = Object.create, isArray = Array.isArray;', 'const isInteger = Number.isInteger;', 'const call = __container_api_call, capability = __container_capability;', 'const complete = __container_async_result;', 'const request = create(null);', 'descriptor && own(descriptor, "value")', 'descriptor && !own(descriptor, "value")', 'if (key === "index" ? typeof value !== "number" || !isInteger(value) || value < 0 : typeof value !== "string")', 'data(request, key, value);', 'return call(name, request);']), 'TabBar own primitive snapshot boundary changed')
  assert(containsAll(tabBar, ['for (const key of ["success", "fail", "complete"])', 'if (typeof callback === "function") define(request, key, {__proto__: null, value: callback});', 'return complete(request, null,', 'if (options === undefined && method === "setTabBarStyle") options = create(null);', 'if (capability(name) === "unsupported") return fail("unsupported", "ERR_UNSUPPORTED_CAPABILITY");']), 'TabBar retained callbacks and local settlement changed')
  assert(tabBar.includes('if (method === "showTabBar" || method === "hideTabBar" || method === "setTabBarItem")') && units.runtime.text.includes('if matches!(name, "wx.showTabBar" | "wx.hideTabBar" | "wx.setTabBarItem")'), 'Unfinished TabBar operations must stay unsupported')
  const tabCapability = between(units.runtime.text, '    fn effective_capability(', '\nfn render_bridge_error(')
  const runtimeCode = sourceCode(units.runtime.text, 'rust')
  const ceiling = conditionalCeiling(codeBlock(runtimeCode, 'fn effective_capability_with_provider(', 'rust'))
  assert(containsAll(tabCapability, ['if tab_bar::is_api(name)', 'self.has_custom_tab_bar()', '.is_some_and(|support| *support != CapabilitySupport::Unsupported)', 'min_support(support, ceiling)', '.map_or(manifest, |host| min_support(manifest, host))'])
    && containsCode(codeBlock(runtimeCode, 'fn effective_capability(', 'rust'), ['self.effective_capability_with_provider(name, &provider)'], 'rust')
    && ceiling.parts.length === 2 && equalCode(ceiling.parts[0], sourceCode('tab_bar::is_api(name)', 'rust'))
    && containsCode(ceiling.parts[1], ['matches!(name,'], 'rust')
    && equalCode(ceiling.partial, sourceCode('CapabilitySupport::Partial', 'rust'))
    && equalCode(ceiling.full, sourceCode('CapabilitySupport::Full', 'rust')), 'TabBar explicit presenter admission and Partial ceiling changed')
  assert(containsAll(units.nativeProvider.text, ['#[serde(skip_serializing_if = "system_tab_bar_disabled")]', 'fn system_tab_bar_disabled(value: &bool) -> bool {\n    !value\n}', 'pub system_tab_bar: bool,', 'system_tab_bar: false,', 'capabilities: container_runtime::SYSTEM_TAB_BAR_APIS', 'if self.config.system_tab_bar {\n                                CapabilitySupport::Partial\n                            } else {\n                                CapabilitySupport::Unsupported']), 'SDK trusted TabBar false/true admission changed')
  for (const name of systemTabApis) assert(units.manifestPacker.text.includes(`'${name}': 'partial'`), `Default pack must admit TabBar candidate: ${name}`)
  const presenterRequired = between(units.manifestPacker.text, 'const PRESENTER_REQUIRED_CAPABILITIES = new Set([', ']);')
  assert(systemTabApis.every(name => presenterRequired.includes(`'${name}'`)) && units.manifestPacker.text.includes("PRESENTER_REQUIRED_CAPABILITIES.has(name)\n          ? 'unsupported'"), 'TabBar pack diagnostic matrix must not infer host admission')
  assert(containsAll(units.runtime.text, ['mod tab_bar;', 'pub const SYSTEM_TAB_BAR_APIS: [&str; 5] = tab_bar::APIS;', 'tab_bar_state: tab_bar::TabBarState,', 'tab_bar_state: tab_bar::TabBarState::default(),', 'let result = self.tab_bar_api_result(\n                name,\n                payload,\n                request.deadline_ns,\n                request.cancel_token.as_deref(),', 'let result = self.tab_bar_api_result(name, &options, deadline, cancel);', 'return self.resolve_engine_api(id, name, result);']), 'TabBar session state and both API dispatch chains changed')
  const tabApply = between(tabState, '    fn apply(', '\nfn optional_color(')
  assert(containsAll(tabApply, ['if chrome.custom || chrome.list.is_empty()', 'let color = optional_color(payload, "color")?;', 'let selected_color = optional_color(payload, "selectedColor")?;', 'let background_color = optional_color(payload, "backgroundColor")?;', 'value == "black" || value == "white"', 'self.color = Some(value);', '.and_then(Value::as_u64)', '.and_then(|index| usize::try_from(index).ok())', '.filter(|index| *index < chrome.list.len())', '.and_then(Value::as_str)', "if text.contains('\\0')", 'text.encode_utf16().count() > 4', 'Indicator::Badge(display.to_owned())', 'self.indicators.insert(index, Indicator::Dot);', 'Some(Indicator::Badge(_))', 'Some(Indicator::Dot)']) && tabApply.indexOf('let border_style =') < tabApply.indexOf('self.color = Some(value);'), 'TabBar validated atomic indicator/style transaction changed')
  assert(containsAll(tabState, ['(value.len() == 4 || value.len() == 7)', "value.starts_with('#')", 'byte.is_ascii_hexdigit()', 'full.push(byte);']), 'TabBar normalized color validation changed')
  const tabRequest = tabState.slice(tabState.indexOf('    pub(super) fn tab_bar_api_result('))
  const tabGuards = ['self.app_service.lifecycle().state() == container_core::LifecycleState::Destroyed', 'self.effective_capability(name) == CapabilitySupport::Unsupported', 'deadline.is_some_and(crate::deadline_expired)', 'cancel.is_some_and(|token| self.is_cancelled(token))', 'crate::chrome::resolve_page_chrome(', 'self.tab_bar_state.apply(name, payload, &chrome.tab_bar)?;']
  assert(containsAll(tabRequest, tabGuards) && tabGuards.every((value, index) => index === 0 || tabRequest.indexOf(tabGuards[index - 1]) < tabRequest.indexOf(value)), 'TabBar lifecycle/admission/deadline/cancellation ordering changed')
  assert(containsAll(tabState, ['item.badge_text = Some(text.clone())', 'item.red_dot = true', 'chrome.color.clone_from(value)', 'chrome.selected_color.clone_from(value)', 'chrome.background_color.clone_from(value)', 'chrome.border_style.clone_from(value)']) && containsAll(units.chrome.text, ['pub badge_text: Option<String>', 'pub red_dot: bool', 'self.tab_bar_state.project(&mut chrome.tab_bar);', '.and_then(|catalog| catalog.app.get("tabBar"))', '.and_then(|tab_bar| tab_bar.get("custom"))']) && units.runtimeLifecycle.text.includes('self.tab_bar_state = crate::tab_bar::TabBarState::default();'), 'TabBar actual chrome projection and terminal retirement changed')
  assert(containsAll(units.nativeProvider.text, ['.map(|active| active.session.page_chrome())', 'if observed != self.observed_chrome {', '.ok_or_else(|| SdkError::invalid("chrome revision exhausted"))?', 'json!({"type":"chrome","chrome":self.chrome_state()?,"generation":self.generation})']) && containsAll(units.playerModel.text, ['systemTabBar: true,', "if (event.type == 'chrome')", "'chrome': Map<String, Object?>.from(value)", 'if (accepted is Map && _olderChrome(value, accepted)) return;']), 'TabBar independent metadata revision and Player delivery changed')
  assert(containsAll(units.flutterController.text, ['bool systemTabBar = false', "if (systemTabBar) 'systemTabBar': true,", "_invoke<void>('nativeChrome', chrome);"]), 'Flutter trusted TabBar opt-in and native forwarding changed')
  assert(containsAll(units.flutterAndroid.text, ['val systemTabBar = args["systemTabBar"]?.let', '"systemTabBar must be a boolean"', 'systemTabBar = systemTabBar)']) && containsAll(units.androidSession.text, ['systemTabBar: Boolean = false', 'systemTabBarEnabled = systemTabBar', 'if (systemTabBarEnabled) config.put("systemTabBar", true)']), 'Android Flutter-to-native TabBar configuration changed')
  assert(containsAll(units.flutterIos.text, ['if let value = args["systemTabBar"]', 'configuration.systemTabBar = enabled']) && units.iosTypes.text.includes('public var systemTabBar: Bool = false') && units.iosSession.text.includes('if configuration.systemTabBar { config["systemTabBar"] = .bool(true) }'), 'iOS Flutter-to-native TabBar configuration changed')
  assert(containsAll(units.desktopRegistry.text, ['if (args.contains("systemTabBar"))', 'if (!args["systemTabBar"].is_boolean())', 'if (args["systemTabBar"].get<bool>()) e->config["systemTabBar"] = true;', 'if (method == "nativeChrome")', 'e->texture->set_chrome(payload, std::move(action))']) && units.flutterMacos.text.includes('_registry->invoke('), 'Desktop/macOS Flutter TabBar configuration and consumer dispatch changed')
  const flutterTabs = between(units.playerChrome.text, '  Widget _tabs()', '\n  @override')
  assert(containsAll(flutterTabs, ["widget.chrome.tabBar['backgroundColor']", "widget.chrome.tabBar['borderStyle'] == 'white'", "? 'selectedColor'", ": 'color'", "widget.chrome.tabs[i]['badgeText']", "ValueKey('mini-program-tab-badge-$i')", "widget.chrome.tabs[i]['redDot'] == true", "ValueKey('mini-program-tab-dot-$i')"]) && units.playerMain.text.includes('nativeOverlay: Platform.isWindows || Platform.isLinux,'), 'Player actual Flutter TabBar painter changed')
  assert(containsAll(units.playerChrome.text, ["final metadata = widget.icons.enrich(widget.chrome.snapshot);", "!_equal(_native!['chrome'], metadata)", "'chrome': metadata,"]) && containsAll(units.flutterView.text, ['? jsonEncode(widget.nativeChrome)', 'final nativeChanged = nativeSignature != _nativeChromeSignature;', 'if (!geometryChanged && !nativeChanged && !occlusionChanged) return;', '_controller.updateNativeChrome(snapshot)']), 'TabBar same-geometry native metadata propagation changed')
  assert(containsAll(units.nativePreview.text, ['chrome_(create_native_chrome_overlay(parent_.get()))', 'auto status = chrome_->update(value, std::move(action));']) && units.flutterWindows.text.includes('std::make_shared<NativePreviewTexture>') && units.flutterLinux.text.includes('std::make_shared<NativePreviewTexture>'), 'TabBar installed Windows/Gtk overlay path changed')
  assert(containsAll(units.nativeChrome.text, ['result.badge = item["badgeText"].get<std::string>();', 'result.dot = item["redDot"].get<bool>();', 'bool visible() const { return dot || !badge.empty(); }', 'return bar.value("borderStyle", "black") == "white" ? 0xffffff : 0x000000;']), 'Native TabBar actual indicator and border projection changed')
  const winTabs = between(units.nativeChrome.text, '  void draw_button(', '  void buttons(')
  assert(containsAll(winTabs, ['chrome_detail::color(colors, "backgroundColor", 0xffffff)', '? "selectedColor"', ': "color"', 'const auto indicator = chrome_detail::tab_indicator(tab);', 'RoundRect(item.hDC, badge.left', 'DrawTextW(item.hDC, label.c_str()', 'chrome_detail::tab_border(colors)']), 'Windows actual TabBar badge/dot/style painting changed')
  const gtkTabs = between(units.nativeChrome.text, '      const auto &bar = chrome.at("tabBar");\n      if (value.contains(', '      gtk_widget_show_all(fixed_);')
  assert(containsAll(gtkTabs, ['bar.value("backgroundColor", "#ffffff")', 'chrome_detail::tab_border(bar)', 'const auto indicator = chrome_detail::tab_indicator(item);', 'gtk_label_new(indicator.dot ? "" : indicator.badge.c_str())', 'gtk_overlay_add_overlay(GTK_OVERLAY(overlay), badge)', 'bar.value(selected ? "selectedColor" : "color", "#333333")']) && containsAll(units.nativeChrome.text, ['std::make_shared<WindowsChromeOverlay>(parent)', 'std::make_shared<GtkChromeOverlay>(parent)']), 'Gtk actual TabBar badge/dot/style painting changed')
  const tabSharedIds = ['tabBarState', 'chrome', 'runtime', 'runtimeLifecycle', 'nativeProvider', 'manifestPacker']
  const tabFlutterIds = ['flutterController', 'playerModel', 'playerChrome', 'playerMain']
  for (const name of systemTabApis) tabBarApis.set(name, {
    sources: [
      { id: 'boundary', role: 'protectedBoundary' },
      ...['tabBar', 'environment', 'quickjs', 'v8'].map(id => ({ id, role: 'jsFacade' })),
      ...tabSharedIds.map(id => ({ id, role: 'runtimeImplementation' })),
    ],
    scopes: ['Opted-in system tabBar only: own primitive JS snapshots and retained callbacks reach a session-owned atomic badge/dot/style transaction in both engines, with pre-mutation lifecycle/admission/deadline/cancellation guards and terminal reset. A verified app catalog supplies indices even from non-tab pages. SDK defaults false/omitted; default pack admits Partial, explicit manifest lowering and custom-tabBar rejection remain effective. Metadata revisions publish actual changed chrome without requiring a new content frame. No full fixed-version callback/Promisify, Unicode/indicator interaction, visual/error or accessibility parity is established'],
    missing: ['fullLockedTabBarContract', 'allPublicSdkPresenterChains', 'platformTabBarExecutionAndPixels'],
  })
  const tabHostSources = {
    android: [...tabFlutterIds, 'flutterAndroid', 'androidSession'],
    ios: [...tabFlutterIds, 'flutterIos', 'iosTypes', 'iosSession'],
    macos: [...tabFlutterIds, 'flutterMacos', 'desktopRegistry'],
    windows: [...tabFlutterIds, 'flutterView', 'desktopRegistry', 'nativePreview', 'nativeChrome', 'flutterWindows'],
    linux: [...tabFlutterIds, 'flutterView', 'desktopRegistry', 'nativePreview', 'nativeChrome', 'flutterLinux'],
  }
  const tabBarForHost = (host, name) => {
    const entry = tabBarApis.get(name), ids = tabHostSources[host]
    if (!entry || !ids) return null
    return { ...entry, sources: [...entry.sources, ...ids.map(id => ({ id, role: 'runtimeImplementation' }))], scopes: [...entry.scopes, ['windows', 'linux'].includes(host)
      ? 'Concrete dev Player Flutter configuration → native desktop registry → NativePreviewTexture → Windows/Gtk OS tab painter; same-geometry metadata is forwarded. Source and portable-helper/widget evidence only: Windows/Gtk platform painting branches were not built/run; Linux is the installed X11/Gtk path, with Wayland admission limits. Standalone native SDK presenter and OS pixels remain unproven'
      : 'Concrete dev Player Flutter system tab painter and trusted SDK config forwarding; Android/iOS/macOS Flutter consumer is the counted chain. Standalone Android/iOS/macOS native and mobile React Native presenter chains remain unimplemented or unproven; Android native build, standalone iOS link and device/platform pixels remain unproven'] }
  }

  // The public object methods operate on a real monotonic, owner-local
  // timeline. Only script evaluation and the first completed appLaunch are
  // instrumented, and their locked entry fields are incomplete. The finite
  // zero-argument cleanup contract is reviewed separately from metric output.
  assert(units.environment.text.includes('include_str!("performance.js")'), 'Performance bootstrap installation changed')
  for (const id of ['quickjs', 'v8']) assert(units[id].text.includes('__container_host_performance_now') && units[id].text.includes('performance_origin') && units[id].text.includes('"wx.getPerformance": "partial"'), `Native performance clock changed: ${id}`)
  const performance = units.performance.text
  assert(containsAll(performance, ['const __container_performance = (function()',
    'delete globalThis.__container_host_performance_now;', 'delete globalThis.__container_host_performance_active;',
    'function measureScript(moduleId, evaluate)', 'function invokeTrustedApp(name, args)',
    'entry.name = "evaluateScript"', 'entry.name = "appLaunch"']), 'Performance measurement dispatch changed')
  // Follow actual Session MODULE_LOAD, not the guest compatibility evaluator.
  // Full source identities below bind caller context, retained native handles,
  // own-member policy and terminal fences; anchors only diagnose a broken edge.
  assert(containsAll(units.runtime.text, [
    'self.run_engine_task(EngineTask::EvaluateModule(id), BridgeErrorCode::ModuleLoad)',
    'self.run_engine_task(EngineTask::Call { target, args }, default_code)',
    'self.ensure_engine_environment_current()?;', 'engine.evaluate_module_with_id(id).map(|()| Vec::new())',
    'complete_engine_task(result, checkpoint)', 'performance_lifetime: Arc<container_core::PerformanceLifetime>',
  ]), 'Performance actual Session module ingress changed')
  for (const id of ['quickjs', 'v8']) assert(containsAll(units[id].text, [
    'pub fn evaluate_module_with_id(', '"kind":"module-command", "operation":"evaluate", "id":manifest_id,',
    'pub fn performance_lifetime(', 'PerformanceLifetime::default()',
  ]), `Performance retained module adapter changed: ${id}`)
  assert(containsAll(units.moduleOwner.text, ['const __container_module_owner = (() => {',
    'if (record.trusted) measured(record.id, run); else run();',
    'register(id, number, owned, format, compile("require", "module", "exports", source), true);',
    'if (operation === "evaluate")', 'evaluate(records[id]);',
  ]) && containsAll(units.hostInstaller.text, [
    'if (kind === "module-command") return __container_module_owner.command(snapshot);',
    '__container_performance.install(capabilities);',
  ]) && containsAll(units.engineBatch.text, ['const invokeApp = __container_performance.invokeApp;',
    'const moduleExports = __container_module_owner.exports;'])
    && containsAll(units.performanceLifetime.text, ['self.active.load(Ordering::Acquire)', 'self.active.store(false, Ordering::Release);'])
    && units.runtimeLifecycle.text.includes('self.performance_lifetime.retire();')
    && units.asyncHost.text.includes('self.performance_lifetime.retire();'), 'Performance private owner and lifetime chain changed')
  const performanceObject = between(performance, 'const performance = {', 'wx.getPerformance = function(')
  const observerObject = between(performance, 'const observer = {', 'return observer;')
  const entryListObject = between(performance, 'function entryList(', 'function matches(')
  const performanceDisconnectContract = catalog.apis.find(api => api.name === 'object:PerformanceObserver.disconnect')
  assert(catalog.baseline?.baseLibrary === '3.17.3' && catalog.baseline.typings?.name === 'miniprogram-api-typings'
    && catalog.baseline.typings.version === '5.2.3'
    && catalog.baseline.typings.sources?.some(source => source.path === 'types/wx/lib.wx.api.d.ts'
      && source.sha256 === '25e9e6fdab1b4282ee5231d8f8de7a31a177d2edc690ec834e0da479cc166245')
    && performanceDisconnectContract?.receiver === 'PerformanceObserver'
    && performanceDisconnectContract.baseline === 'included' && performanceDisconnectContract.property === undefined
    && javascriptShape(performanceDisconnectContract.signatures) === javascriptShape([{ parameters: [], returns: 'void' }]),
  'Performance disconnect locked signature changed')
  // Review the complete lexical closure, including removeObserver, detached
  // deliveries, generation fences, captured intrinsics and callback isolation.
  // Bind the actual shared installer and both native bootstrap files too. The
  // pins are source identity only, not native-engine or host acceptance.
  const performanceDisconnectReviewed = javascriptShape(javascriptProgram(performance)) === reviewedJavaScriptShapes.performanceDisconnect
    && units.environment.sha256 === reviewedEnvironmentSha256
    && Object.entries(reviewedPerformanceSourceSha256).every(([id, digest]) => units[id].sha256 === digest)
  const performanceSourceIds = ['performance', ...Object.keys(reviewedPerformanceSourceSha256)]
  add('wx.getPerformance', 'runtimeImplementation', performanceSourceIds, 'Synchronous owner-local native-clock timeline; actual Session MODULE_LOAD and retained module commands use the private registered loader; trusted first successful onLaunch uses the retained native App dispatcher. Public compatibility aliases have no sampling authority; own factory/member policy and native terminal lifetime are independently fenced. Only successful registered script evaluation and first completed launch are instrumented; complete producers and fixed metadata/timing remain unproven', ['completePerformanceInstrumentation'])
  for (const [receiver, block, methods] of [
    ['Performance', performanceObject, ['getEntries', 'getEntriesByName', 'getEntriesByType', 'setBufferSize', 'createObserver']],
    ['PerformanceObserver', observerObject, ['observe', 'disconnect', 'supportedEntryTypes']],
    ['EntryList', entryListObject, ['getEntries', 'getEntriesByName', 'getEntriesByType']],
  ]) {
    for (const member of methods) {
      assert(block.includes(`${member}: function(`) || member === 'createObserver' && block.includes('createObserver: createObserver') || member === 'supportedEntryTypes' && block.includes('"supportedEntryTypes"'), `Performance member implementation changed: ${receiver}.${member}`)
      const disconnect = receiver === 'PerformanceObserver' && member === 'disconnect'
      add(`object:${receiver}.${member}`, 'runtimeImplementation', performanceSourceIds, disconnect
        ? 'Synchronous void cleanup of the captured private observer: remove subscription, clear pending entries and invalidate detached batches by generation. Repeated cleanup, reobservation and cleanup after capability revocation are supported; public receiver mutation cannot redirect authority. Native lifetime retirement and retained private App/module ingress share this owner. Recovered source accounting only; native engines and platform acceptance remain separate'
        : 'Real bounded timeline/filtering/observer object backed by native-clock samples. Supported observation is script and navigation/appLaunch only; route, render, resource and loadPackage metrics are not implemented. Private real-loader/retained-App provenance, independent own factory/member policy, copied snapshots and native terminal fencing do not establish complete WeChat moduleName/pageId, appLaunch timing, buffer or snapshot parity',
      disconnect ? performanceDisconnectReviewed ? [] : ['reviewedPerformanceDisconnectSource'] : ['completePerformanceInstrumentation'])
    }
  }

  // Navigation creates a channel in the originating realm, then the runtime
  // binds its actual destination page before onLoad through a function handle
  // captured by each engine before guest code. A receiver name or public
  // compatibility binder is insufficient source evidence.
  assert(units.environment.text.includes('include_str!("event-channel.js")') && units.environment.text.includes('bindEventChannel: __container_event_channels.bind'), 'EventChannel bootstrap installation changed')
  for (const id of ['quickjs', 'v8']) {
    const engine = units[id].text
    assert(engine.includes('__container_event_channels.start(requestId, callback)') && engine.includes('__container_event_channels.settle(id, failed,') && engine.includes('__container_event_channels.install(page)') && engine.includes('__container_event_channels.retire(page)'), `EventChannel engine lifecycle changed: ${id}`)
    assert(engine.includes('event_channel_binding') && engine.includes('pub fn bind_event_channel(') && engine.includes('"bindEventChannel"'), `EventChannel private native binding changed: ${id}`)
  }
  assert(units.runtime.text.includes('self.bind_navigation_event_channel(engine_request_id, id)?;') && units.runtime.text.includes('.bind_event_channel(request_id, page_id.0)') && units.navigation.text.includes('NavigationCompletion::Engine { id, .. } => Some(*id)') && units.navigation.text.replace(/\s+/g, '').includes('session.navigation_result_prepared(&pending.queued.request,&pending.queued.name,engine_request_id,prepared)') && units.runtime.text.includes('session.navigation_result_in_route(request, name, payload, engine_request_id)'), 'EventChannel immediate/deferred navigation dispatch changed')
  for (const method of ['emit', 'on', 'once', 'off']) {
    assert(units.eventChannel.text.includes(`channel.${method} = function(`), `EventChannel method implementation changed: ${method}`)
    add(`object:EventChannel.${method}`, 'runtimeImplementation', ['eventChannel', 'environment', 'quickjs', 'v8', 'runtime', 'runtimeRoutes', 'navigation'], 'Owner-local navigateTo events and success.eventChannel/getOpenerEventChannel share the destination bound before onLoad. Cached events, synchronous listeners/once/off, callback isolation and unload retirement are implemented; 256 channels, 128 listeners, 64 cached events and 32 emit arguments are bounded with explicit resource-limit errors. No opener returns an empty object')
  }
  const runtime = units.runtime.text
  const storage = quoted(between(runtime, 'fn is_storage_api(', 'fn is_observer_api('))
  // Plain transactions are concrete. Keep the fixed AES contract and the
  // explicit Unicode/depth/accounting limits visible instead of inferring full
  // parameter coverage from dispatch or quota constants alone.
  assert(units.environment.text.includes('include_str!("storage.js")'), 'Shared storage bootstrap installation changed')
  assert(units.workspaceManifest.text.includes('serde_json = { version = "1", features = ["float_roundtrip"] }'), 'Storage JSON Number preservation changed')
  assert(units.storageTransactions.text.includes('fn commit_engine_storage(') && units.storageTransactions.text.includes('.apply_storage_transaction(operations)') && units.storageTransactions.text.includes('self.storage_transactions.committed = sequence;'), 'Storage core commit ownership changed')
  for (const id of ['quickjs', 'v8']) assert(units[id].text.includes('pub fn enable_deferred_storage_commit(') && units[id].text.includes('pub fn acknowledge_storage_transactions(') && units[id].text.includes('pub fn pending_storage_transactions('), `Private storage native handoff changed: ${id}`)
  assert(units.environment.text.includes('"storage-pending"') && units.storageTransactions.text.includes('fn reconcile_engine_storage(') && units.storageTransactions.text.includes('.pending_storage_transactions()') && runtime.includes('self.reconcile_engine_storage()?;'), 'Storage-only reconciliation changed')
  const plainStorageGaps = ['storageJsonStringParity', 'storageBoundedValueScope', 'storagePlainAccountingParity']
  const storageGaps = {
    'wx.setStorage': ['storageEncryptionAndPairedFlags', 'storageEncryptedQuotas', ...plainStorageGaps],
    'wx.getStorage': ['storageDecryptionAndPairedFlags'],
    'wx.setStorageSync': plainStorageGaps,
    'wx.batchSetStorage': plainStorageGaps,
    'wx.batchSetStorageSync': plainStorageGaps,
  }
  for (const name of storage) add(name, 'runtimeImplementation', ['runtime', 'storage', 'storageCore', 'storageTransactions', 'environment', 'workspaceManifest', 'quickjs', 'v8'], 'Shared private-ledger plain storage with single-publication transactions, UTF8 logical quotas and native core-commit ACK. JSON float_roundtrip preserves normalized JavaScript Number bits; key admission matches the existing native Unicode White_Space policy. Storage-only reconciliation settles accepted guest intent before later host writes or baseline replacement even if public event conversion fails. Async encrypt:true is explicitly rejected; lone-surrogate strings and bounded new-value depth/batch sizes limit JSON parameter scope; accounting is a documented container policy rather than measured WeChat byte parity. SDK persistence/namespace and Web KV durability acceptance remain separate', storageGaps[name] ?? [])
  for (const name of quoted(between(runtime, 'fn is_navigation_api(', 'fn is_provider_api('))) add(name, 'runtimeImplementation', ['runtime', ...(['wx.navigateTo', 'wx.redirectTo', 'wx.navigateBack', 'wx.reLaunch', 'wx.switchTab'].includes(name) ? ['runtimeRoutes'] : []), 'navigation', 'quickjs', 'v8'], 'Core navigation stack and owned layout transaction; embedded surface presentation requires SDK acceptance')
  // Fixed create/revoke signatures are assessed separately from media APIs.
  for (const name of ['wx.createBufferURL', 'wx.revokeBufferURL']) {
    const api = catalog.apis.find(api => api.name === name), create = name === 'wx.createBufferURL'
    const signature = api?.signatures?.[0], parameter = signature?.parameters?.[0]
    assert(api?.owner === 'runtime' && api.kind === 'syncLocal' && api.baseline === 'included' && api.since === '2.14.0'
      && api.signatures.length === 1 && signature.parameters.length === 1 && parameter.optional === false
      && parameter.name === (create ? 'buffer' : 'url') && signature.returns === (create ? 'string' : 'void')
      && parameter.type.replace(/\s/g, '').replace(/^\|/, '') === (create
        ? 'ArrayBuffer|Int8Array|Uint8Array|Uint8ClampedArray|Int16Array|Uint16Array|Int32Array|Uint32Array|Float32Array|Float64Array' : 'string'),
    `BufferURL locked declaration changed: ${name}`)
  }
  assert(catalog.baseline?.typings?.name === 'miniprogram-api-typings' && catalog.baseline.typings.version === '5.2.3'
    && catalog.baseline.typings.sources?.some(source => source.path === 'types/wx/lib.wx.api.d.ts'
      && source.sha256 === '25e9e6fdab1b4282ee5231d8f8de7a31a177d2edc690ec834e0da479cc166245'), 'BufferURL locked typings identity changed')
  const bufferURLReviewed = Object.entries(reviewedBufferURLSourceSha256).every(([id, digest]) => units[id].sha256 === digest)
  for (const name of ['wx.createBufferURL', 'wx.revokeBufferURL']) add(name, 'runtimeImplementation',
    Object.keys(reviewedBufferURLSourceSha256),
    name === 'wx.createBufferURL'
      ? 'Synchronous private native immutable byte lease for ArrayBuffer and exactly nine TypedArrays, exact byteOffset/byteLength snapshot, per-create native 192-bit opaque identity, 8 MiB per lease/32 MiB per owner/1024 lease bounds. One Session incarnation owns its AppService callback, Skia decoded image lookup and official Web Worker/WASM keyed resource reader; hide/page retirement retain leases. Native fixture execution and actual Web acceptance remain pending; other APIs retain their own consumer assessments'
      : 'Synchronous void revocation removes only the addressed owner lease, duplicate/unknown/foreign URLs are no-ops, and new Skia/cache or keyed Worker/WASM reads recheck live authority. Native engine drop, terminal app unload, account/service revoke and terminal call shutdown drain all leases even when public revoke is denied. Already published immutable frame/DOM leases keep the existing last-use lifetime. Native fixture execution and actual Web acceptance remain pending',
    bufferURLReviewed ? ['bufferURLNativeWasmConsumerValidation'] : ['bufferURLSourceReview', 'bufferURLNativeWasmConsumerValidation'])
  add('wx.canIUse', 'runtimeImplementation', ['runtime', 'quickjs', 'v8'], 'Actual capability negotiation, including bare wx API spelling')
  add('wx.pageScrollTo', 'runtimeImplementation', ['runtime', 'quickjs', 'v8'], 'Core scroll operation and scroll notifications')
  for (const [name, implementation] of [['wx.arrayBufferToBase64', '__container_array_buffer_to_base64'], ['wx.base64ToArrayBuffer', '__container_base64_to_array_buffer']]) {
    for (const id of ['quickjs', 'v8']) {
      const block = functionBlock(units[id].text, implementation, { lexical: true })
      assert(block.includes(`__container_capability("${name}")`) && units[id].text.includes(`${name.slice(3)}: ${implementation}`), `Core binary conversion changed: ${name}`)
    }
    add(name, 'runtimeImplementation', ['quickjs', 'v8'], 'Synchronous engine-local ArrayBuffer/Base64 conversion; no host call or async wait; invalid input throws a structured error')
  }

  // Shared app visibility and route-unload notifications use a retained
  // native dispatcher and actual receiver incarnation, separate from writable
  // compatibility globals. Error/page-not-found and actual host scheduler acceptance retain their gaps.
  assert(units.environment.text.includes('include_str!("lifecycle-notifications.js")') && units.environment.text.includes('dispatchLifecycleNotification: __container_lifecycle_notifications.dispatch'), 'Shared lifecycle notification installation changed')
  for (const id of ['quickjs', 'v8']) {
    assert(units[id].text.includes('pub fn dispatch_lifecycle_notification(') && units[id].text.includes('lifecycle_notification'), `Private native lifecycle dispatcher changed: ${id}`)
    assert(units[id].text.includes('__container_lifecycle_notifications.pageForHook(instanceId, index)'), `Retained page hook receiver changed: ${id}`)
  }
  const notification = units.lifecycleNotifications.text
  for (const event of ['AppShow', 'AppHide', 'BeforePageUnload', 'AfterPageUnload']) assert(notification.includes("'" + event + "'"), `Shared lifecycle notification missing: ${event}`)
  assert(notification.includes("'on' + entry[0]") && notification.includes("'off' + entry[0]") && notification.includes('if (callback === undefined)') && notification.includes('const callbacks = slice(lists[name]);'), 'Shared lifecycle listener contract changed')
  assert(notification.includes('record.page = page;') && notification.includes('!record.identity.retired') && notification.includes("put(event, 'routeEventId', record.routeEventId)"), 'Actual unload receiver identity changed')
  assert(notification.includes('function pageForHook(id, index)') && notification.includes('const page = livePage(__host_string(id));') && notification.includes("if (session) throw new ErrorValue('native page receiver unavailable');"), 'Retained page incarnation lookup changed')
  assert(runtime.includes('let notification_payload = args.first().cloned()') && runtime.includes('self.dispatch_lifecycle_notification(kind, &notification_payload)'), 'App lifecycle native notification dispatch changed')
  assert(units.runtimeLifecycle.text.includes('fn with_route_notifications<T>(') && units.runtimeLifecycle.text.includes('fn before_page_unload(') && units.runtimeLifecycle.text.includes('fn after_page_unload(') && units.runtimeLifecycle.text.includes('self.sync_current_pages()?;') && units.navigation.text.includes('self.flush_unload_notifications()'), 'Route lifecycle transaction notifications changed')
  // Direct commit guards remain in both in-route operations. The separate
  // prepare guard must run before before-route callbacks, not merely on commit.
  for (const [start, end] of [['    fn handle_page_push_in_route(', '    fn handle_page_replace('], ['    fn handle_page_replace_in_route(', '    fn handle_page_pop(']]) {
    const commit = between(runtime, start, end)
    assert(commit.includes('validate_page_input(path, payload)?;') && commit.indexOf('validate_page_input(path, payload)?;') < commit.indexOf('let previous ='), 'Direct navigation input preflight changed')
  }
  const routePrepare = between(units.runtimeRoutes.text, '    pub(super) fn prepare_route_transaction(', '    pub(super) fn finish_route_transaction')
  assert(routePrepare.includes('origin == RouteOrigin::NativePush || origin == RouteOrigin::NativeReplace') && routePrepare.includes('validate_page_input(path, payload)?;')
    && routePrepare.indexOf('validate_page_input(path, payload)?;') < routePrepare.indexOf('self.dispatch_route_notification("before",'), 'Native route preparation input preflight changed')
  assert(runtime.includes('self.retire_lifecycle_notifications()') && units.runtimeLifecycle.text.includes('self.lifecycle_notifications.departing.clear();') && notification.includes('delete pending[keys[i]];'), 'Terminal lifecycle notification retirement changed')
  for (const method of ['onAppShow', 'offAppShow', 'onAppHide', 'offAppHide', 'onBeforePageUnload', 'offBeforePageUnload', 'onAfterPageUnload', 'offAfterPageUnload']) add(`wx.${method}`, 'runtimeImplementation', ['lifecycleNotifications', 'runtimeLifecycle', ...(method.endsWith('PageUnload') ? ['runtimeRoutes'] : []), 'environment', 'runtime', 'navigation', 'quickjs', 'v8'], 'App-wide deduplicated snapshot listeners with identity/remove-all off, ordinary callback error isolation and retained native dispatch. Visibility follows App hook delivery with identical options even on hook failure; route unload brackets the retained actual live Page receiver and post-destruction current-page projection using one routeEventId per route. Terminal app unload clears notification listeners and pending departures even when its hook throws. Real platform/public SDK acceptance is pending')
  // Review finite cleanup independently from incomplete event/task production.
  // The locked signature and complete lexical authority are both required.
  // These source grants require separate native validation before adoption.
  const cleanupContracts = [
    ['wx.offBeforeAppRoute', 'OffBeforeAppRouteCallback', 'BeforeAppRoute', 'wx.onBeforeAppRoute'],
    ['wx.offAppRoute', 'OffAppRouteCallback', 'AppRoute', 'wx.onAppRoute'],
    ['wx.offPageNotFound', 'OffPageNotFoundCallback', 'PageNotFound', 'wx.onPageNotFound'],
    ['wx.cancelIdleCallback', 'number', undefined, undefined],
  ]
  for (const [name, type, event, counterpart] of cleanupContracts) {
    const api = catalog.apis.find(api => api.name === name), listener = event !== undefined
    assert(catalog.baseline?.baseLibrary === '3.17.3'
      && catalog.baseline.typings?.name === 'miniprogram-api-typings' && catalog.baseline.typings.version === '5.2.3'
      && catalog.baseline.typings.sources?.some(source => source.path === 'types/wx/lib.wx.api.d.ts'
        && source.sha256 === '25e9e6fdab1b4282ee5231d8f8de7a31a177d2edc690ec834e0da479cc166245')
      && api?.owner === 'runtime' && api.baseline === 'included' && api.property === undefined && api.receiver === undefined
      && api.kind === (listener ? 'subscription' : 'async') && api.event === event && api.counterpart === counterpart
      && javascriptShape(api.signatures) === javascriptShape([{ parameters: [{
        name: listener ? 'listener' : 'idleCallbackId', type, optional: listener,
      }], returns: 'void' }]), `Cleanup locked signature changed: ${name}`)
  }
  const cleanupCommonReviewed = javascriptShape(javascriptProgram(units.boundary.text)) === reviewedJavaScriptShapes.cleanupBoundary
    && javascriptShape(javascriptProgram(units.hostInstaller.text)) === reviewedJavaScriptShapes.installer
    && javascriptShape(javascriptProgram(units.lifecycleNotifications.text)) === reviewedJavaScriptShapes.lifecycle
    && units.environment.sha256 === reviewedEnvironmentSha256
    && ['quickjs', 'v8', 'runtime'].every(id => units[id].sha256 === reviewedSchedulerRustSha256[id])
    && units.hostServices.sha256 === reviewedCleanupRustSha256.hostServices
  const routeCleanupReviewed = cleanupCommonReviewed
    && javascriptShape(javascriptProgram(units.routeNotifications.text)) === reviewedJavaScriptShapes.routeCleanup
    && units.runtimeRoutes.sha256 === reviewedCleanupRustSha256.runtimeRoutes
  const pageNotFoundCleanupReviewed = cleanupCommonReviewed
    && javascriptShape(javascriptProgram(units.pageNotFoundNotifications.text)) === reviewedJavaScriptShapes.pageNotFoundCleanup
  const idleCancellationReviewed = cleanupCommonReviewed
    && javascriptShape(javascriptProgram(units.turnScheduler.text)) === reviewedJavaScriptShapes.scheduler
    && units.runtimeTurnScheduler.sha256 === reviewedSchedulerRustSha256.runtimeTurnScheduler

  // Separate conditional source eligibility for finite removal, never event
  // production. Adoption requires the final native/control/workspace gates;
  // source identity alone provides no SDK, host or fixed-WeChat acceptance.
  const retainedRemovalContracts = [
    ['wx.offUnhandledRejection', 'OffUnhandledRejectionCallback', 'UnhandledRejection', 'wx.onUnhandledRejection'],
    ['wx.offWindowResize', 'OffWindowResizeCallback', 'WindowResize', 'wx.onWindowResize'],
  ]
  for (const [name, type, event, counterpart] of retainedRemovalContracts) {
    const matches = catalog.apis.filter(api => api.name === name), api = matches[0]
    assert(matches.length === 1 && catalog.baseline?.baseLibrary === '3.17.3'
      && catalog.baseline.typings?.name === 'miniprogram-api-typings' && catalog.baseline.typings.version === '5.2.3'
      && catalog.baseline.typings.sources?.some(source => source.path === 'types/wx/lib.wx.api.d.ts'
        && source.sha256 === '25e9e6fdab1b4282ee5231d8f8de7a31a177d2edc690ec834e0da479cc166245')
      && api?.owner === 'runtime' && api.baseline === 'included' && api.property === undefined && api.receiver === undefined
      && api.kind === 'subscription' && api.event === event && api.counterpart === counterpart
      && javascriptShape(api.signatures) === javascriptShape([{ parameters: [{ name: 'listener', type, optional: true }], returns: 'void' }]),
    `Retained removal locked signature changed: ${name}`)
  }
  const retainedRemovalCommonReviewed = cleanupCommonReviewed
    && Object.entries(reviewedRetainedRemovalSourceSha256).every(([id, digest]) => units[id].sha256 === digest)
  for (const [name, id, shape] of [
    ['wx.offUnhandledRejection', 'unhandledRejections', 'unhandledRejectionRemoval'],
    ['wx.offWindowResize', 'windowResizeNotifications', 'windowResizeRemoval'],
  ]) {
    const reviewed = retainedRemovalCommonReviewed
      && javascriptShape(javascriptProgram(units[id].text)) === reviewedJavaScriptShapes[shape]
    add(name, 'runtimeImplementation', [id, 'boundary', 'hostServices', 'environment', 'hostInstaller',
      'lifecycleNotifications', 'runtimeLifecycle', 'manifestPacker', 'quickjs', 'v8', 'runtime'],
    'Synchronous void removal from the actual private realm listener registry using original function identity; omitted or undefined listener clears all. Ordinary dispatch snapshots, trusted withdrawal and permanent terminal retirement retain one owner. Own manifest/host/provider admission and grade are independent of the producer; no implicit grants or event-production credit. Fixed event timing, host and SDK acceptance remain separate',
    reviewed ? [] : ['reviewedRetainedRemovalOwnership'])
  }

  // Partial producer accounting is separate from the complete off contracts.
  // A protectedBoundary tag alone never establishes an implemented producer.
  // Only the exact retained native chain below may add concrete provenance;
  // its unresolved fixed-reference gaps always prevent an Available result.
  const retainedProducerContracts = [
    ['wx.onUnhandledRejection', 'OnUnhandledRejectionCallback', 'UnhandledRejection', 'wx.offUnhandledRejection',
      'unhandledRejections', 'unhandledRejectionRemoval',
      ['fixedUnhandledRejectionCheckpointTiming', 'fixedUnhandledRejectionReasonDeclarationParity', 'fixedUnhandledRejectionCaptureBudgetParity'],
      'Retained native rejection callbacks preserve Promise and arbitrary reason identities; the native microtask checkpoint flushes one private bounded queue into the App hook and realm listeners. Trusted registration admission retains a Partial ceiling. Exact WeChat checkpoint/handled timing and the 4096-entry failure policy remain unverified. The locked reason:string declaration conflicts with its Error-object prose and the current identity-preserving runtime; no fixed-reference payload parity is claimed'],
    ['wx.onWindowResize', 'OnWindowResizeCallback', 'WindowResize', 'wx.offWindowResize',
      'windowResizeNotifications', 'windowResizeRemoval',
      ['fixedWindowResizeCallbackPolicyParity'],
      'Private retained realm listeners consume actual committed Session geometry through the existing host and developer resize path; each callback receives a fresh exact size payload under a null Page scheduler owner. Engine health and developer candidate fences guard continuation. Duplicate/order/snapshot/receiver/hide and Page-hook timing follow container policy without measured fixed-WeChat parity; no host, public SDK or device acceptance is claimed'],
  ]
  for (const [name, type, event, counterpart, id, shape, missing, scope] of retainedProducerContracts) {
    const matches = catalog.apis.filter(api => api.name === name), api = matches[0]
    assert(matches.length === 1 && catalog.baseline?.baseLibrary === '3.17.3'
      && catalog.baseline.typings?.name === 'miniprogram-api-typings' && catalog.baseline.typings.version === '5.2.3'
      && catalog.baseline.typings.sources?.some(source => source.path === 'types/wx/lib.wx.api.d.ts'
        && source.sha256 === '25e9e6fdab1b4282ee5231d8f8de7a31a177d2edc690ec834e0da479cc166245')
      && api?.owner === 'runtime' && api.baseline === 'included' && api.property === undefined && api.receiver === undefined
      && api.kind === 'subscription' && api.event === event && api.counterpart === counterpart
      && javascriptShape(api.signatures) === javascriptShape([{ parameters: [{ name: 'listener', type, optional: false }], returns: 'void' }]),
    `Retained producer locked signature changed: ${name}`)
    const reviewed = retainedRemovalCommonReviewed
      && javascriptShape(javascriptProgram(units[id].text)) === reviewedJavaScriptShapes[shape]
    if (reviewed) add(name, 'runtimeImplementation', [id, 'boundary', 'hostServices', 'environment', 'hostInstaller',
      'lifecycleNotifications', 'runtimeLifecycle', 'manifestPacker', 'quickjs', 'v8', 'runtime'], scope, missing)
    else add(name, 'protectedBoundary', ['boundary'], scope, [...missing, 'reviewedRetainedProducerOwnership'])
  }

  // Callback ownership is shared with actual optional native subscriptions;
  // finite cleanup is complete independently of platform event production.
  // Only off names are runtime-owned. Actual producers remain optional host
  // registrations; the original ten alone retain a runtime Partial ceiling.
  const partialNotificationEvents = ['AfterPageLoad', 'AppRouteDone', 'BeforePageLoad', 'CopyUrl',
    'EmbeddedMiniProgramHeightChange', 'LazyLoadError', 'MenuButtonBoundingClientRectWeightChange',
    'ParallelStateChange', 'UserOffTranslation', 'UserTriggerTranslation']
  // Each side keeps its locked since/permission/plugin metadata independently.
  // Payload alias names describe the reference; off never invokes its callback.
  const ordinaryNotificationContracts = [
    ["ApiCategoryChange", "2.33.0", "2.33.0", null, "在插件中使用：不支持", "在插件中使用：不支持", "OnApiCategoryChangeListenerResult", "OnApiCategoryChangeListenerResult"],
    ["AudioInterruptionBegin", "2.6.2", "2.6.2", null, "在插件中使用：需要基础库 `2.15.0`", "在插件中使用：需要基础库 `2.15.0`", "GeneralCallbackResult", "GeneralCallbackResult"],
    ["AudioInterruptionEnd", "2.6.2", "2.6.2", null, "在插件中使用：需要基础库 `2.15.0`", "在插件中使用：需要基础库 `2.15.0`", "GeneralCallbackResult", "GeneralCallbackResult"],
    ["KeyboardHeightChange", "2.7.0", "2.9.2", null, "在插件中使用：不支持", "在插件中使用：不支持", "OnKeyboardHeightChangeListenerResult", "OnKeyboardHeightChangeListenerResult"],
    ["LocalServiceDiscoveryStop", "2.4.0", "2.4.0", null, "在插件中使用：需要基础库 `2.15.0`", "在插件中使用：需要基础库 `2.15.0`", "GeneralCallbackResult", "GeneralCallbackResult"],
    ["LocalServiceFound", "2.4.0", "2.4.0", null, "在插件中使用：需要基础库 `2.15.0`", "在插件中使用：需要基础库 `2.15.0`", "OnLocalServiceFoundListenerResult", "OnLocalServiceFoundListenerResult"],
    ["LocalServiceLost", "2.4.0", "2.4.0", null, "在插件中使用：需要基础库 `2.15.0`", "在插件中使用：需要基础库 `2.15.0`", "OnLocalServiceLostListenerResult", "OnLocalServiceLostListenerResult"],
    ["LocalServiceResolveFail", "2.4.0", "2.4.0", null, "在插件中使用：需要基础库 `2.15.0`", "在插件中使用：需要基础库 `2.15.0`", "OnLocalServiceLostListenerResult", "OnLocalServiceLostListenerResult"],
    ["MemoryWarning", "2.0.2", "2.9.0", null, "在插件中使用：不支持", "在插件中使用：不支持", "OnMemoryWarningListenerResult", "OnMemoryWarningListenerResult"],
    ["ScreenRecordingStateChanged", "2.24.0", "2.24.0", "microphone", "在插件中使用：不支持", "在插件中使用：不支持", "OnScreenRecordingStateChangedListenerResult", "OnScreenRecordingStateChangedListenerResult"],
    ["ThemeChange", "2.11.0", "2.11.0", null, "在插件中使用：不支持", "在插件中使用：不支持", "OnThemeChangeListenerResult", "OnThemeChangeListenerResult"],
    ["VoIPChatInterrupted", "2.7.0", "2.9.0", null, "在插件中使用：需要基础库 `2.9.1`", "在插件中使用：需要基础库 `2.9.1`", "OnVoIPChatInterruptedListenerResult", "OnVoIPChatInterruptedListenerResult"],
    ["VoIPChatMembersChanged", "2.7.0", "2.9.0", null, "在插件中使用：需要基础库 `2.9.1`", "在插件中使用：需要基础库 `2.9.1`", "OnVoIPChatMembersChangedListenerResult", "OnVoIPChatMembersChangedListenerResult"],
    ["VoIPChatSpeakersChanged", "2.7.0", "2.9.0", null, "在插件中使用：需要基础库 `2.9.1`", "在插件中使用：需要基础库 `2.9.1`", "OnVoIPChatSpeakersChangedListenerResult", "OnVoIPChatSpeakersChangedListenerResult"],
    ["VoIPChatStateChanged", "2.16.0", "2.16.0", null, "在插件中使用：不支持", "在插件中使用：不支持", "OnVoIPChatStateChangedListenerResult", "OnVoIPChatStateChangedListenerResult"],
    ["VoIPVideoMembersChanged", "2.11.0", "2.11.0", null, "在插件中使用：不支持", "在插件中使用：不支持", "OnVoIPVideoMembersChangedListenerResult", "OnVoIPVideoMembersChangedListenerResult"],
    ["BatteryInfoChange", "3.5.0", "3.5.0", null, "在插件中使用：不支持", "在插件中使用：不支持", "OnBatteryInfoChangeListenerResult", "OnBatteryInfoChangeListenerResult"],
    ["BLEPeripheralConnectionStateChanged", "2.10.3", "2.10.3", "bluetooth", "在插件中使用：需要基础库 `2.22.1`", "在插件中使用：需要基础库 `2.22.1`", "OnBLEPeripheralConnectionStateChangedListenerResult", "OnBLEPeripheralConnectionStateChangedListenerResult"],
    ["DeviceMotionChange", "2.3.0", "2.9.3", null, "在插件中使用：不支持", "在插件中使用：需要基础库 `2.9.1`", "OnDeviceMotionChangeListenerResult", "GeneralCallbackResult"],
    ["NetworkWeakChange", "2.21.0", "2.21.0", null, "在插件中使用：不支持", "在插件中使用：不支持", "OnNetworkWeakChangeListenerResult", "OnNetworkWeakChangeListenerResult"],
  ]
  const finiteNotificationEvents = [...partialNotificationEvents, ...ordinaryNotificationContracts.map(([event]) => event)]
  for (const event of finiteNotificationEvents) for (const mode of ['on', 'off']) {
    const name = `wx.${mode}${event}`, matches = catalog.apis.filter(api => api.name === name), api = matches[0]
    const ordinary = ordinaryNotificationContracts.find(([name]) => name === event)
    const parameters = mode === 'off' && event === 'CopyUrl' ? [] : [{
      name: 'listener', type: `${mode === 'off' ? 'Off' : 'On'}${event}Callback`, optional: mode === 'off',
    }]
    assert(matches.length === 1 && catalog.baseline?.baseLibrary === '3.17.3'
      && catalog.baseline.typings?.name === 'miniprogram-api-typings' && catalog.baseline.typings.version === '5.2.3'
      && catalog.baseline.typings.sources?.some(source => source.path === 'types/wx/lib.wx.api.d.ts'
        && source.sha256 === '25e9e6fdab1b4282ee5231d8f8de7a31a177d2edc690ec834e0da479cc166245')
      && api?.owner === 'host' && api.baseline === 'included' && api.property === undefined && api.receiver === undefined
      && api.kind === 'subscription' && api.event === event && api.counterpart === `wx.${mode === 'off' ? 'on' : 'off'}${event}`
      && (!ordinary || api.since === ordinary[mode === 'on' ? 1 : 2] && api.permission === (ordinary[3] ?? undefined))
      && javascriptShape(api.signatures) === javascriptShape([{ parameters, returns: 'void' }]),
    `Finite notification locked signature changed: ${name}`)
  }
  const finiteNotificationReviewed = cleanupCommonReviewed
    && javascriptShape(javascriptProgram(units.finiteNotifications.text)) === reviewedJavaScriptShapes.finiteNotifications
    && Object.entries(reviewedFiniteNotificationSourceSha256).every(([id, digest]) => units[id].sha256 === digest)
  const finiteNotificationIds = ['finiteNotifications', 'finiteNotificationResources', 'boundary', 'hostServices',
    'environment', 'hostInstaller', 'lifecycleNotifications', 'runtimeLifecycle', 'manifestPacker',
    'coreAssembly', 'quickjsExecution', 'terminalResources', 'engineExecution', 'quickjs', 'v8', 'runtime']
  for (const event of finiteNotificationEvents) {
    const off = `wx.off${event}`, on = `wx.on${event}`
    const ordinary = ordinaryNotificationContracts.find(([name]) => name === event)
    const metadata = ordinary ? ` Locked reference metadata is independent per side: on ${ordinary[4]}; off ${ordinary[5]}; permission ${ordinary[3] ?? 'none'}; on callback alias payload ${ordinary[6]}; off callback alias payload ${ordinary[7]}. Off compares the original listener and never invokes that callback alias. This records the fixed declaration without claiming plugin or producer payload parity.` : ''
    const removal = event === 'CopyUrl' ? 'The zero-argument void offCopyUrl always clears this pair, ignoring supplied arguments.'
      : 'The optional original function identity removes that listener; omitted or undefined listener clears this pair.'
    add(off, 'runtimeImplementation', finiteNotificationIds,
      `Synchronous void cleanup removes callback authority immediately from the same private realm registry used by the real on facade. ${removal} Reserved private cancellation nodes survive public effects/Promise poisoning; typed whole-snapshot active-id replacement prevents queued subscribe resurrection, native resources cancel before retained prefix ACK, and failed sweeps remain retryable. Trusted own off admission is independent of on, host descriptors and producer withdrawal; terminal retirement clears the same owner without public off permission. No implicit capability grant or event-production credit; host and public SDK acceptance remain separate${metadata}`,
      finiteNotificationReviewed ? [] : ['reviewedFiniteNotificationRemovalOwnership'])
    const gaps = ['finiteNotificationActualProducer', 'finiteNotificationFixedPayloadParity', 'finiteNotificationFixedTimingAndPluginParity']
    const producerScope = ordinary
      ? 'Private deduplicated realm callback registration and retained native transport for an optionally registered actual host producer. Only removals are runtime-owned. On retains the existing registered-host capability resolver, Full/Partial support, independent manifest/host defaults and explicit denial; no default capability is added. An installed producer descriptor is required before callback or ID allocation, and validation keeps the generic type-before-admission order. Trusted capture binds live IDs to exact APIs; Session/account/object/event/sequence/byte fences precede ingress, and off/re-add gets a fresh identity. Source accounting remains Partial because actual platform producer, fixed 3.17.3 payload, timing and plugin scope are unproven. No availability or acceptance promotion.' + metadata
      : 'Private deduplicated realm callback registration and native transport for an optionally registered actual host producer. Trusted capture binds active subscription IDs to exact API names; Session/account/object/event/sequence/byte fences precede retained engine ingress, and off/re-add gets a fresh identity. On admission requires real host registration and retains a Partial ceiling; no defaults are added. Complete platform producers and fixed 3.17.3 payload, timing and plugin scope remain incomplete or unproven. No availability or acceptance promotion.'
    if (finiteNotificationReviewed) add(on, 'runtimeImplementation', finiteNotificationIds, producerScope, gaps)
    else add(on, 'protectedBoundary', ['boundary'], producerScope, [...gaps, 'reviewedFiniteNotificationProducerOwnership'])
  }

  // Only these nine finite object removals receive new source credit. The
  // existing native factories and producers are proof of owner provenance,
  // never independently promoted implementation cells by this accounting.
  const objectNotificationContracts = [
    [
      "TCPSocket",
      "BindWifi",
      "OnBindWifiCallback",
      "OffBindWifiCallback",
      "2.25.0",
      "2.25.0",
      "wifi",
      "wifi",
      "在插件中使用：不支持",
      "在插件中使用：不支持",
      "GeneralCallbackResult",
      "GeneralCallbackResult"
    ],
    [
      "TCPSocket",
      "Close",
      "UDPSocketOnCloseCallback",
      "UDPSocketOffCloseCallback",
      null,
      null,
      null,
      null,
      "在插件中使用：不支持",
      "在插件中使用：不支持",
      "GeneralCallbackResult",
      "GeneralCallbackResult"
    ],
    [
      "TCPSocket",
      "Connect",
      "OnConnectCallback",
      "OffConnectCallback",
      null,
      null,
      null,
      null,
      "在插件中使用：不支持",
      "在插件中使用：不支持",
      "OnConnectListenerResult",
      "OnConnectListenerResult"
    ],
    [
      "TCPSocket",
      "Error",
      "UDPSocketOnErrorCallback",
      "UDPSocketOffErrorCallback",
      null,
      null,
      null,
      null,
      "在插件中使用：不支持",
      "在插件中使用：不支持",
      "GeneralCallbackResult",
      "GeneralCallbackResult"
    ],
    [
      "TCPSocket",
      "Message",
      "TCPSocketOnMessageCallback",
      "TCPSocketOffMessageCallback",
      null,
      null,
      null,
      null,
      "在插件中使用：不支持",
      "在插件中使用：不支持",
      "TCPSocketOnMessageListenerResult",
      "TCPSocketOnMessageListenerResult"
    ],
    [
      "UDPSocket",
      "Close",
      "UDPSocketOnCloseCallback",
      "UDPSocketOffCloseCallback",
      null,
      null,
      null,
      null,
      "在插件中使用：需要基础库 `2.11.1`",
      "在插件中使用：需要基础库 `2.11.1`",
      "GeneralCallbackResult",
      "GeneralCallbackResult"
    ],
    [
      "UDPSocket",
      "Error",
      "UDPSocketOnErrorCallback",
      "UDPSocketOffErrorCallback",
      null,
      null,
      null,
      null,
      "在插件中使用：需要基础库 `2.11.1`",
      "在插件中使用：需要基础库 `2.11.1`",
      "GeneralCallbackResult",
      "GeneralCallbackResult"
    ],
    [
      "UDPSocket",
      "Listening",
      "OnListeningCallback",
      "OffListeningCallback",
      null,
      null,
      null,
      null,
      "在插件中使用：需要基础库 `2.11.1`",
      "在插件中使用：需要基础库 `2.11.1`",
      "GeneralCallbackResult",
      "GeneralCallbackResult"
    ],
    [
      "UDPSocket",
      "Message",
      "UDPSocketOnMessageCallback",
      "UDPSocketOffMessageCallback",
      null,
      null,
      null,
      null,
      "在插件中使用：需要基础库 `2.11.1`",
      "在插件中使用：需要基础库 `2.11.1`",
      "UDPSocketOnMessageListenerResult",
      "UDPSocketOnMessageListenerResult"
    ]
  ]
  const objectFactoryContracts = [
    {
      "name": "wx.createTCPSocket",
      "kind": "object",
      "owner": "host",
      "objectType": "TCPSocket",
      "baseline": "included",
      "since": "2.18.0",
      "documentation": "https://developers.weixin.qq.com/miniprogram/dev/api/network/tcp/TCPSocket.html",
      "signatures": [
        {
          "parameters": [
            {
              "name": "option",
              "type": "CreateTCPSocketOption",
              "optional": true
            }
          ],
          "returns": "TCPSocket"
        }
      ]
    },
    {
      "name": "wx.createUDPSocket",
      "kind": "object",
      "owner": "host",
      "objectType": "UDPSocket",
      "baseline": "included",
      "since": "2.7.0",
      "documentation": "https://developers.weixin.qq.com/miniprogram/dev/api/network/udp/UDPSocket.html",
      "signatures": [
        {
          "parameters": [
            {
              "name": "type",
              "type": "string",
              "optional": true
            },
            {
              "name": "options",
              "type": "IAnyObject",
              "optional": true
            }
          ],
          "returns": "UDPSocket"
        }
      ]
    }
  ]
  for (const expected of objectFactoryContracts) {
    const matches = catalog.apis.filter(api => api.name === expected.name)
    assert(matches.length === 1 && javascriptShape(matches[0]) === javascriptShape(expected),
      `Object notification locked factory changed: ${expected.name}`)
  }
  for (const [receiver, event, onAlias, offAlias, onSince, offSince, onPermission, offPermission] of objectNotificationContracts) {
    for (const mode of ['on', 'off']) {
      const name = `object:${receiver}.${mode}${event}`, matches = catalog.apis.filter(api => api.name === name)
      const since = mode === 'on' ? onSince : offSince, permission = mode === 'on' ? onPermission : offPermission
      const expected = { name, kind: 'subscription', owner: 'host', receiver, event,
        counterpart: `object:${receiver}.${mode === 'on' ? 'off' : 'on'}${event}`, baseline: 'included',
        ...(since === null ? {} : { since }), ...(permission === null ? {} : { permission }),
        documentation: `https://developers.weixin.qq.com/miniprogram/dev/api/network/${receiver === 'TCPSocket' ? 'tcp' : 'udp'}/${receiver}.${mode}${event}.html`,
        signatures: [{ parameters: [{ name: 'listener', type: mode === 'on' ? onAlias : offAlias, optional: mode === 'off' }], returns: 'void' }],
      }
      assert(matches.length === 1 && catalog.baseline?.baseLibrary === '3.17.3'
        && catalog.baseline.typings?.name === 'miniprogram-api-typings' && catalog.baseline.typings.version === '5.2.3'
        && catalog.baseline.typings.sources?.some(source => source.path === 'types/wx/lib.wx.api.d.ts'
          && source.sha256 === '25e9e6fdab1b4282ee5231d8f8de7a31a177d2edc690ec834e0da479cc166245')
        && javascriptShape(matches[0]) === javascriptShape(expected), `Object notification locked signature changed: ${name}`)
    }
  }
  const objectNotificationReviewed = finiteNotificationReviewed
    && Object.entries(reviewedObjectNotificationSourceSha256).every(([id, digest]) => units[id].sha256 === digest)
    && containsAll(units.finiteNotifications.text, [
      'const objectPolicies = create(null), objectOwners = create(null);',
      'function attachObject(id, type, target, available, onRetire)',
      "put(target, 'on' + event, function(callback) { assertLive(state.onName); add(state, callback); });",
      "put(target, 'off' + event, function(callback) { remove(state, callback); });",
      'require(state.offName, (state.policy || state).off);',
      'state.objectId = id; state.event = event;', 'owner.onRetire();', 'delete objectOwners[owner.id];',
      'object !== state.objectId', 'state.onName !== name',
    ])
    && containsAll(units.boundary.text, ['if (finiteNotifications.owns(api)) return;',
      'finiteNotifications.attachObject(id, record.type, object,',
      'function() { record.closed = true; delete nativeObjects[id]; }',
      'if (objectId !== undefined) payload.objectId = objectId;',
      'finiteThen(finiteNativeCall(name, payload), undefined, failed);',
      'finiteThen(promise, function(result)',
      'api === "object:UDPSocket.close") forgetObject(record);'])
    && containsAll(units.hostInstaller.text, ['kind === "finite-notification-object-retire"',
      'if (!__container_finite_notifications.validObjectId(__host_value(snapshot, "objectId"))) return false;',
      '__container_finite_notifications.retireObject(__host_value(snapshot, "objectId"));\n    return true;'])
    && containsAll(units.hostServices.text, ['object.object_type == receiver',
      'registration.api == name && registration.object_id == object_id',
      'name == "object:UDPSocket.close"', 'Some(NativeOperation::Destroy { object_id }) if succeeded',
      'finite_notification_object_retirements', 'self.cancel_native_resource_call(&call_id)?;'])
    && containsAll(units.asyncHost.text, ['.reconcile_finite_notification_object_retirements()',
      'for resource_call_id in native_cleanup', 'if let Err(error) = self.finish_host_call(',
      'cleanup_error.get_or_insert(error);', 'self.resolve_engine_api_with_details(id, &name, result, raw_error)'])
    && ['quickjs', 'v8'].every(id => containsAll(units[id].text, ['pub fn retire_finite_notification_object(',
      '"kind":"finite-notification-object-retire", "objectId":object_id,']))
  const objectNotificationIds = [...finiteNotificationIds, 'asyncHost']
  for (const [receiver, event, onAlias, offAlias, onSince, offSince, onPermission, offPermission, onPlugin, offPlugin, onPayload, offPayload] of objectNotificationContracts) {
    const name = `object:${receiver}.off${event}`
    const scope = `Synchronous void removal uses the actual private callback owner of the existing ${receiver}.on${event} facade, bound to its real native factory creator, exact receiver type, objectId, API and listener identity. Optional original listener removes one; omitted or undefined clears only this object's event. Own off manifest/host/provider admission is independent of producer admission and descriptor availability, and saved aliases cannot target another object. Reserved private cancellation survives public queue/Promise poisoning; Session validates complete typed active replacement, cancels actual subscription creator calls before retained ACK and retries failed sweeps. Off never closes or destroys the socket and never cancels its object factory creator. Trusted typed native object retirement precedes any guest resolver, clears the same private owner and closes/deletes its bridge record; pending resolver failure cannot stop remaining native creator cleanup. Factory failure, terminal/account retirement and on withdrawal revoke actual callback authority. UDP.close success retires its destroyed socket after any final native Close delivery while pending; failed UDP.close preserves ownership. TCP.close only closes a connection and preserves socket lifetime. Fixed reference metadata stays independent per side: on since ${onSince ?? 'absent'}, off since ${offSince ?? 'absent'}; on permission ${onPermission ?? 'none'}, off permission ${offPermission ?? 'none'}; on ${onPlugin}; off ${offPlugin}; on alias ${onAlias} payload ${onPayload}; off alias ${offAlias} payload ${offPayload}. Off never invokes its callback alias. No producer, factory, close, Ads, default capability, SDK/platform or fixed-WeChat event-production credit is added; public acceptance remains pending.`
    if (objectNotificationReviewed) add(name, 'runtimeImplementation', objectNotificationIds, scope)
    else add(name, 'protectedBoundary', ['boundary'], scope, ['reviewedObjectNotificationRemovalOwnership'])
  }

  // Registration/rewrite retain producer gaps. Cleanup uses the same private
  // owner with an independently reviewed finite removal contract.
  // Done
  // listeners and Worklet router require separate presentation/runtime owners.
  const routeApis = ['wx.onBeforeAppRoute', 'wx.offBeforeAppRoute', 'wx.onAppRoute', 'wx.offAppRoute', 'wx.rewriteRoute']
  const route = units.routeNotifications.text, routeNative = units.runtimeRoutes.text, lease = units.routeLease.text
  assert(units.environment.text.includes('include_str!("route-transaction.js")') && units.environment.text.includes('dispatchRouteNotification: function(name,payload)')
    && units.environment.text.includes('__container_routes.before(payload)') && units.environment.text.includes('__container_routes.after(payload)'), 'Shared route transaction installation changed')
  for (const name of routeApis) {
    assert(route.includes(`put(namespace, '${name.slice(3)}',`) && units.manifestPacker.text.includes(`'${name}': 'partial'`), `Route five-method public installation changed: ${name}`)
    for (const id of ['quickjs', 'v8']) assert(units[id].text.includes(`"${name}": "partial"`), `Route engine default Partial changed: ${id}/${name}`)
  }
  assert(!route.includes("put(namespace, 'onAppRouteDone'") && !route.includes("put(namespace, 'offAppRouteDone'"), 'Route Done must remain outside the installed scope')
  const routeInstall = between(route, '  function install(capabilities)', '  function rewrite(options)')
  assert(containsAll(routeInstall, ["const value = own(capabilities, names[i]);", "value === 'partial' || value === 'full'", 'admitted = next;', 'generation = create(null);', 'current = false;', 'splice(beforeListeners, 0, beforeListeners.length)', 'splice(afterListeners, 0, afterListeners.length)', "supported(names[i]) ? support : 'unsupported'", "const cleanup = i === 1 || i === 3;", "cleanup && own(requested, names[i]) === 'full' ? 'full' : 'partial'"])
    && containsAll(route, ["function supported(name) { return own(admitted, name) === true; }", "require('wx.onBeforeAppRoute')", "require('wx.offBeforeAppRoute')", "require('wx.onAppRoute')", "require('wx.offAppRoute')", "if (!supported('wx.rewriteRoute'))", "if (retired || !supported(capability)) return false;", 'owner === generation', 'if (callback === undefined)', 'const listeners = slice(list);']), 'Route private admission and revocation changed')
  assert((units.hostInstaller.text.match(/__container_routes\.install\(capabilities\);/g) ?? []).length === 2
    && route.includes('install(__container_capabilities);') && route.includes('delete global.__container_host_route_rewrite;'), 'Route trusted capability publication changed')
  assert(containsAll(lease, ['validator: RefCell<Option<RouteRewriteValidator>>', 'pub fn begin(', 'if active.is_some()', '*active = Some(validator);', 'impl Drop for RouteRewriteLease', 'self.slot.validator.borrow_mut().take()']), 'Route owner-thread rewrite lease changed')
  for (const id of ['quickjs', 'v8']) {
    const engine = units[id].text
    assert(containsAll(engine, ['pub fn dispatch_route_notification(', 'let _lease = validator', '.map(|validator| slot.begin(validator))', 'route_notification', '"dispatchRouteNotification"', '__container_host_route_rewrite']), `Route retained native engine transport changed: ${id}`)
  }
  const routeSupport = between(routeNative, '    pub(super) fn route_capability(', '    pub(super) fn prepare_route_transaction(')
  assert(containsAll(routeSupport, ['provider: &BTreeMap<String, CapabilitySupport>', 'let support = provider', 'CapabilitySupport::Unsupported', 'min_support(support, CapabilitySupport::Partial)', 'Some(peer) if resolve(peer) == CapabilitySupport::Unsupported', '_ => own'])
    && containsAll(runtime, ['if let Some(support) = self.route_capability(name, provider_capabilities)', 'for name in route_transaction::APIS']), 'Route effective Partial ceiling and pair admission changed')
  const publishedPolicy = between(runtime, '    fn effective_capabilities(', '    // Public registration and removal have independent admission.')
  const manifestPolicy = between(publishedPolicy, '            .map(|name|', '            .collect();')
  const scalarPolicy = between(runtime, '    fn effective_capability(', '    fn effective_capability_with_provider(')
  const sharedPolicy = between(runtime, '    fn effective_capability_with_provider(', '\nfn render_bridge_error(')
  assert((publishedPolicy.match(/self\.provider\.capabilities_for_host\(&self\.config\.host\)/g) ?? []).length === 1
    && containsAll(publishedPolicy, ['.keys()', 'self.effective_capability_with_provider(name, &provider)', 'for name in self', '.registered\n            .iter()', '.chain(self.host_services.compatibility_cleanup_apis.iter())', 'for name in finite_notifications::OFF_APIS'])
    && manifestPolicy.includes('self.effective_capability_with_provider(name, &provider)')
    && containsAll(scalarPolicy, ['self.provider.capabilities_for_host(&self.config.host)', 'self.effective_capability_with_provider(name, &provider)'])
    && !sharedPolicy.includes('capabilities_for_host(') && !sharedPolicy.includes('self.effective_capabilities(')
    && !sharedPolicy.includes('self.effective_capability('), 'Shared capability publication and admission policy changed')
  const routeDispatch = between(routeNative, '    fn dispatch_route_notification(', '\n#[cfg(all(test,')
  assert(routeDispatch.includes('if self.effective_capability(api) == CapabilitySupport::Unsupported')
    && routeDispatch.indexOf('if self.effective_capability(api)') < routeDispatch.indexOf('.dispatch_route_notification(name, payload, validator)'), 'Route native Unsupported delivery guard changed')
  assert(containsAll(routePrepare, ['self.effective_capability("wx.rewriteRoute") != CapabilitySupport::Unsupported', 'if !allowed {', '*selection.borrow_mut() = Some(target);', 'navigation_target(&manifest, &api, Some(url), None)?', 'source_shape(self) != source']), 'Route native rewrite authority changed')
  const routeFinish = between(routeNative, '    pub(super) fn finish_route_transaction', '    fn dispatch_route_notification(')
  assert(routeFinish.includes('let result = self.with_route_event_id(id, |session| action(session, &payload))?;') && routeFinish.includes('self.sync_current_pages()?;') && routeFinish.includes('self.dispatch_route_notification("after", &event, None)?;')
    && routeFinish.indexOf('action(session, &payload)') < routeFinish.indexOf('self.dispatch_route_notification("after",'), 'Route after notification commit ownership changed')
  const directNavigation = between(runtime, '    fn navigation_result(', '    fn navigation_result_prepared(')
  const deferredPlan = between(units.navigation.text, '    fn plan_navigation(', '    fn')
  assert(directNavigation.indexOf('self.validate_navigation_admission(request, name)?;') >= 0 && directNavigation.indexOf('self.validate_navigation_admission(request, name)?;') < directNavigation.indexOf('self.prepare_route_transaction(')
    && deferredPlan.indexOf('self.validate_navigation_admission(&queued.request, &queued.name)?;') >= 0 && deferredPlan.indexOf('self.validate_navigation_admission(&queued.request, &queued.name)?;') < deferredPlan.indexOf('self.prepare_route_transaction(')
    && containsAll(units.navigation.text, ['prepared: Option<route_transaction::PreparedRoute>', 'queued.payload = prepared.payload.clone();', 'queued.prepared = Some(prepared);', 'pending.queued.prepared.take()']), 'Route common admission and deferred prepared target changed')
  assert(notification.includes('__container_routes.retire();') && notification.includes("if (name === 'cancelPageUnload')")
    && units.runtimeLifecycle.text.includes('"cancelPageUnload"'), 'Route terminal and failed-unload retirement changed')
  const routeIds = ['routeNotifications', 'routeLease', 'hostInstaller', 'environment', 'quickjs', 'v8', 'runtimeRoutes', 'runtime', 'navigation', 'manifestPacker', 'lifecycleNotifications', 'runtimeLifecycle']
  for (const name of routeApis) {
    const cleanup = name === 'wx.offBeforeAppRoute' || name === 'wx.offAppRoute'
    add(name, 'runtimeImplementation', [...routeIds, ...(cleanup ? ['boundary', 'hostServices'] : [])], cleanup
      ? 'Synchronous void removal of the actual private route listener identity, with omitted/undefined remove-all, deduplication, captured snapshot mutation and terminal retirement. Trusted pair revocation invalidates the captured batch and clears registration; both native registration paths retain this owner. The own manifest/host/provider grade is independent of a Partial producer while an Unsupported peer denies the pair. Only listener cleanup is complete; event/rewrite/recovery/host acceptance remain separate'
      :
    'Partial synchronous route-intent transaction: private deduplicated identity/remove-all listeners, trusted capability publication and on/off pair admission, native retained before/after dispatch and owner-thread rewrite lease. Manifest/host/provider minima cap at Partial; diagnostic map mutations do not authorize calls. A prepared final target/query drives native/deferred navigation, matching route/unload IDs and failed-live-unload cleanup; before validates liveness/admission and after follows successful commit/current-page publication. Trusted publication revokes and clears handlers; arbitrary background provider changes do not imply immediate JS cleanup. Official rewrite re-before/chaining, initial SDK unknown-route recovery and fresh initial geometry rewrite permits, plugin ownership, exact 3.17.3/no-op/device semantics and real presentation/animation ACK remain unverified. Done and Worklet router are excluded; no availability or acceptance promotion',
    cleanup ? routeCleanupReviewed ? [] : ['reviewedRouteCleanupSource'] : ['appRouteFixedVersionEventParity', 'appRouteInitialSdkRecovery', 'appRouteInitialGeometryRewrite', 'appRoutePluginOwnership', ...(['wx.onBeforeAppRoute', 'wx.rewriteRoute'].includes(name) ? ['appRouteRewriteChaining'] : [])])
  }

  // Registration/removal share one lexical authority. A catalog owner or a
  // public array alone cannot establish the concrete listener contract.
  const errors = units.errorNotifications.text
  assert(units.environment.text.includes('include_str!("error-notifications.js")'), 'Shared error notification hub installation changed')
  assert(containsAll(errors, ['let callbacks = create(null);', "put(wx, 'onError'", "put(wx, 'offError'", 'callbacks[index] !== callback', 'callback === undefined', 'const pending = snapshot();', 'generation !== admitted', 'retired = true;', "put(policy, 'wx.onError', nextOn ? 'partial' : 'unsupported')"]), 'Private error listener ownership or finite removal changed')
  const errorClosure = javascriptIife(javascriptProgram(errors), '__container_error_notifications')
  const errorReporter = errorClosure.body.filter(node => node.type === 'FunctionDeclaration' && node.id.name === 'report')
  assert(errorReporter.length === 1 && javascriptDirectStatement(errorReporter[0].body, `
    if (reporting) {
      if (__container_conformance_runtime_logs) __container_conformance_runtime_logs.invalidate();
      if (typeof __container_conformance_exceptions !== "undefined" && __container_conformance_exceptions) __container_conformance_exceptions.invalidate();
      return null;
    }
  `), 'Private error recursion guard or observation invalidation changed')
  assert((units.hostInstaller.text.match(/__container_error_notifications\.install\(capabilities\)/g) || []).length === 2
    && units.lifecycleNotifications.text.includes('__container_error_notifications.retire();'), 'Trusted error notification publication or retirement changed')
  const runtimeOwned = between(units.hostServices.text, 'pub(super) fn runtime_owned(', '#[derive(Default)]')
  assert(containsAll(runtimeOwned, ['"wx.onError"', '"wx.offError"'])
    && containsAll(units.boundary.text, ['return name === "wx.onError" || name === "wx.offError";', 'if (runtimeErrorApi(name) || retainedRuntimeApi(name) || runtimePageNotFoundApi(name) || runtimeUnhandledRejectionApi(name) || runtimeWindowResizeApi(name) || runtimeLifecycleApi(name)) return;', '!runtimeErrorApi(descriptor.counterpart)'])
    && ['wx.onError', 'wx.offError'].every(name => catalog.apis.find(api => api.name === name)?.owner === 'runtime'), 'Error pair host registration boundary changed')
  assert(containsAll(units.runtime.text, ['fn error_notification_capability(', 'self.error_notification_capability(name, provider_capabilities)', 'min_support(support, CapabilitySupport::Partial)']), 'Session error listener admission ceiling changed')
  assert(containsAll(units.timerTasks.text, ['__container_bind_timer_error_reporter', 'reportError(error);'])
    && units.boundary.text.includes('const reportError = globalThis.__container_report_error;')
    && units.componentEvents.text.includes('const __container_component_event_report_error = globalThis.__container_report_error;')
    && units.componentRelations.text.includes('const __container_component_relation_report_error = globalThis.__container_report_error;')
    && containsAll(units.engineBatch.text, ['const reportError = globalThis.__container_report_error;', 'reportError(error);', 'throw error;']), 'Retained error reporter chain changed')
  for (const id of ['quickjs', 'v8']) {
    assert(units[id].text.includes('return __container_error_notifications.report(error);')
      && units[id].text.includes('"wx.offError": "partial"'), `Shared error reporter delegation changed: ${id}`)
  }
  const errorIds = ['errorNotifications', 'environment', 'hostInstaller', 'lifecycleNotifications', 'hostServices', 'boundary', 'timerTasks', 'componentEvents', 'componentRelations', 'engineBatch', 'quickjs', 'v8', 'runtime']
  add('wx.onError', 'runtimeImplementation', errorIds,
    'Private AppService error listeners with independent registration/removal admission, legacy on-only compatibility and Partial ceiling; retained existing callback/call reporters, recursion isolation and terminal retirement. wx string projection, App.onError dispatch, complete uncaught-source capture and own-data-only stack normalization remain incomplete',
    ['fullUnhandledErrorDispatch', 'fixedWxErrorPayloadProjection', 'appErrorHookDispatch', 'completeErrorStackProjection'])
  add('wx.offError', 'runtimeImplementation', errorIds,
    'Private synchronous exact-function and optional remove-all cleanup, void return, snapshot mutation, trusted revocation and terminal retirement; public removal has independent admission and host registration cannot replace the pair. Completion applies to listener removal only; onError payload/source and App.onError gaps remain separate',
    [])

  const random = units.randomValues.text, entropy = units.randomValuesRuntime.text
  assert(units.environment.text.includes('include_str!("random-values.js")')
    && containsAll(random, ['const length = options.length;', 'isInteger(length)', 'length > 1048576', 'return finish(call(name, request), callbackMode);'])
    && containsAll(entropy, ['const MAX_BYTES: usize = 1_048_576;', 'fn requested_length(', 'fill_and_encode(length, getrandom::fill)?', 'self.check_random_values_context(&context)?;', 'LifecycleState::Destroyed']), 'Runtime secure random implementation or bounded delivery changed')
  assert(containsAll(units.runtime.text, ['let result = self.random_values_api_result(', 'self.random_values_api_result(&options, None, None)', 'if name == random_values::API {', 'fn effective_capability_with_provider('])
    && runtimeOwned.includes('"wx.getRandomValues"')
    && catalog.apis.find(api => api.name === 'wx.getRandomValues')?.owner === 'runtime'
    && ['quickjs', 'v8'].every(id => units[id].text.includes('"wx.getRandomValues": "full"')), 'Runtime secure random ownership or both-engine admission changed')
  add('wx.getRandomValues', 'runtimeImplementation', ['randomValues', 'randomValuesRuntime', 'runtime', 'environment', 'hostInstaller', 'hostServices', 'boundary', 'quickjs', 'v8', 'workspaceManifest', 'manifestPacker'],
    'Runtime-owned OS CSPRNG and wasm Web Crypto with bounded integer length 0..1048576, genuine ArrayBuffer result, callback/Promise modes and once-read structural options. Direct and engine calls share manifest/host admission, cancellation/deadline and retirement checks; configurable providers neither supply nor disable runtime entropy. Source capability is distinct from actual OS, Web Crypto, SDK and device acceptance', [])

  const lifecycle = ['onPageNotFound', 'offPageNotFound']
  for (const id of ['quickjs', 'v8']) {
    const facade = between(units[id].text, 'globalThis.wx = {', '\n[\n  "saveFile"')
    for (const method of lifecycle) assert(facade.includes(`  ${method}: function(callback)`), `Core lifecycle facade changed: ${id}/${method}`)
    for (const helper of ['__container_add_app_listener', '__container_remove_app_listener', '__container_report_error']) functionBlock(units[id].text, helper)
  }
  const pageNotFoundIds = ['pageNotFoundNotifications', 'boundary', 'environment', 'hostInstaller', 'lifecycleNotifications', 'hostServices', 'quickjs', 'v8', 'runtime']
  assert(units.environment.text.includes('include_str!("page-not-found-notifications.js")')
    && (units.hostInstaller.text.match(/__container_page_not_found\.install\(capabilities\)/g) ?? []).length === 2
    && units.lifecycleNotifications.text.includes('__container_page_not_found.retire();'), 'Private PageNotFound trusted installation or retirement changed')
  for (const id of ['quickjs', 'v8']) assert(containsAll(units[id].text, [
    'return __container_page_not_found.add(callback);', 'return __container_page_not_found.remove(callback);',
    'if (name === "pageNotFound") return __container_page_not_found.dispatch(args);',
  ]), `Private PageNotFound native facade delegation changed: ${id}`)
  add('wx.onPageNotFound', 'runtimeImplementation', pageNotFoundIds,
    'Private deduplicated listener registration shares the compatibility dispatcher and trusted terminal owner with removal; registration retains its Partial ceiling. Missing-route production, locked event payload and App recovery remain incomplete', ['pageNotFoundDispatch'])
  add('wx.offPageNotFound', 'runtimeImplementation', pageNotFoundIds,
    'Synchronous void exact-function and omitted/undefined remove-all cleanup of the actual private registration list, with deduplication, snapshot mutation, independent removal admission and terminal retirement. Public arrays are diagnostic projections. Revocation precedes projection traps and invalidates the captured batch; missing-route production and App recovery remain separate',
    pageNotFoundCleanupReviewed ? [] : ['reviewedPageNotFoundCleanupSource'])

  // The next-turn queue is installed by the shared private bootstrap, not by
  // the engine object literal. Source evidence establishes a retained driver;
  // actual automatic host pumps and idle opportunity producers stay separate.
  const schedulerAst = javascriptProgram(units.turnScheduler.text),
    installerAst = javascriptProgram(units.hostInstaller.text),
    lifecycleAst = javascriptProgram(units.lifecycleNotifications.text),
    schedulerAstMatches = javascriptShape(schedulerAst) === reviewedJavaScriptShapes.scheduler,
    schedulerCode = sourceCode(units.turnScheduler.text),
    scheduler = codeBlock(schedulerCode, 'const __container_turn_scheduler = (function()'),
    runtimeScheduler = sourceCode(units.runtimeTurnScheduler.text, 'rust')
  // Named textual anchors only retain diagnostics. The source grant below
  // still requires exact reviewed bytes for the whole Rust bootstrap file.
  assert(containsAll(units.environment.text, [
    'include_str!("turn-scheduler.js")',
    'const __host_scheduler_clock = globalThis.__container_host_performance_now;',
    'return __container_turn_scheduler.capture(request);',
  ]), 'Shared private turn scheduler installation or retained capture changed')
  for (const [method, entry] of [
    ['nextTick', "put(wx, 'nextTick', function(callback) { register('tick', callback); });"],
    ['requestIdleCallback', "put(wx, 'requestIdleCallback', function(callback, options) { return register('idle', callback, options); });"],
    ['cancelIdleCallback', "put(wx, 'cancelIdleCallback', function(id) { cancel(id); });"],
  ]) assert(javascriptDirectStatement(javascriptIife(schedulerAst, '__container_turn_scheduler'), entry), `Private turn scheduler public entry changed: ${method}`)
  assert(schedulerAstMatches || containsCode(scheduler, ['const maximumPending = 1024;', 'const maximumDispatch = 64;',
    "if (typeof callback !== 'function') throw new TypeErrorValue('callback must be a function');",
    'const admittedOwner = owner;', 'record.owner = admittedOwner;',
    'if (count >= maximumPending)', 'if (nextId >= 9007199254740991)',
    'const next = record.next;', 'turn.ticks[turn.tickLength++] = record;', 'turn.idles[turn.idleLength++] = record;',
    'if (!live(record.owner)) { remove(record); continue; }', 'turn.called >= turn.limit',
    'if (tasks[record.id] !== record) continue;']), 'Private turn scheduler admission, frontier or budget changed')
  assert(schedulerAstMatches || containsCode(scheduler, ['weakGet(__receiver_weak, entry.receiver) !== entry',
    'page.token !== (entry.scopeId === null ? entry.token : entry.pageToken)',
    'own(__receiver_scopes, entry.scopeId) === entry', 'owner = previous;',
    'captureReceiverOwner:function(receiver)', 'captureOwner:function() { return owner; }',
    'withCapturedOwner:withCapturedOwner', "put(policy, 'wx.nextTick', tickOn ? 'partial' : 'unsupported');",
    "put(policy, 'wx.requestIdleCallback', idleOn ? 'partial' : 'unsupported');",
    "put(policy, 'wx.cancelIdleCallback', cancelOn ? cancelSupport : 'unsupported');", "const cancelSupport = own(policy, 'wx.cancelIdleCallback') === 'full' ? 'full' : 'partial';",
    'if (!tickOn) prune(\'tick\');', 'if (!idleOn) prune(\'idle\');', 'retired = true;',
    'visibility:function(visible) { paused = !visible; }']), 'Private turn scheduler receiver lifetime or policy ceiling changed')
  assert(schedulerAstMatches || containsCode(scheduler, ["read(options, 'timeout')", 'record.deadline !== null && record.deadline <= current',
    'turn.didIdle', '!turn.didTick && !pendingTick()', "typeof timerReady === 'function' && !apply(timerReady, root, [])",
    "if (record && record.kind === 'idle') remove(record);", "put(result, 'errMsg', 'requestIdleCallback:ok');"]), 'Private turn scheduler idle opportunity, timeout or cancellation changed')
  assert((javascriptShape(installerAst) === reviewedJavaScriptShapes.installer
    || codePositions(sourceCode(units.hostInstaller.text), '__container_turn_scheduler.install(capabilities);').length === 2)
    && (javascriptShape(lifecycleAst) === reviewedJavaScriptShapes.lifecycle
      || containsCode(sourceCode(units.lifecycleNotifications.text), ['__container_turn_scheduler.retire();', "__container_turn_scheduler.visibility(name === 'show');"])), 'Trusted turn scheduler lifecycle or policy publication changed')
  for (const id of ['quickjs', 'v8']) {
    const engineCode = sourceCode(units[id].text, 'rust'),
      entry = codeBlock(engineCode, 'pub fn poll_turn_scheduler(', 'rust'),
      driver = codeBlock(engineCode, 'fn poll_turn_scheduler_within_turn(', 'rust')
    assert(equalCode(entry, sourceCode(id === 'quickjs'
      ? 'self.with_execution(|engine| engine.poll_turn_scheduler_within_turn(idle_deadline))'
      : 'self.poll_turn_scheduler_within_turn(idle_deadline)', 'rust'))
      && containsCode(driver, ['self.drain_microtasks()?;', 'self.capture_receiver_transport(',
      '"kind":"turn-scheduler", "action":"begin", "limit":64,',
      '"kind":"turn-scheduler", "action":"task", "allowIdle":allow_idle',
      '"kind":"turn-scheduler", "action":"end"',
      'deadline.saturating_duration_since(TurnSchedulerInstant::now())',
      'deadline > TurnSchedulerInstant::now()', 'Some(true) => self.drain_microtasks()?', 'for _ in 0..64'], 'rust'), `Native retained turn scheduler checkpoints changed: ${id}`)
  }
  const timerPoll = codeBlock(runtimeCode, 'fn poll_timers_within_turn(', 'rust')
  assert(containsCode(timerPoll, ['self.prepare_engine_environment()'], 'rust'), 'Session timer environment boundary changed')
  assert(containsCode(timerPoll, ['self.drain_engine_turn_scheduler(None)?;'], 'rust'), 'Session next-turn timer poll boundary changed')
  const idlePoll = codeBlock(runtimeScheduler, 'pub fn poll_idle(', 'rust'),
    forwarder = codeBlock(runtimeScheduler, 'fn drain_engine_turn_scheduler(', 'rust')
  assert(containsCode(runtimeScheduler, ['pub struct HostIdleOpportunity {', 'deadline: Instant,'], 'rust')
    && containsCode(idlePoll, [
    'if !session.initialized', 'session.drain_engine_turn_scheduler(Some(opportunity.deadline))?;',
    'session.append_engine_effects(&mut messages)?;'], 'rust')
    && ['quickjs', 'v8'].every(id => containsCode(codeBlock(forwarder, `if let Some(engine) = self.${id}_engine.as_mut()`, 'rust'), [
      'return engine.poll_turn_scheduler(idle_deadline).map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine));'], 'rust'))
    && containsCode(runtimeCode, ['mod turn_scheduler;'], 'rust'), 'Session retained idle opportunity driver changed')
  assert(equalCode(ceiling.condition, sourceCode('tab_bar::is_api(name) || matches!(name, "wx.nextTick" | "wx.requestIdleCallback")', 'rust'))
    && containsCode(runtimeCode, ['min_support(support, ceiling)'], 'rust'), 'Session turn scheduler Partial ceiling changed')
  const schedulerIds = ['turnScheduler', 'runtimeTurnScheduler', 'environment', 'hostInstaller', 'lifecycleNotifications', 'timerTasks', 'quickjs', 'v8', 'runtime']
  add('wx.nextTick', 'runtimeImplementation', schedulerIds,
    'Private bounded next-turn queue with captured Page/component ownership, frozen dispatch frontier, per-callback microtask checkpoints, visibility/retirement and manifest/host Partial ceiling. The fixed callback contract is later execution after the current synchronous work; it does not require completed pixel presentation. Native/Session driver source does not establish automatic pumps on actual hosts',
    ['actualHostNextTurnPumpAcceptance'])
  add('wx.requestIdleCallback', 'runtimeImplementation', schedulerIds,
    'Private idle queue admitted by a native monotonic host opportunity after pending ticks/timers, or its explicit timeout fallback; one idle callback returns effects before another opportunity. Source retains bounded cancellation and ownership; actual idle producers and the fixed callback declaration remain unaccepted',
    ['actualHostIdleOpportunityProducer', 'fixedIdleCallbackDeclarationParity'])
  add('wx.cancelIdleCallback', 'runtimeImplementation', [...schedulerIds, 'boundary', 'hostServices'],
    'Synchronous void cancellation removes only the matching real pending idle identity, is idempotent for absent/fired IDs and leaves nextTick identities untouched. Trusted cancellation revocation denies old aliases independently while request revocation prunes idle records; host descriptors cannot replace the retained owner. Own manifest/host/provider minima are preserved. Complete cancellation does not establish idle producers or actual host acceptance',
    idleCancellationReviewed ? [] : ['reviewedIdleCancellationSource'])

  const snapshots = quoted(between(units.snapshots.text, 'const SYNC_APIS:', 'let context = ProviderContext'))
  assert(snapshots.length === 12, 'Synchronous snapshot inventory changed; review snapshot provenance')
  const geometry = quoted(between(units.geometry.text, 'pub const HOST_GEOMETRY_APIS:', '/// Return only fields'))
  assert(geometry.length === 6 && units.windowMetrics.text.includes('pub fn validate('), 'Accepted display projection changed; review geometry provenance')
  const nativeProvider = between(units.nativeProvider.text, 'impl HostApiProvider for NativeProvider', 'struct Active')
  assert(nativeProvider.includes('container_runtime::merge_host_geometry') && nativeProvider.includes('Self::metadata(name, host)'), 'SDK NativeProvider no longer uses the accepted core observation')
  const gaps = {
    'wx.getDeviceInfo': ['fullDeviceSnapshotFields'],
    'wx.getAppBaseInfo': ['hostApplicationBaseSettings'],
    'wx.getSystemInfoSync': ['fullSystemSnapshotFields'],
    'wx.getSystemSetting': ['radioSystemSettings'],
  }
  for (const name of snapshots) {
    const launch = ['wx.getLaunchOptionsSync', 'wx.getEnterOptionsSync'].includes(name)
    const trustedAccount = name === 'wx.getAccountInfoSync'
    const acceptedGeometry = ['wx.getWindowInfo', 'wx.getMenuButtonBoundingClientRect'].includes(name)
    add(name, launch ? 'runtimeImplementation' : 'runtimeBridge', ['snapshots', 'quickjs', 'v8'], launch ? 'Runtime launch options for the current incarnation' : 'One owner-installed synchronous snapshot mirror, including configured extension snapshots; no registration-local JS cache', launch || trustedAccount || acceptedGeometry ? [] : gaps[name] ?? ['platformSnapshotProvider'])
    if (trustedAccount) {
      assert(units.hostServices.text.includes('let account_api = "wx.getAccountInfoSync".to_owned();') && units.hostServices.text.includes('"appId": config.application.app_id'), 'Trusted account snapshot source changed; review installation provenance')
      add(name, 'runtimeImplementation', ['hostServices'], 'Mini-program identity generated from the trusted accepted installation; no host principal is exposed')
    } else if (!launch) add(name, 'callerSuppliedProvider', ['strictProvider'], 'StrictHostProvider accepts supplied snapshots and never observes native device state')
    if (geometry.includes(name)) add(name, 'runtimeImplementation', ['geometry', 'windowMetrics', 'strictProvider', 'hostServices', 'nativeProvider'], acceptedGeometry
      ? 'Validated complete HostWindowMetrics/menu observation owned by the core; absent observations stay unsupported; SDK transport and presentation require separate chain acceptance'
      : 'Accepted core geometry replaces stale registered system fields; other fields retain their actual host source and unknown fields remain absent')
    if (['wx.getDeviceInfo', 'wx.getAppBaseInfo', 'wx.getSystemInfoSync'].includes(name)) add(name, 'runtimeImplementation', ['nativeProvider', 'hostServices'], 'Production SDK projects nonempty host platform/system metadata and its own SDK version; trusted host.appId comes from installation; brand/model/host app version are never synthesized')
  }
  assert(units.asyncHost.text.includes('host_services::observed_host_result('), 'Asynchronous native completion no longer shares accepted geometry')
  for (const name of ['wx.getSystemInfo', 'wx.getSystemInfoAsync']) {
    assert(geometry.includes(name) && units.quickjs.text.includes(`"${name.slice(3)}"`) && units.v8.text.includes(`"${name.slice(3)}"`), `Async system facade missing: ${name}`)
    add(name, 'runtimeImplementation', ['geometry', 'windowMetrics', 'strictProvider', 'hostServices', 'asyncHost', 'nativeProvider', 'runtime', 'quickjs', 'v8'], 'Async provider and explicit native completion share the current accepted geometry with the synchronous system facade, including resize while a native call is pending', ['fullSystemSnapshotFields'])
  }
  for (const name of ['wx.setNavigationBarTitle', 'wx.setNavigationBarColor']) {
    assert(nativeProvider.includes(`"${name}"`), `SDK native chrome operation changed: ${name}`)
    add(name, 'runtimeImplementation', ['runtime', 'nativeProvider'], 'Runtime validates page-owned chrome state consumed by native UI; mutation acknowledgment does not prove native presentation')
  }

  // Media state is owned by a private desired-state snapshot, independently of
  // public API queues. Only the two methods present in the locked catalog are
  // counted; the portable global factory is not a new denominator entry.
  const media = units.mediaQueries.text, observers = units.observers.text
  assert(units.environment.text.includes('include_str!("media-query-observers.js")') && units.environment.text.includes('if (__receiver_value(request, "kind") === "media-query-state") return __container_media_queries.capture(request);'), 'Private media bootstrap capture changed')
  assert(media.includes("const fields = ['width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight', 'orientation'];") && media.includes('const get = Reflect.get;') && media.includes('value = get(source, key);') && media.includes('finally { record.reading = false; }') && media.includes('requireLive(record);'), 'Media descriptor projection changed')
  assert(units.pageMirror.text.includes('function __host_copy_page_array(pages) { return __host_page_slice(pages); }') && media.includes('const pages = __host_current_pages === null ? __receiver_current_pages : __host_current_pages;'), 'Private media current-page projection changed')
  assert(media.includes('__receiver_get(__receiver_weak, record.owner) === identity') && media.includes('__receiver_value(__receiver_pages, identity.pageId) === page') && media.includes('identity.pageToken === page.token') && media.includes('record.pageIdentity = page;'), 'Private media receiver incarnation changed')
  assert(media.includes("put(api, 'observe', function(descriptor, callback)") && media.includes('subscription.descriptor = normalized;') && media.includes('subscription.callback = callback;') && media.includes("put(api, 'disconnect', function() { revoke(record); });") && media.includes('delete records[record.id];'), 'Private media method ownership changed')
  const revoke = between(media, 'function revoke(record)', 'function project(record, source)')
  assert(revoke.includes('if (!record.active) return;') && revoke.includes('record.active = false;') && revoke.includes("if (!record.active) throw fail('observer has been disconnected');") && revoke.includes('record.subscriptions = __host_create(null);'), 'Synchronous media disconnect fence changed')
  assert(media.includes('result.revision = __host_string(revision);') && media.includes('result.subscriptions = subscriptions;') && media.includes('return __receiver_snapshot_json(result);'), 'Media complete desired-state transport changed')
  for (const id of ['quickjs', 'v8']) {
    const capture = between(units[id].text, 'pub fn capture_media_query_state(', 'pub fn capture_component_snapshot_receipts(')
    assert(capture.includes('self.capture_receiver_transport(serde_json::json!({') && capture.includes('"kind":"media-query-state"'), `Private native media capture changed: ${id}`)
    assert(units[id].text.includes('__receiver_current_pages = __host_copy_page_array(instances);'), `Private current-page media fallback changed: ${id}`)
  }
  assert((observers.match(/\.capture_media_query_state\(known\)/g) ?? []).length === 2 && observers.includes('let state: MediaDesiredState = serde_json::from_value(state)') && observers.includes('registry.subscriptions.extend(desired);') && observers.includes('registry.media_revision = all_live.then_some(revision);'), 'Atomic native media reconciliation changed')
  const notify = between(observers, 'pub(super) fn notify_observers(', '\nfn required_string')
  const debtIndex = notify.indexOf('self.observer_observation_pending = true;'), captureIndex = notify.indexOf('self.reconcile_observer_queries()?;')
  const observerReconcile = between(observers, 'pub(super) fn reconcile_observer_queries(', 'pub(super) fn notify_observers(')
  assert(debtIndex >= 0 && captureIndex > debtIndex && runtime.includes('self.reconcile_observer_queries()?;')
    && /let intersection = self\.reconcile_intersection_queries\(\);\s*let media = self\.reconcile_media_queries\(\);\s*intersection\?;\s*media/.test(observerReconcile), 'Media capture failure retry debt changed')
  const mediaCommitIndex = notify.indexOf('for (key, state) in measurements.media_states'), intersectionIndex = notify.indexOf('if !measurements.notifications.is_empty()')
  assert(notify.includes('self.dispatch_lifecycle_notification(') && notify.includes('"mediaQuery"') && mediaCommitIndex >= 0 && intersectionIndex > mediaCommitIndex, 'Independent private media delivery commit changed')
  assert(notification.includes("if (name === 'mediaQuery') return __container_media_queries.dispatch(payload);") && media.includes('runWithOwner(record.owner, function() { apply(subscription.callback, undefined, [event]); });') && media.includes('if (!record || !record.active) continue;') && media.includes('if (!live(record)) { revoke(record); continue; }'), 'Retained private media callback dispatch changed')
  assert(notification.includes('__container_media_queries.retire();') && units.runtimeLifecycle.text.includes('*self.observers.borrow_mut() = observers::ObserverRegistry::default();') && media.includes('release(owner);'), 'Terminal media observer retirement changed')
  for (const method of ['observe', 'disconnect']) add(`object:MediaQueryObserver.${method}`, 'runtimeImplementation', ['mediaQueries', 'environment', 'pageMirror', 'lifecycleNotifications', 'runtimeLifecycle', 'runtime', 'observers', 'quickjs', 'v8'], 'Private actual Page/Component incarnation owns the immutable seven-field media query and callbacks. Full desired-state native reconciliation and retained dispatch survive public queue/alias mutation; initial/changed matching uses observed logical window size, disconnect and disposal synchronously fence queued siblings, terminal unload retires both sides. Explicit subscription budgets and private retry debt apply; public SDK/platform acceptance remains separate', method === 'disconnect' ? [] : ['mediaQueryNumericParameterParity', 'mediaQueryRepeatedObserveParity', 'mediaQueryHiddenOwnerTimingParity', 'mediaQuerySquareOrientationParity'])

  // The locked zero-argument cleanup member has its own finite contract. Its
  // authoritative Session implementation is private shared state, not the
  // legacy engine-local diagnostic observer or its public effect table.
  const intersection = units.intersectionQueries.text
  const cleanupContract = catalog.apis.find(api => api.name === 'object:IntersectionObserver.disconnect')
  assert(cleanupContract?.signatures?.length === 1 && cleanupContract.signatures[0].parameters.length === 0 && cleanupContract.signatures[0].returns === 'void', 'Intersection disconnect locked signature changed')
  assert(containsAll(units.environment.text, ['include_str!("intersection-observers.js")', 'if (__receiver_value(request, "kind") === "intersection-query-state") return __container_intersections.capture(request);'])
    && intersection.includes("put(wx, 'createIntersectionObserver', create);") && intersection.includes('__container_intersection_observer = create;')
    && notification.includes('__container_intersections.session();'), 'Private intersection installation changed')
  const intersectionRevoke = between(intersection, '  function revoke(record)', '  function requireLive(record)')
  assert(containsAll(intersectionRevoke, ['if (!record.active) return;', 'record.active = false;', 'delete records[record.id];', 'record.subscriptions = __host_create(null);', 'record.count = 0;'])
    && intersectionRevoke.indexOf('record.active = false;') < intersectionRevoke.indexOf('invalidate();')
    && intersection.includes("put(api, 'disconnect', function() { revoke(record); });"), 'Synchronous intersection disconnect fence changed')
  const intersectionLive = between(intersection, '  function live(record)', '  function revoke(record)')
  assert(containsAll(intersectionLive, ['!identity.retired && !page.retired', '__receiver_get(__receiver_weak, record.owner) === identity', '__receiver_value(__receiver_pages, identity.pageId) === page', 'identity.pageToken === page.token', '__receiver_value(__receiver_scopes, identity.scopeId) === identity']), 'Private intersection receiver incarnation changed')
  const intersectionCapture = between(intersection, '  function capture(request)', '  function reject(batch)')
  assert(containsAll(intersectionCapture, ["support === 'unsupported'", 'revoke(record);', 'result.revision = __host_string(revision);', 'result.subscriptions = subscriptions;', 'value.ownerToken = record.identity.token;', 'value.pageToken = record.pageIdentity.token;', 'return __receiver_snapshot_json(result);']), 'Intersection complete desired-state capture changed')
  for (const id of ['quickjs', 'v8']) {
    const capture = between(units[id].text, 'pub fn capture_intersection_query_state(', 'pub fn capture_component_snapshot_receipts(')
    assert(capture.includes('self.capture_receiver_transport(serde_json::json!({') && /"kind":"intersection-query-state",\s*"revision":revision\.map\(\|value\| value\.to_string\(\)\)/.test(capture), `Private native intersection capture changed: ${id}`)
  }
  const intersectionReconcile = between(observers, 'pub(super) fn reconcile_intersection_queries(', '\n    #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]')
  const removalIndex = intersectionReconcile.indexOf('entry.intersection_identity.is_none() || (supported && present.contains(key))')
  assert((intersectionReconcile.match(/\.capture_intersection_query_state\(known\)/g) ?? []).length === 2
    && containsAll(intersectionReconcile, ['let state: IntersectionDesiredState = serde_json::from_value(state)', 'let mut desired = BTreeMap::new();', 'self.selector_receiver_snapshot(', 'registry.subscriptions.extend(desired);', 'registry.intersection_revision = all_live.then_some(revision);'])
    && removalIndex >= 0 && removalIndex < intersectionReconcile.indexOf('for entry in entries {'), 'Private intersection native reconciliation changed')
  const intersectionDispatch = between(intersection, '  function dispatch(batch)', '  __container_intersection_observer = create;')
  assert(containsAll(intersectionDispatch, ['if (!record || !record.active) continue;', 'if (!live(record)) { revoke(record); continue; }', "__receiver_value(notification, 'ownerToken') !== record.identity.token", "__receiver_value(notification, 'pageToken') !== record.pageIdentity.token", 'runWithOwner(record.owner, function() { apply(subscription.callback, undefined, [value]); });'])
    && notification.includes("if (name === 'intersectionQuery') return __container_intersections.dispatch(payload);")
    && /self\.dispatch_lifecycle_notification\(\s*"intersectionQuery",\s*&json!\(measurements\.intersection_notifications\)/.test(notify), 'Retained private intersection delivery changed')
  assert(containsAll(intersection, ['release(owner);', 'record.identity === identity', 'record.pageIdentity === identity', 'retired = true;'])
    && notification.includes('__container_intersections.retire();')
    && units.runtimeLifecycle.text.includes('*self.observers.borrow_mut() = observers::ObserverRegistry::default();')
    && runtime.includes('self.observers.borrow_mut().release_page(id);')
    && units.observerComponents.text.includes('self.observers.borrow_mut().release_scopes(scopes);')
    && /\.intersection_identity\s*\.as_ref\(\)\s*\.and_then\(\|\(_, _, scope\)\| scope\.as_ref\(\)\)/.test(between(observers, 'pub(super) fn release_scopes(', '    fn measure(')), 'Intersection owner retirement changed')
  const sdkSession = between(units.nativeProvider.text, 'let mut session = Session::new(', 'session.ensure_view_execution_supported()?;')
  const supportedProfiles = between(runtime, 'let mut supported_profiles = vec![', 'if config.session_id.trim().is_empty()')
  assert(units.sdkFfi.text.includes('let session = ContainerSession::new(config)?;') && sdkSession.includes('..SessionConfig::default()') && !sdkSession.includes('browser_view_enabled: true')
    && runtime.includes('browser_view_enabled: false,') && containsAll(supportedProfiles, ['RendererProfile::Skia', 'RendererProfile::SkylineCompat', 'if config.browser_view_enabled {', 'supported_profiles.push(container_ir::RendererProfile::WebView);'])
    && units.renderProfiles.text.includes('default: RendererProfile::Skia,'), 'Native intersection default renderer admission changed')
  const browserAdmission = between(units.browserView.text, 'pub(super) fn browser_api_unavailable(', '    pub fn is_browser_view_presented(')
  assert(browserAdmission.includes('self.browser_route_active()') && browserAdmission.includes('|| name == "wx.createIntersectionObserver"')
    && containsAll(units.webHost.text, ['pub enum WebRendererMode {', '#[default]\n    Software,', 'BrowserView,', 'config.browser_view_enabled = true;', 'config.renderer_override = Some(container_ir::RendererProfile::WebView);']), 'Web intersection renderer gap changed')
  assert(units.manifestPacker.text.includes("'wx.createIntersectionObserver': 'partial'") && ['quickjs', 'v8'].every(id => units[id].text.includes('"wx.createIntersectionObserver": "partial"')), 'Intersection factory Partial capability changed')
  const intersectionIds = ['intersectionQueries', 'environment', 'pageMirror', 'lifecycleNotifications', 'runtimeLifecycle', 'runtime', 'observerComponents', 'observers', 'quickjs', 'v8']
  add('object:IntersectionObserver.disconnect', 'runtimeImplementation', intersectionIds, 'Locked zero-argument synchronous void cleanup of a returned IntersectionObserver. Private actual Page/Component incarnation and complete desired-state removal fence queued, same-batch and future callbacks before native cleanup; retained capture/reconciliation and terminal/page/scope retirement own the registry. Constructor, observe/relative parameters, payload and reuse parity remain separate; public SDK/platform acceptance is pending')

  // Selector methods live in one shared descriptor implementation. Follow its
  // retained private transport through both execution engines and the actual
  // native/DOM queues; the old engine-local method block no longer owns them.
  const selector = units.selectorQueries.text, privateSelector = units.privateSelectors.text
  assert(units.environment.text.includes('include_str!("selector-query.js")'), 'Shared SelectorQuery installation changed')
  assert(containsAll(units.environment.text, ['captureReceiverIncarnations: __receiver_capture', 'dispatchLifecycleNotification: __container_lifecycle_notifications.dispatch', 'if (__receiver_value(request, "kind") === "selector-query-requests") return __container_selector_queries.capture(request);', 'const privateQuery = animationWrites || __receiver_value(request, "kind") === "selector-query-receivers";', 'const page = __receiver_value(__receiver_pages, pageId);', 'const entry = __receiver_value(__receiver_scopes, scope);', 'entry.pageToken !== page.token']), 'Retained private selector receiver capture changed')
  for (const id of ['quickjs', 'v8']) {
    const engine = units[id].text
    assert(containsAll(engine, ['container_core::app_service_environment_bootstrap(MINI_PROGRAM_BOOTSTRAP)', 'function __container_selector_query() { return __container_selector_queries.create(); }', 'createSelectorQuery: __container_selector_query', '__receiver_current_pages = __host_copy_page_array(instances);']), `Shared SelectorQuery engine facade changed: ${id}`)
    const capture = between(engine, 'pub fn capture_selector_query_requests(', 'fn capture_receiver_transport(')
    assert(containsAll(capture, ['self.capture_receiver_transport(', '"kind":"selector-query-requests","after":after.to_string()', 'pub fn capture_selector_query_receivers(', '"kind":"selector-query-receivers","pageId":page_id.to_string(),"scopes":scopes']), `Retained selector engine capture changed: ${id}`)
  }
  assert(containsAll(selector, ['const identity=__receiver_get(__receiver_weak,receiver);', 'current.identity===record.identity && current.pageIdentity===record.pageIdentity', 'if(record.revision!==domRevision())', 'if(!live(scopes[i]))', 'pages[pages.length-1]!==record.owner.page', 'const frozen=fields==null?null:parse(__receiver_snapshot_json(fields));', "put(selection,'scope',scope);put(selection,'invalidScope',invalidScope);", "put(query,'scopeId',selection.scope?selection.scope.scopeId:null);", 'return executionPromise(promise);']), 'Shared selector scope and immutable request ownership changed')
  assert(containsAll(selector, ['callbackOwner=owner(preferredReceiver)||owner(captureCurrent())', 'const fallbackOwner=currentPageOwner();', 'const authority=callbackOwner||fallbackOwner;', 'next.pageIdentity!==authority.pageIdentity', 'if(!callbackOwner && next && !invalidScope)callbackOwner=next;', 'const record={owner:callbackOwner||fallbackOwner,callbackOwner:callbackOwner,scopes:scopes,revision:revision,dom:dom};', 'if(record.callbackOwner) runOwner(record.callbackOwner.receiver,call); else call();']), 'Selector lifecycle authority and callback context separation changed')
  assert(containsAll(selector, ['request.receivers=record.owner?{pageToken:record.owner.pageIdentity.token,scopes:scopes}:null;', '__receiver_snapshot_json(request).length>1024*1024', 'put(pending,ticket,{resolve:resolve,reject:reject});', 'push(queued,request);count+=1;', "while(queued.length && integer(queued[0].sequence)<=cursor)splice(queued,0,1);", 'delete pending[ticket];count-=1;', 'values.length!==batch.length', 'callback(batch[i].callback,values[i],record);', 'function(failure){validate(record);throw failure;}']), 'Private selector request and callback transport changed')
  assert(containsAll(privateSelector, ['const FIRST_PRIVATE_ID: u64 = 1 << 63;', 'let snapshot = self.capture_private_selector_requests()?;', '.capture_selector_query_requests(after)', '.capture_selector_query_receivers(page, scopes)', 'self.selector_receiver_snapshot(id, page, &scopes)? != request.receivers', 'if !self.legacy_manual_selector_query_embedding()', 'self.enqueue_browser_query(id, owner.as_ref(), &request.options)', 'self.dispatch_native_query(id, owner.as_ref(), &request.options)']), 'Private selector admission and receiver proof changed')
  const privateCompletion = between(privateSelector, 'pub(super) fn resolve_private_selector_query(', '\n        Ok(true)')
  assert(containsAll(privateCompletion, ['self.private_selectors.deliveries.get(&id).cloned()', 'if !self.dispatch_lifecycle_notification("selectorQuery", &payload)? {', '"private selector delivery was not acknowledged"', 'self.private_selectors.deliveries.remove(&id);']) && privateCompletion.indexOf('self.dispatch_lifecycle_notification(') < privateCompletion.indexOf('self.private_selectors.deliveries.remove('), 'Retained selector completion acknowledgement changed')
  assert(privateCompletion.includes('self.ensure_engine_execution_healthy()?;') && (privateCompletion.match(/container_core::JsEngine::drain_microtasks\(/g) ?? []).length === 2 && privateCompletion.indexOf('self.private_selectors.deliveries.remove(') < privateCompletion.indexOf('container_core::JsEngine::drain_microtasks('), 'Private selector acknowledged completion task checkpoint changed')
  assert(containsAll(units.asyncHost.text, ['name == "wx.createSelectorQuery" && id >= private_selector::FIRST_PRIVATE_ID', 'self.resolve_private_selector_query(id, &result)?;']), 'Private selector native result routing changed')
  assert((runtime.match(/self\.drain_private_selector_queries\(\)\?;/g) ?? []).length === 2 && /self\.drain_private_selector_queries\(\)\?;\s*let effects = match self\.config\.engine/.test(runtime) && /let private_queries = self\.drain_private_selector_queries\(\)\?;\s*let has_effects = effects/.test(runtime) && /if private_queries\s*\{\s*continue;/.test(runtime) && containsAll(privateSelector, ['let had_requests = !snapshot.requests.is_empty();', 'Ok(had_requests)']), 'Private selector effect reconciliation changed')
  const nativeQuery = units.nativeQueries.text.split('#[cfg(test)]')[0], browserQuery = units.browserQueries.text.split('#[cfg(test)]')[0]
  assert(containsAll(nativeQuery, ['pub(super) fn dispatch_native_query(', 'self.selector_receiver_snapshot(api_id, page_id.0, &scopes)?;', 'Ok(current) if current == waiting.receivers =>', 'self.selector_query_result(&waiting.options)', 'pub(super) fn retire_native_queries(']) && runtime.includes('self.retire_native_queries(Some(id), "native selector page was hidden or unloaded");'), 'Native selector queue receiver and retirement chain changed')
  assert(containsAll(browserQuery, ['pub(super) fn drain_browser_query_completions(', 'if id >= private_selector::FIRST_PRIVATE_ID {', 'return self.resolve_engine_api(id, "wx.createSelectorQuery", result);', 'Ok(project_query(pending, topology, &geometry, scroll, extent)?)', 'selector_geometry::basic_selector_geometry(', 'metadata.map(|node| (id, &node.dataset))']), 'Browser selector private completion and projection changed')
  const basicGeometry = units.selectorGeometry.text.split('#[cfg(test)]')[0]
  assert(containsAll(basicGeometry, ['if let Some([width, height]) = scroll_extent', 'identity.map(|(id, _)| id).unwrap_or("")', '.map(|(_, dataset)| json!(dataset))', '"right":left+width,"bottom":top+height', 'object.insert("scrollWidth".into(), json!(width));', 'object.insert("scrollHeight".into(), json!(height));']) && runtime.includes('selector_geometry::basic_selector_geometry('), 'Shared selector actual geometry projection changed')
  assert(containsAll(browserQuery, ['request_payload["includeViewportExtent"] = json!(true);', 'let scroll_extent = measured.map(|node| node.scroll_extent).or(viewport_extent);', 'if needs_scroll && scroll_extent.is_none()']) && containsAll(units.domSessionClient.text, ["this.queryScope !== 'presentation'", "this.request('view.query.enable'", 'value.includeViewportExtent !== true', 'value.includeViewportExtent === true && sample.viewportExtent !== undefined']) && containsAll(units.domPresenter.text, ['entry.candidate.measureViewportExtent()', 'measured.size !== entry.plan.tables.nodes.size', 'const scroller = document.scrollingElement;', 'return { width: scroller?.scrollWidth, height: scroller?.scrollHeight };']), 'DOM selector presentation and measured extent transport changed')
  assert(containsAll(notification, ['__container_selector_queries.enable();', "if (name === 'selectorQuery') return __container_selector_queries.deliver(payload);", '__container_selector_queries.retire();']) && units.runtimeLifecycle.text.includes('self.private_selectors = Default::default();') && containsAll(selector, ['retired=true;splice(queued,0,queued.length);', 'state.reject(error(\'ERR_CANCELLED\',\'query realm is retired\'));']), 'Terminal private selector retirement changed')
  const selectorIds = ['selectorQueries', 'environment', 'lifecycleNotifications', 'quickjs', 'v8', 'runtime', 'privateSelectors', 'asyncHost', 'runtimeLifecycle', 'nativeQueries', 'browserQueries', 'selectorGeometry', 'domPresenter', 'domSessionClient']
  const selectorScope = 'Shared selector descriptors freeze per-reference selection/scope and per-exec batches, with actual receiver incarnation, retained capture/completion, bounded native/DOM admission and terminal retirement. Captured Page authority fences context-free Session queries without inventing callback context; real synchronous or valid explicit receiver owns callbacks. Basic geometry preserves public id/typed dataset. exec keeps a portable Promise extension rather than claiming a locked NodesRef return; full fields/style/mark/node handle, absent ref/context, selector parameter parity and fixed-version scroll extent/DOM protocol acceptance remain gaps. Source-chain evidence does not imply public SDK or device acceptance'
  const refMethods = between(selector, '      const ref={', '\n      return ref;'), queryMethods = between(selector, '    const api={', '\n    return api;\n  }')
  for (const [receiver, block, methods] of [['SelectorQuery', queryMethods, ['exec', 'in', 'select', 'selectAll', 'selectViewport']], ['NodesRef', refMethods, ['boundingClientRect', 'fields', 'node', 'scrollOffset']]]) {
    for (const method of methods) {
      assert(new RegExp(`(?:^|[,{])\\s*${method}\\s*:\\s*function\\s*\\(`, 'm').test(block), `Shared selector descriptor changed: ${receiver}.${method}`)
      if (receiver === 'NodesRef') assert(block.includes(`enqueue(selection,'${method}',`), `Shared selector operation dispatch changed: ${method}`)
      add(`object:${receiver}.${method}`, 'runtimeImplementation', selectorIds, selectorScope, ['fullLockedParameterScope'])
    }
  }
  add('wx.createSelectorQuery', 'runtimeImplementation', selectorIds, selectorScope, ['fullLockedParameterScope'])

  // These source-chain diagnostics bind the Partial claim to real consumers,
  // rather than treating a recorded action or a listed path as playback. They
  // exclude comments; the emitted source SHA values still identify whole files.
  const animationCode = new Map()
  const requireAnimation = (id, anchors, boundary, region) => {
    const language = units[id].path.endsWith('.rs') ? 'rust' : 'js'
    if (!animationCode.has(id)) animationCode.set(id, sourceCode(units[id].text, language))
    const tokens = region ? codeBlock(animationCode.get(id), region, language) : animationCode.get(id)
    assert(containsCode(tokens, anchors, language), `Numeric Animation ${boundary} changed: ${id}`)
  }
  const numericAnimationMethods = ['opacity', 'rotate', 'rotateZ', 'scale', 'scaleX', 'scaleY', 'skew', 'skewX', 'skewY', 'translate', 'translateX', 'translateY']
  const operationDecoder = between(units.animationTimeline.text, 'impl Operation {', '\n    fn apply(')
  assert(containsCode(sourceCode(operationDecoder, 'rust'), [
    '"opacity" | "rotate" | "rotateZ" | "scaleX" | "scaleY" | "skewX" | "skewY" | "translateX" | "translateY" => 1,',
    '"scale" | "skew" | "translate" => 2,',
    '_ => return Err(unsupported("unsupported animation operation")),',
    '.as_f64()', 'render_number(value)?;',
  ], 'rust'), 'Numeric Animation finite operation decoder changed')
  for (const id of ['quickjs', 'v8']) {
    requireAnimation(id, ['self.capture_receiver_transport(serde_json::json!({"kind":"animation-write-snapshot","pageId":page_id.to_string(),"scopes":scopes}))'], 'private write capture', 'fn capture_animation_write_snapshot(')
    const declaration = sourceCode('const MINI_PROGRAM_BOOTSTRAP: &str =', 'rust')
    const declarations = codePositions(animationCode.get(id), declaration, 'rust')
    assert(declarations.length === 1, `Numeric Animation shared facade declaration changed: ${id}`)
    const facade = animationCode.get(id)[declarations[0] + declaration.length]
    assert(facade?.kind === 'string', `Numeric Animation shared facade emission changed: ${id}`)
    assert(containsCode(sourceCode(facade.value), ['const write = __receiver_write_begin(page, paths);', 'finally { __receiver_write_finish(write, writeCompleted); }',
      'const write = __receiver_write_begin(component, paths, source === "setData");', '__receiver_write_finish(write, completed);',
      'const inputIdentity = __receiver_component_input(component);', '__receiver_record_component_snapshot(component, value, instanceToken, mutationRevision, inputIdentity && inputIdentity.writeSnapshot)']), `Numeric Animation successful write and clone prefix changed: ${id}`)
    requireAnimation(id, ['batch.remove("__dataWrites");', '"kind":"data-write-receipts"'], 'private drain receipt')
  }
  const privateReceivers = between(units.environment.text, 'const RECEIVER_INCARNATIONS: &str = r#"', '"#;').slice('const RECEIVER_INCARNATIONS: &str = r#"'.length)
  assert(containsCode(sourceCode(privateReceivers), ['const __receiver_weak = new WeakMap();', 'entry.writeActive++;',
    'if (!completed || entry.retired)', 'write.stamp = __host_string(++entry.writeSequence);',
    'if (!entry || entry.retired || entry.writeActive)', 'record.writeSnapshot = writeSnapshot;',
    'if (!pending || __receiver_value(request, "drainId") !== pending.id)']), 'Numeric Animation private completed-write ledger changed')
  requireAnimation('animationSession', ['.capture_animation_write_snapshot(page.0, &[])', 'WriteSnapshot::from_private(owner, &capture["pageWrites"])?'], 'root write snapshot')
  requireAnimation('animationSession', ['self.animation_bindings.touches(owner, paths, *stamp)', 'self.animation_writes.poison();'], 'receipt reconciliation')
  requireAnimation('runtime', ['self.capture_animation_root_snapshot(page)', 'page.data.clone()'], 'root clone boundary', 'fn load_manifest_view_input(')
  requireAnimation('runtime', ['self.set_animation_root_snapshot(page, Arc::clone(snapshot));',
    'self.collect_animation_bindings(input.page_id, &ast, &ownership)?', 'self.animation_playback.prepare_bindings('], 'evaluated binding consumer', 'fn evaluate_manifest_view_input(')
  for (const id of ['viewLegacy', 'viewModern']) requireAnimation(id, ['bindingTracer(task.data)', 'attributeSources'], 'View evaluator provenance')
  requireAnimation('viewRuntime', ['pub attribute_sources: Vec<Value>,'], 'View provenance transport')
  requireAnimation('irAssembly', ['WxmlAttributeSource'], 'IR provenance export')
  requireAnimation('irMarkup', ['evaluate_wxml_with_templates_and_provenance(', 'context.attribute_sources.borrow().clone()'], 'IR evaluator provenance')
  requireAnimation('irBindingProvenance', ['Expression::Literal(_) => BindingOrigin::literal(),', 'BindingOrigin::unsupported()'], 'IR selected-path provenance')
  requireAnimation('viewExecution', ['validate_attribute_sources(&ast, &attribute_sources)?;'], 'View provenance validation')
  requireAnimation('renderWork', ['result.attribute_sources.clone()', 'self.attribute_sources.insert(scope, source);'], 'cached clone provenance')
  requireAnimation('observerComponents', ['work.input_snapshot(scope)', '.attribute_sources(scope)'], 'occurrence binding collection', 'fn collect_animation_bindings(')
  requireAnimation('observerComponents', ['authentic == *snapshot', 'AnimationWrites::from_private(owner, &proof["writeSnapshot"])?'], 'component clone proof', 'fn authenticate_component_receipt(&mut self, page: PageId, mut receipt: ComponentReceipt')
  requireAnimation('animationBindings', ['previous.descriptor.resolved_paths != resolved_paths', 'stamp: input.scope_snapshot.writes.stamp(path),'], 'equal-write replay')
  requireAnimation('animationBindings', ['forwarded_inputs', 'source.direct_path', 'self.writes.is_local('], 'component forwarding')
  requireAnimation('animationClock', ['self.origin.elapsed()', 'self.turn.set(Some(self.now()));'], 'Session monotonic clock')
  requireAnimation('engineTurn', ['self.animation_clock.begin_turn()', 'self.animation_clock.end_turn(previous_animation_time);'], 'captured turn clock')
  requireAnimation('animationPlayback', ['Some(Program::decode(&descriptor.payload)?)', 'timeline.sample(elapsed)?'], 'typed timeline consumer')
  requireAnimation('animationPlayback', ['run.anchor = run.timeline.as_ref().map(|_| presented_at);'], 'presentation clock anchor', 'fn accept(')
  requireAnimation('animationPlayback', ['run.anchor = None;', 'run.elapsed_offset = run.elapsed(now)?;'], 'hidden-owner pause', 'fn set_visibility(')
  requireAnimation('animationNative', ['self.animation_playback.prepare_sample(page.0, now, input.viewport)?', 'self.skia_backend.prepare_animation_sample('], 'native retained sample')
  requireAnimation('animationNative', ['self.validate_prepared_animations(prepared)?;', 'self.accept_prepared_animations(prepared);'], 'native presentation acceptance', 'fn finish_native_animation_presentation(')
  requireAnimation('renderer', ['let mut root = retained.root.clone();', 'animation::overlay(&mut root, &playback.styles)?;', 'self.resolve_scene('], 'native retained scene', 'fn prepare_animation_sample(')
  requireAnimation('renderer', ['image_cache.prepare(manifest, blobs, &mut root, document, buffer_urls)?', 'style_transforms::prepare_tree(&mut root, viewport)?', '.layout_tree(&mut root, viewport)', 'style_transforms::finish_tree(&mut root, transforms)?;'], 'native ordinary resource/layout pipeline', 'fn resolve_scene(')
  requireAnimation('rendererAnimation', ['sample.occurrence_id.as_str()', 'matrix.affine()?;', '.insert("opacity".into(), opacity.to_string());'], 'native numeric overlay', 'fn overlay(')
  requireAnimation('styleTransforms', ['fn prepare_tree(', 'fn finish_tree(', 'fn animation_origin('], 'shared transform resolution')
  requireAnimation('frameInput', ['consumed_sample: self.committed_animation_sample(revision),'], 'consumed frame proof')
  requireAnimation('devLogicalResize', ['self.validate_prepared_animations(animations)', '*self.slots.native_animations =', '*self.slots.animation_scene = manifest.retained_animation_scene;'], 'logical resize publication')
  for (const [constant, operation] of [['VIEW_ANIMATION_BASELINE', 'view.animation.baseline'], ['VIEW_SAMPLE_PREPARE', 'view.sample.prepare'], ['VIEW_SAMPLE_PRESENTED', 'view.sample.presented'], ['VIEW_SAMPLE_ABORT', 'view.sample.abort']]) {
    requireAnimation('bridgeOperations', [`pub const ${constant}: &str = "${operation}";`], 'bridge operation')
    requireAnimation('browserAnimation', [`op::${constant}`], 'browser operation dispatch', 'fn is_animation_operation(')
  }
  requireAnimation('animationProtocol', ['pub(super) struct ConsumedSample', 'pub(super) struct SampleSubmission', 'pub(super) struct SamplePermit'], 'typed sample wire')
  requireAnimation('browserView', ['animation::validate_template_animations(', 'animation::is_animation_operation('], 'browser template/sample routing')
  requireAnimation('browserAnimation', ['self.animation_playback.prepare_sample(', 'base_geometry_epoch', 'self.accept_prepared_animations('], 'browser retained sample transaction')
  requireAnimation('webHost', ['session.animation_sample_demand_revision()', 'state["sampleDemandRevision"] ='], 'native sample demand')
  requireAnimation('presentationScheduler', ["if (later(current.templateRevision, proof.consumedInput.templateRevision)) return 'template'", "if (later(current.sampleDemandRevision, proof.consumedSample.demandRevision)) return 'paint'"], 'template-before-sample scheduling')
  requireAnimation('domPresenter', ['entry.candidate.animationBaselines(animation.baselines)', 'base.candidate.stageAnimation(submission.styles,', 'window.getComputedStyle(element)'], 'actual DOM baseline and retained overlay')
  requireAnimation('domAnimationSample', ['sameAnimationKey(value.baseKey, baseKey)', 'value.baseGeometryEpoch !== baseGeometryEpoch', 'undo.push(op); op.node.style.setProperty(op.name, op.value, \'important\');'], 'exact DOM sample topology and journal')
  requireAnimation('domSessionClient', ["this.transport.request('view.sample.prepare'", "this.request('view.sample.presented'", 'this.presenter.commitSample(attempt.candidate)'], 'DOM sample publication')
  requireAnimation('workerDOM', ['async preparePaint(demand, accepted, context)', 'this.client.prepareSample(demand.sampleDemandRevision,', 'copyConsumedSample(scheduling?.consumedSample)', '!sameProof(baseProof, this.#acceptedProof)', 'BigInt(baseProof.consumedInput.templateRevision) < BigInt(demand.templateRevision)', '!sameInput(input, baseProof.consumedInput)'], 'Worker retained sample proof')
  for (const id of ['workerRuntime', 'workerBridgeTransport', 'workerSessionClient', 'workerWebSession']) requireAnimation(id, ["'view.sample.abort'"], 'Worker sample lifetime transport')
  requireAnimation('workerRuntime', ["'view.animation.baseline'", "'view.sample.prepare'", "'view.sample.presented'"], 'Worker keyed sample routing')
  const animationFacadeScope = 'Shared bounded action queue with atomic step/export. Session playback accepts only the listed numeric opacity/2D subset; 3D/layout/string-length operations and complete fixed-version playback semantics remain unsupported or unproven. No availability or acceptance promotion.'
  const animationPlaybackScope = 'Private data-write and evaluated binding provenance identifies Page/Component occurrences and equal-value replay. Session-owned monotonic typed timelines sample finite opacity/2D operations; native retained scenes use the normal cascade/layout/resource transaction and recheck live resource authority for each new frame. Web retains exact accepted DOM topology and existing resource leases through numeric style/geometry/ACK transactions, without new resource reads. Presentation acceptance anchors new runs; hidden owners pause and retirement fences stale candidates. The fixed-version replay/lifecycle/transform ordering contract and complete method/parameter/render-profile parity remain incomplete; source evidence is not host acceptance.'
  const animationPlaybackIds = ['animation', 'environment', 'hostInstaller', 'quickjs', 'v8', 'runtime', 'observerComponents', 'browserView', 'renderer', 'webHost', 'domPresenter', 'domSessionClient', 'workerDOM', 'workerRuntime',
    'bridgeOperations', 'viewRuntime', 'viewLegacy', 'viewModern', 'irAssembly', 'irMarkup', 'irBindingProvenance', 'animationBindings', 'animationClock', 'animationTimeline', 'animationProtocol', 'animationPlayback', 'animationSession', 'animationNative', 'browserAnimation', 'frameInput', 'viewExecution', 'renderWork', 'engineTurn', 'devLogicalResize', 'styleTransforms', 'rendererAnimation', 'domAnimationSample', 'presentationScheduler', 'workerBridgeTransport', 'workerSessionClient', 'workerWebSession']
  const groups = [
    { constructor: 'wx.createIntersectionObserver', receiver: 'IntersectionObserver', function: '__container_intersection_observer', methods: ['observe', 'relativeTo', 'relativeToViewport'], ids: ['runtime', 'observers', 'quickjs', 'v8'], scope: 'Core intersection observers, scope and disconnect lifetime', missing: ['fullLockedParameterScope'] },
    { constructor: 'wx.createAnimation', receiver: 'Animation', source: 'animation', function: '__container_animation', methods: catalog.apis.filter(api => api.receiver === 'Animation').map(api => api.name.split('.').at(-1)), ids: ['animation', 'environment', 'quickjs', 'v8'], scope: animationFacadeScope, missing: [] },
  ]
  for (const group of groups) {
    const blocks = group.source ? [units[group.source].text] : ['quickjs', 'v8'].map(id => functionBlock(units[id].text, group.function))
    if (group.source) {
      assert(units.environment.text.includes(`include_str!("${group.source}.js")`), `Shared ${group.receiver} installation changed`)
      for (const id of ['quickjs', 'v8']) assert(units[id].text.includes('createAnimation: __container_create_animation'), `Shared Animation engine facade changed: ${id}`)
    }
    for (const method of group.methods) {
      assert(blocks.every(block => block.includes(`${method}: function`) || block.includes(`api.${method} = function`) || group.source && block.includes(`"${method}"`)), `Core method ${group.receiver}.${method} changed; review both engines`)
      add(`object:${group.receiver}.${method}`, 'runtimeImplementation', group.ids, group.scope, group.missing)
    }
    if (group.constructor) add(group.constructor, 'runtimeImplementation', group.ids, group.scope, group.missing)
  }
  for (const name of ['wx.createAnimation', ...catalog.apis.filter(api => api.receiver === 'Animation').map(api => api.name)]) {
    const playback = name === 'wx.createAnimation' || ['step', 'export', ...numericAnimationMethods].includes(name.split('.').at(-1))
    add(name, 'runtimeImplementation', playback ? animationPlaybackIds : ['animation', 'environment', 'quickjs', 'v8'], playback ? animationPlaybackScope : null,
      playback ? ['animationFullPlaybackContract', 'animationFixedVersionReplayLifecycleParity'] : ['rendererAnimationPlayback'])
  }

  const canvasMethods = ['setFillStyle', 'setStrokeStyle', 'setLineWidth', 'setGlobalAlpha', 'setFontSize', 'setLineDash', 'setLineCap', 'setLineJoin', 'setMiterLimit', 'setShadow', 'setTextAlign', 'setTextBaseline', 'fillRect', 'strokeRect', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'rect', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'save', 'restore', 'translate', 'rotate', 'scale', 'quadraticCurveTo', 'bezierCurveTo']
  const canvasProperties = ['fillStyle', 'strokeStyle', 'lineWidth', 'globalAlpha', 'lineCap', 'lineDashOffset', 'lineJoin', 'miterLimit']
  assert(units.environment.text.includes('include_str!("canvas.js")'), 'Shared Canvas installation changed')
  for (const engine of ['quickjs', 'v8']) assert(units[engine].text.includes('createCanvasContext: __container_canvas_context') && units[engine].text.includes('createOffscreenCanvas: __container_create_offscreen_canvas'), `Shared Canvas engine facade changed: ${engine}`)
  const canvasWrapper = functionBlock(units.canvas.text, '__container_canvas_context')
  assert(containsAll(canvasWrapper, ['__container_capability("wx.createCanvasContext") === "unsupported"', 'throw __container_error("wx.createCanvasContext", "unsupported");', 'const id = String(canvasId || "");', 'return __container_canvas_context_impl(id, null, __container_owned_canvases.context(id, component));']), 'Canvas public owner-capture delegation changed')
  const canvasImplementation = functionBlock(units.canvas.text, '__container_canvas_context_impl')
  const canvasDashPreparation = between(units.canvasBatch.text, '            "setLineDash" => {', '            "setLineCap" => {')
  assert(containsAll(canvasDashPreparation, ['.map(|_| canvas_arg_f32(command, 1))', 'Self::SetLineDash {\n                    pattern: dash,\n                    offset,\n                }']), 'Canvas dash offset preparation changed')
  const canvasStrokeDescriptors = {
    lineCap: 'lineCap: { get: function() { return state.drawing.lineCap; }, set: function(value) { command("setLineCap", [value]); } }',
    lineJoin: 'lineJoin: { get: function() { return state.drawing.lineJoin; }, set: function(value) { command("setLineJoin", [value]); } }',
    miterLimit: 'miterLimit: { get: function() { return state.drawing.miterLimit; }, set: function(value) { command("setMiterLimit", [value]); } }',
    lineDashOffset: 'lineDashOffset: { get: function() { return state.drawing.lineDashOffset; }, set: function(value) { command("setLineDash", [state.drawing.lineDash, value]); } }',
  }
  const canvasStrokeProperties = {
    lineCap: ['case "setLineCap": drawing.lineCap = args[0]; break;', 'Self::SetLineCap(parse_canvas_line_cap(canvas_arg_string(command, 0)?)?)', 'PreparedCanvasCommand::SetLineCap(cap) => state.line_cap = *cap,', 'cap: state.line_cap,', 'match style.cap', 'paint.set_stroke_cap(match state.line_cap {'],
    lineJoin: ['case "setLineJoin": drawing.lineJoin = args[0]; break;', 'Self::SetLineJoin(parse_canvas_line_join(canvas_arg_string(command, 0)?)?)', 'PreparedCanvasCommand::SetLineJoin(join) => state.line_join = *join,', 'join: state.line_join,', 'style.join == CanvasLineJoin::Miter', 'paint.set_stroke_join(match state.line_join {'],
    miterLimit: ['case "setMiterLimit": drawing.miterLimit = args[0]; break;', '"setMiterLimit" => Self::SetMiterLimit(canvas_arg_f32(command, 0)?.max(0.0)),', 'PreparedCanvasCommand::SetMiterLimit(limit) => state.miter_limit = *limit,', 'miter_limit: state.miter_limit,', 'radius * f64::from(style.miter_limit)', 'paint.set_stroke_miter(state.miter_limit);'],
    lineDashOffset: ['case "setLineDash": drawing.lineDash = args[0]; drawing.lineDashOffset = args[1]; break;', 'offset: f32,', 'state.line_dash_offset = *offset;', 'dash_offset: state.line_dash_offset,', 'Dash::new(style.dash, style.dash_offset)', 'skia::PathEffect::dash(&state.line_dash, state.line_dash_offset)'],
  }
  for (const [property, [record, prepared, replay, software, stroke, native]] of Object.entries(canvasStrokeProperties)) {
    assert(canvasImplementation.includes(record) && units.canvasBatch.text.includes(prepared) && units.canvasRaster.text.includes(replay) && units.canvasService.text.includes(replay) && units.canvasRaster.text.includes(software) && units.canvasStroke.text.includes(stroke) && units.canvasService.text.includes(native), `Canvas stroke property implementation changed: ${property}`)
  }
  for (const name of ['wx.createCanvasContext', ...[...canvasMethods, ...canvasProperties, 'draw'].map(method => `object:CanvasContext.${method}`)]) {
    {
      const block = canvasImplementation, method = name.split('.').at(-1)
      const present = name === 'wx.createCanvasContext' || (canvasMethods.includes(method)
        ? block.includes(`"${method}"`)
        : method === 'draw' ? block.includes('api.draw = function') : new RegExp(`^    ${method}: \\{`, 'm').test(block))
      assert(present && (!canvasStrokeDescriptors[method] || block.includes(canvasStrokeDescriptors[method])), `Canvas facade changed: ${name}`)
    }
    add(name, 'jsFacade', ['canvas', 'environment', 'quickjs', 'v8'], 'Shared bounded legacy 2D command/property facade; successful admission consumes each command once and failed admission retains the prefix; unlisted CanvasContext members remain missing', ['fullCanvasContract'])
    add(name, 'runtimeImplementation', ['runtime', 'renderer', 'canvasBatch', 'canvasService', 'canvasRaster', 'canvasStroke'], 'Atomically validated Canvas batch replay and surface snapshot; shared stroke state reaches software and native raster consumers, but complete Canvas parameters, Web page paint and lifecycle remain incomplete', ['fullCanvasContract'])
  }
  for (const name of ['wx.createOffscreenCanvas', 'object:OffscreenCanvas.getContext', 'object:OffscreenCanvas.width', 'object:OffscreenCanvas.height']) add(name, 'jsFacade', ['canvas', 'environment', 'quickjs', 'v8'], 'Stable owner-local 2d context identity; size range [0, 16384]; complete resize reset, immediate bitmap semantics and image factory remain missing', ['fullOffscreenCanvasContract'])

  // Review these three members independently from the general Canvas/factory
  // scope. Concrete replay is present; finite-f32 and fixed-version coverage
  // gaps retain Partial and do not establish any SDK acceptance.
  const canvasAffineMembers = {
    setTransform: ['canvasSetTransformNativeScalarRangeParity'],
    transform: ['canvasTransformNativeScalarRangeParity', 'canvasTransformComposedMatrixRangeParity'],
    clip: ['canvasClipFixed3173EdgeCoverageReview'],
  }
  const canvasMatrixParameters = ['scaleX', 'skewX', 'skewY', 'scaleY', 'translateX', 'translateY']
    .map(name => ({ name, type: 'number', optional: false }))
  for (const method of Object.keys(canvasAffineMembers)) {
    const api = catalog.apis.find(api => api.name === `object:CanvasContext.${method}`)
    const signatures = [{ parameters: method === 'clip' ? [] : canvasMatrixParameters, returns: 'void' }]
    assert(api?.receiver === 'CanvasContext' && javascriptShape(api.signatures) === javascriptShape(signatures), `Canvas affine locked signature changed: ${method}`)
  }
  const affineCanvasProgram = javascriptProgram(units.canvas.text)
  assert(javascriptDirectStatement(affineCanvasProgram, `const __container_canvas_intrinsics = (function() {
    const define = Object.defineProperty;
    return {
      isArray: Array.isArray,
      descriptor: Object.getOwnPropertyDescriptor,
      hasOwn: Function.prototype.call.bind(Object.prototype.hasOwnProperty),
      append: function(array, value) {
        define(array, array.length, {__proto__:null, value:value, writable:true, enumerable:true, configurable:true});
      },
      finite: Number.isFinite,
      fround: Math.fround
    };
  })();`), 'Canvas affine intrinsic captures changed')
  const affineCanvasAst = affineCanvasProgram.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === '__container_canvas_context_impl')
  assert(affineCanvasAst && javascriptDirectStatement(affineCanvasAst.body,
    '["setTransform", "transform", "clip"].forEach(function(name) { api[name] = function() { command(name, arguments); }; });'), 'Canvas affine void facade changed')
  assert(javascriptDirectStatement(affineCanvasAst.body, `function scalar(value) {
    if (typeof value !== "number" || !__container_canvas_intrinsics.finite(value)
        || !__container_canvas_intrinsics.finite(__container_canvas_intrinsics.fround(value)))
      invalid("canvas state requires a finite native scalar");
    return value;
  }`), 'Canvas affine scalar validation changed')
  const affineNormalize = affineCanvasAst.body.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'normalize')
  assert(affineNormalize && containsCode(sourceCode(units.canvas.text.slice(affineNormalize.start, affineNormalize.end)), [
    'if (op === "setTransform" || op === "transform") {',
    'if (args.length < 6) invalid("canvas transform requires six scalars");',
    'for (let index = 0; index < 6; index += 1) scalar(args[index]);',
  ]), 'Canvas affine finite scalar admission changed')
  const canvasCode = Object.fromEntries(['canvasArcTo', 'canvasBatch', 'canvasClip', 'canvasRaster', 'canvasService', 'canvasStroke']
    .map(id => [id, sourceCode(units[id].text, 'rust')]))
  const requireCanvasCode = (id, anchors, boundary, signature) => {
    const code = (Array.isArray(signature) ? signature : signature ? [signature] : [])
      .reduce((code, signature) => codeBlock(code, signature, 'rust'), canvasCode[id])
    assert(containsCode(code, anchors, 'rust'), `Canvas affine ${boundary} changed: ${id}`)
  }
  requireCanvasCode('canvasBatch', ['SetTransform([f32; 6]),', 'Transform([f32; 6]),', '"setTransform" => Self::SetTransform(numbers(command)?),',
    '"transform" => Self::Transform(numbers(command)?),', '"clip" => Self::Clip,'], 'typed decoder')
  requireCanvasCode('canvasBatch', ['super::validate_canvas_geometry(&mut commands, frame.width, frame.height)?;'], 'preflight before replay', 'fn prepare_batches(')
  requireCanvasCode('canvasRaster', ['clips.admit(command)?;', 'if apply_canvas_state_command(&mut state, command)',
    '.any(|value| !value.is_finite())', '"canvas transform exceeds finite scalar limits"',
    'charge_product(&mut work, pixels + 1, state.path.vertices as u64 + 1)?;'], 'bounded preflight', 'fn validate_canvas_geometry(')
  requireCanvasCode('canvasRaster', ['PreparedCanvasCommand::SetTransform(values) => { state.transform = CanvasTransform::from_values(*values); }',
    'PreparedCanvasCommand::Transform(values) => { state.transform = state.transform.multiply(CanvasTransform::from_values(*values)); }'], 'portable affine replay', 'fn apply_canvas_state_command(')
  requireCanvasCode('canvasRaster', ['fn from_values([a, b, c, d, e, f]: [f32; 6]) -> Self', 'Self { a, b, c, d, e, f }'], 'positional matrix decode', 'impl CanvasTransform')
  requireCanvasCode('canvasRaster', ['x: self.a * point.x + self.c * point.y + self.e,',
    'y: self.b * point.x + self.d * point.y + self.f,'], 'portable point mapping', ['impl CanvasTransform', 'fn apply('])
  requireCanvasCode('canvasRaster', ['skia_safe::Matrix::new_all(self.a, self.c, self.e, self.b, self.d, self.f, 0.0, 0.0, 1.0,)'], 'native matrix mapping', ['impl CanvasTransform', 'fn native('])
  requireCanvasCode('canvasRaster', ['a: self.a * other.a + self.c * other.b,', 'b: self.b * other.a + self.d * other.b,',
    'c: self.a * other.c + self.c * other.d,', 'd: self.b * other.c + self.d * other.d,',
    'e: self.a * other.e + self.c * other.f + self.e,', 'f: self.b * other.e + self.d * other.f + self.f,'], 'ordered matrix composition', ['impl CanvasTransform', 'fn multiply('])
  requireCanvasCode('canvasRaster', ['PreparedCanvasCommand::Clip => { state.clip = Some(canvas_clip::intersect(&state.path, state.clip.as_deref(), frame.width, frame.height,)); }'],
    'portable clip replay', 'fn rasterize_prepared_canvas(')
  requireCanvasCode('canvasRaster', ['clip: self.clip.clone(),', 'self.clip = saved.clip;', 'PreparedCanvasCommand::ResetState => *state = CanvasRasterState::default(),'], 'saved clip and reset')
  requireCanvasCode('canvasClip', ['PreparedCanvasCommand::Save => self.saved.push(self.current),', 'self.current = saved;',
    'if (live + 2) * self.mask_bytes > PreparedCanvasBatch::MAX_CLIP_BYTES', 'self.current = None;', 'self.saved.clear();'], 'live mask budget')
  requireCanvasCode('canvasClip', ['for contour in &path.subpaths', 'contour[(index + 1) % contour.len()]', 'winding += 1;', 'winding -= 1;', 'winding != 0'], 'nonzero closed contours', 'fn contains(')
  requireCanvasCode('canvasClip', ['if allows(previous, index) && contains(path, f64::from(x) + 0.5, f64::from(y) + 0.5)',
    'mask[index / 64] |= 1 << (index % 64);'], 'pixel center intersection', 'fn intersect(')
  requireCanvasCode('canvasRaster', ['canvas_clip::allows(clip, y as usize * width as usize + x as usize)'], 'polygon clip sink', 'fn draw_canvas_polygon(')
  requireCanvasCode('canvasRaster', ['canvas_clip::allows(clip, y as usize * width as usize + x as usize)'], 'clear clip sink', 'fn clear_canvas_polygon(')
  requireCanvasCode('canvasRaster', ['draw_canvas_polygon(pixels, width, height, &rect, color, state.clip.as_deref());'], 'text clip sink', 'fn canvas_text(')
  requireCanvasCode('canvasStroke', ['if !super::canvas_clip::allows(clip, y as usize * width as usize + x as usize)'], 'stroke clip sink', 'fn draw(')
  requireCanvasCode('canvasService', ['let initial_save_count = canvas.save_count();', 'let initial_matrix = canvas.local_to_device();',
    'PreparedCanvasCommand::SetTransform(values) => { state.transform = CanvasTransform::from_values(*values); canvas.set_matrix(&initial_matrix); canvas.concat(&state.transform.native()); }',
    'PreparedCanvasCommand::Transform(values) => { let transform = CanvasTransform::from_values(*values); canvas.concat(&transform.native()); state.transform = state.transform.multiply(transform); }',
    'let matrix = canvas.local_to_device(); canvas.set_matrix(&initial_matrix); canvas.clip_path(&path.clone().detach(), None, true); canvas.set_matrix(&matrix);',
    'canvas.restore_to_count(initial_save_count); canvas.set_matrix(&initial_matrix); result'], 'native caller guard and replay', 'fn execute_native_canvas(')
  for (const [method, missing] of Object.entries(canvasAffineMembers)) {
    const name = `object:CanvasContext.${method}`
    const scope = method === 'clip'
      ? 'Legacy zero-argument void current-path nonzero clip with implicit closure, intersection, construction-time path CTM, saved/restored coverage and draw-boundary reset. Software uses bounded one-bit pixel-center masks; native Skia uses antialiased clip_path inside the caller guard. Fixed 3.17.3 edge coverage remains unreviewed; no evenodd or Path2D overload is required by the locked declaration. No availability or acceptance promotion.'
      : `Legacy six-required-number void ${method === 'setTransform' ? 'replacement of the guest CTM while preserving the caller baseline' : 'current-times-incoming CTM composition'} in a copied, bounded transactional command queue. Scalars and composed geometry use finite f32, which does not cover the full JavaScript number range/precision; transform overflow rejects the batch. Static 3.17.3 evidence supports positional a,b,c,d,e,f order, not complete invalid/error parity. No availability or acceptance promotion.`
    add(name, 'jsFacade', ['canvas', 'environment', 'quickjs', 'v8'], scope, missing)
    add(name, 'runtimeImplementation', ['runtime', 'renderer', 'canvasBatch', 'canvasService', 'canvasRaster', 'canvasStroke', ...(method === 'clip' ? ['canvasClip'] : [])], scope, missing)
  }

  const arcToApi = catalog.apis.find(api => api.name === 'object:CanvasContext.arcTo')
  const arcToSignatures = [{ parameters: ['x1', 'y1', 'x2', 'y2', 'radius']
    .map(name => ({ name, type: 'number', optional: false })), returns: 'void' }]
  assert(arcToApi?.receiver === 'CanvasContext' && javascriptShape(arcToApi.signatures) === javascriptShape(arcToSignatures),
    'Canvas arcTo locked signature changed')
  assert(javascriptDirectStatement(affineCanvasAst.body, 'api.arcTo = function() { command("arcTo", arguments); };'),
    'Canvas arcTo void facade changed')
  assert(containsCode(sourceCode(units.canvas.text.slice(affineNormalize.start, affineNormalize.end)), [
    'if (op === "arcTo") {', 'if (args.length < 5) invalid("canvas arcTo requires five scalars");',
    'for (let index = 0; index < 5; index += 1) scalar(args[index]);',
    'if (args[4] < 0) invalid("canvas arcTo radius must be non-negative");',
  ]), 'Canvas arcTo scalar admission changed')
  const requireArcToCode = (id, anchors, signature) => {
    const code = signature ? codeBlock(canvasCode[id], signature, 'rust') : canvasCode[id]
    assert(containsCode(code, anchors, 'rust'), `Canvas arcTo executable boundary changed: ${id}`)
  }
  requireArcToCode('canvasBatch', ['PendingArcTo([f32; 5]),', 'ConicArcTo(super::canvas_arcto::TangentArc),',
    'if angle(command, 4)? < 0.0', 'Self::PendingArcTo(values)'])
  requireArcToCode('canvasRaster', ['if let PreparedCanvasCommand::PendingArcTo(values) = command',
    '*command = canvas_arcto::lower(*values, state.path.current_point(), state.transform)?;'], 'fn validate_canvas_geometry(')
  requireArcToCode('canvasArcTo', ['let determinant = a * d - b * c;', 'if determinant == 0.0 || !determinant.is_finite()',
    'Ok(PreparedCanvasCommand::ConicArcTo(TangentArc {', 'start: map(start)?,', 'control: map(p1)?,', 'end: map(end)?,', 'weight,'], 'fn lower(')
  requireArcToCode('canvasArcTo', ['if path.too_complex', 'if depth == 12', 'path.too_complex = true;',
    'path.line_to(arc.start);', 'flatten(', 'f64::from(arc.control.x) * w,'], 'fn append(')
  requireArcToCode('canvasRaster', ['PreparedCanvasCommand::ConicArcTo(arc) => canvas_arcto::append(&mut state.path, *arc),'], 'fn apply_canvas_path_command(')
  requireArcToCode('canvasService', ['PreparedCanvasCommand::ConicArcTo(arc) => {',
    'path.line_to((arc.start.x, arc.start.y));', 'path.conic_to((arc.control.x, arc.control.y), (arc.end.x, arc.end.y), arc.weight,);'], 'fn execute_native_canvas(')
  const arcToMissing = ['canvasArcToNativeScalarRangeParity', 'canvasArcToInvertibleTransformScope',
    'canvasArcToBoundedConicScope', 'canvasArcToFixed3173ErrorParity']
  const arcToScope = 'Legacy five-required-number void arcTo with one-time shared preflight lowering from the construction-time affine current endpoint to a positive rational conic. Portable bounded homogeneous subdivision and native Skia conic replay share tangents and weight; existing clip, caller guard, save/restore and transactional reserve boundaries apply. Finite-f32 input/storage, required invertible CTM, positive representable weights and bounded subdivision limit parameter scope. Negative-radius error behavior and fixed 3.17.3 raster agreement remain unproven. No availability or acceptance promotion.'
  add('object:CanvasContext.arcTo', 'jsFacade', ['canvas', 'environment', 'quickjs', 'v8'], arcToScope, arcToMissing)
  add('object:CanvasContext.arcTo', 'runtimeImplementation', ['runtime', 'renderer', 'canvasArcTo', 'canvasBatch', 'canvasService', 'canvasRaster', 'canvasStroke', 'canvasClip'], arcToScope, arcToMissing)

  assert(units.environment.sha256 === reviewedEnvironmentSha256,
    'Shared private turn scheduler installation or retained capture changed; reviewed host_environment.rs bytes require review')
  // Exact AST identity of the reviewed JavaScript units preserves ASI and
  // other grammar semantics. It is computed from original source bytes and
  // ignores only location metadata and Literal.raw spelling. Template raw
  // strings, regular expressions and directives remain semantic AST fields.
  for (const [ast, expected, boundary] of [
    [schedulerAst, reviewedJavaScriptShapes.scheduler, 'Private turn scheduler executable control flow'],
    [installerAst, reviewedJavaScriptShapes.installer, 'Trusted turn scheduler installer control flow'],
    [lifecycleAst, reviewedJavaScriptShapes.lifecycle, 'Trusted turn scheduler lifecycle control flow'],
  ]) assert(javascriptShape(ast) === expected, `${boundary} changed; source evidence requires review`)
  // Exact source identity deliberately includes Rust syntax outside method
  // bodies. Lexical anchors above remain useful change diagnostics, without
  // claiming control-flow, name-binding or compiled-emission equivalence.
  for (const [id, boundary] of [
    ['quickjs', 'QuickJS retained turn scheduler'],
    ['v8', 'V8 retained turn scheduler'],
    ['runtime', 'Session runtime scheduler'],
    ['runtimeTurnScheduler', 'Session retained idle scheduler'],
  ]) assert(units[id].sha256 === reviewedSchedulerRustSha256[id],
    `${boundary} Rust source bytes changed; source evidence requires review`)

  return {
    sources: Object.fromEntries(Object.entries(units).map(([id, { text, ...entry }]) => [id, entry])), apis,
    forHost(host, name) {
      const tabBar = tabBarForHost(host, name)
      if (tabBar) return tabBar
      if (host === 'windows' && name === 'object:Stats.mode') {
        const entry = nativeFileApis.get(name)
        return { ...entry, missing: ['windowsNativeModeSnapshot'], scopes: [...entry.scopes, 'Windows still synthesizes 040700/100600 from directory identity and does not provide the complete locked file type/permission snapshot; this remains Partial'] }
      }
      if (name === 'object:IntersectionObserver.disconnect') {
        const entry = apis.get(name)
        if (host === 'web') return { ...entry, sources: [...entry.sources, { id: 'browserView', role: 'runtimeBridge' }, { id: 'webHost', role: 'runtimeBridge' }], scopes: [...entry.scopes, 'Web Software/ExternalFrame/CanvasKit Skia routes share cleanup, but the supported WebView/DOM route disables observer creation until a browser observer adapter exists'], missing: ['browserIntersectionObserverAdapter'] }
        if (['android', 'ios', 'harmony', 'macos', 'windows', 'linux'].includes(host)) return { ...entry, sources: [...entry.sources, ...['nativeProvider', 'sdkFfi', 'renderProfiles'].map(id => ({ id, role: 'runtimeImplementation' }))], scopes: [...entry.scopes, 'Public native SDK Session defaults admit Skia/SkylineCompat and reject WebView; disconnect requires no OS provider. Factory capability remains Partial; per-platform execution and acceptance are separate'] }
      }
      return ['android', 'ios', 'harmony', 'macos', 'windows', 'linux'].includes(host) && nativeFileApis.has(name)
        ? nativeFileApis.get(name) : apis.get(name)
    },
  }
}
