import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { inventoryCoreApis } from './core-api-inventory.mjs'
import { cellAcceptance, resolveImplementation } from './host-api-matrix.mjs'

const read = path => readFile(new URL('../'+path, import.meta.url), 'utf8')
const catalog = JSON.parse(await read('crates/container-runtime/src/host-api-catalog.json'))
const partialNotificationEvents = ['AfterPageLoad', 'AppRouteDone', 'BeforePageLoad', 'CopyUrl',
  'EmbeddedMiniProgramHeightChange', 'LazyLoadError', 'MenuButtonBoundingClientRectWeightChange',
  'ParallelStateChange', 'UserOffTranslation', 'UserTriggerTranslation']
const ordinaryNotificationEvents = ["ApiCategoryChange", "AudioInterruptionBegin", "AudioInterruptionEnd", "KeyboardHeightChange", "LocalServiceDiscoveryStop", "LocalServiceFound", "LocalServiceLost", "LocalServiceResolveFail", "MemoryWarning", "ScreenRecordingStateChanged", "ThemeChange", "VoIPChatInterrupted", "VoIPChatMembersChanged", "VoIPChatSpeakersChanged", "VoIPChatStateChanged", "VoIPVideoMembersChanged", "BatteryInfoChange", "BLEPeripheralConnectionStateChanged", "DeviceMotionChange", "NetworkWeakChange"]
const ordinaryNotificationNames = new Set(ordinaryNotificationEvents.flatMap(event => [`wx.on${event}`, `wx.off${event}`]))
const finiteNotificationEvents = [...partialNotificationEvents, ...ordinaryNotificationEvents]
const finiteNotificationOffNames = finiteNotificationEvents.map(event => `wx.off${event}`)
const finiteNotificationOnNames = finiteNotificationEvents.map(event => `wx.on${event}`)
const finiteNotificationNames = new Set([...finiteNotificationOffNames, ...finiteNotificationOnNames])
const objectNotificationPairs = [["TCPSocket", "BindWifi"], ["TCPSocket", "Close"], ["TCPSocket", "Connect"], ["TCPSocket", "Error"], ["TCPSocket", "Message"], ["UDPSocket", "Close"], ["UDPSocket", "Error"], ["UDPSocket", "Listening"], ["UDPSocket", "Message"]]
const objectNotificationOffNames = new Set(objectNotificationPairs.map(([receiver,event]) => `object:${receiver}.off${event}`))
const performanceNames = new Set(['wx.getPerformance', ...['getEntries', 'getEntriesByName', 'getEntriesByType', 'setBufferSize', 'createObserver'].map(member => `object:Performance.${member}`), ...['observe', 'disconnect', 'supportedEntryTypes'].map(member => `object:PerformanceObserver.${member}`), ...['getEntries', 'getEntriesByName', 'getEntriesByType'].map(member => `object:EntryList.${member}`)])
const reviewedSourceScopeUpdates = performanceNames
const { parse: parseJavaScript } = createRequire(new URL('../tools/container-manifest/package.json', import.meta.url))('acorn')

// Every negative fixture must change a known live anchor. A stale replacement
// must fail the test instead of accidentally accepting an unchanged source.
function changedRead(target, before, after, expected = 1) {
  return async path => {
    const source = await read(path)
    if (path !== target) return source
    assert.equal(source.split(before).length - 1, expected, `negative fixture anchor count: ${target}: ${before}`)
    assert.notEqual(before, after)
    return source.replaceAll(before, after)
  }
}

test('source inventory includes both engines, concrete core functions and caller-supplied snapshot provenance', async () => {
  const result = await inventoryCoreApis(catalog, read)
  assert.equal(Object.keys(result.sources).length, 134)
  assert(result.apis.get('wx.setStorageSync').sources.some(source => source.role === 'runtimeImplementation'))
  assert(result.apis.get('wx.getDeviceInfo').sources.some(source => source.role === 'runtimeBridge'))
  assert(result.apis.get('wx.getDeviceInfo').sources.some(source => source.role === 'callerSuppliedProvider'))
  assert.deepEqual(result.apis.get('wx.getDeviceInfo').missing, ['fullDeviceSnapshotFields'])
  assert(result.apis.get('wx.getDeviceInfo').sources.some(source => source.id === 'nativeProvider' && source.role === 'runtimeImplementation'))
  for (const name of ['wx.getWindowInfo', 'wx.getMenuButtonBoundingClientRect']) {
    assert.deepEqual(result.apis.get(name).missing, [])
    assert(result.apis.get(name).sources.some(source => source.id === 'geometry' && source.role === 'runtimeImplementation'))
    assert(result.apis.get(name).sources.some(source => source.id === 'nativeProvider'))
  }
  assert.deepEqual(result.apis.get('wx.getSystemInfoSync').missing, ['fullSystemSnapshotFields'])
  for (const name of ['wx.getSystemInfo', 'wx.getSystemInfoAsync']) {
    assert.deepEqual(result.apis.get(name).missing, ['fullSystemSnapshotFields'])
    assert(result.apis.get(name).sources.some(source => source.id === 'asyncHost' && source.role === 'runtimeImplementation'))
    assert(result.apis.get(name).sources.some(source => source.id === 'quickjs'))
    assert(result.apis.get(name).sources.some(source => source.id === 'v8'))
  }
  assert.deepEqual(result.apis.get('wx.getSystemSetting').missing, ['radioSystemSettings'])
  assert.deepEqual(result.apis.get('wx.getLaunchOptionsSync').missing, [])
  assert.deepEqual(result.apis.get('wx.getAccountInfoSync').missing, [])
  assert(result.apis.get('wx.getAccountInfoSync').sources.some(source => source.id === 'hostServices' && source.role === 'runtimeImplementation'))
  assert(!result.apis.get('wx.getAccountInfoSync').sources.some(source => source.role === 'callerSuppliedProvider'))
  assert(!Object.values(result.sources).some(source => source.path.includes('sandbox')))
  for (const name of ['wx.arrayBufferToBase64', 'wx.base64ToArrayBuffer']) {
    assert.equal(catalog.apis.find(api => api.name === name).kind, 'syncLocal')
    assert.deepEqual(result.apis.get(name).missing, [])
    assert.deepEqual(result.apis.get(name).sources.map(source => source.id), ['boundary', 'quickjs', 'v8'])
  }
})

test('storage transactions retain exact encryption and documented JSON scope gaps', async () => {
  const result = await inventoryCoreApis(catalog, read)
  const plain = ['storageJsonStringParity', 'storageBoundedValueScope', 'storagePlainAccountingParity']
  const gaps = {
    'wx.setStorage': ['storageEncryptionAndPairedFlags', 'storageEncryptedQuotas', ...plain],
    'wx.getStorage': ['storageDecryptionAndPairedFlags'],
    'wx.setStorageSync': plain,
    'wx.batchSetStorage': plain,
    'wx.batchSetStorageSync': plain,
  }
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) {
    for (const [name, missing] of Object.entries(gaps)) {
      const entry = result.forHost(host, name)
      assert.deepEqual(entry.missing, missing)
      assert(entry.sources.some(source => source.id === 'storageTransactions' && source.role === 'runtimeImplementation'))
    }
    for (const name of ['wx.clearStorage', 'wx.clearStorageSync', 'wx.getStorageInfo', 'wx.getStorageInfoSync', 'wx.getStorageSync', 'wx.removeStorage', 'wx.removeStorageSync']) assert.deepEqual(result.forHost(host, name).missing, [])
    for (const name of ['wx.batchGetStorage', 'wx.batchGetStorageSync']) assert(!result.forHost(host, name)?.sources.some(source => source.role === 'runtimeImplementation'))
  }
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/storage_transactions.rs') ? (await read(path)).replace('.apply_storage_transaction(operations)', '.missing_storage_transaction(operations)') : read(path)), /Storage core commit ownership changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/storage_transactions.rs') ? (await read(path)).replace('fn reconcile_engine_storage(', 'fn missing_reconcile_engine_storage(') : read(path)), /Storage-only reconciliation changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path === 'Cargo.toml' ? (await read(path)).replace('features = ["float_roundtrip"]', 'features = []') : read(path)), /Storage JSON Number preservation changed/)
})

test('shared console is counted through actual bootstrap and native drain without inferring receiver members', async () => {
  const result = await inventoryCoreApis(catalog, read)
  for (const method of ['debug', 'error', 'info', 'log', 'warn', 'group', 'groupEnd']) {
    const entry = result.forHost('web', `object:Console.${method}`)
    assert.deepEqual(entry.missing, [])
    assert(entry.sources.some(source => source.id === 'console' && source.role === 'runtimeImplementation'))
    assert(entry.sources.some(source => source.id === 'environment'))
  }
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/host_environment.rs') && path.includes('container-core') ? (await read(path)).replace('include_str!("dev-console.js")', 'include_str!("removed-console.js")') : read(path)), /Shared console environment installation/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.includes('container-engine-v8') ? (await read(path)).replace('batch.console = __dev_console();', '') : read(path)), /Shared console engine transport changed: v8/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/dev-console.js') ? (await read(path)).replace("data(console, 'groupEnd', function(", "data(console, 'removedGroupEnd', function(") : read(path)), /Shared console method missing: groupEnd/)
})

test('native file producers and Stats metadata retain scope gaps while exact predicates cannot promote Web', async () => {
  const result = await inventoryCoreApis(catalog, read)
  const methods = ['accessSync', 'appendFileSync', 'copyFileSync', 'mkdirSync', 'readFileSync', 'readdirSync', 'renameSync', 'rmdirSync', 'statSync', 'unlinkSync', 'writeFileSync']
  for (const member of [...methods.map(method => `FileSystemManager.${method}`), ...['isDirectory', 'isFile', 'lastAccessedTime', 'lastModifiedTime', 'mode', 'size'].map(method => `Stats.${method}`)]) {
    const name = `object:${member}`
    for (const host of ['android', 'ios', 'harmony', 'macos', 'windows', 'linux']) {
      const entry = result.forHost(host, name)
      assert(entry.sources.some(source => source.id === 'syncFiles' && source.role === 'runtimeImplementation'))
      const missing = member.startsWith('Stats.')
        ? member === 'Stats.mode' && host === 'windows' ? ['windowsNativeModeSnapshot'] : []
        : ['fullLockedFileParameterScope']
      assert.deepEqual(entry.missing, missing)
    }
    assert(!result.forHost('web', name)?.sources.some(source => source.id === 'syncFiles'))
  }
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/sync_files.rs') ? (await read(path)).replace('"readFileSync" => {', '"removedReadFile" => {') : read(path)), /Synchronous managed file implementation missing: readFileSync/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.includes('container-sdk') ? (await read(path)).replace('session.bind_sync_host_api(', 'session.removed_sync_host_api(') : read(path)), /Native managed synchronous file installation/)
})

test('native codec dependency preserves all24 Partial states and never adds a Web implementation', async () => {
  const result = await inventoryCoreApis(catalog, read)
  assert.equal(result.sources.syncCodecs.path, 'crates/container-runtime/src/sync_file_codecs.rs')
  for (const method of ['appendFileSync', 'readFileSync', 'writeFileSync', 'writeSync']) {
    const name = `object:FileSystemManager.${method}`, api = catalog.apis.find(api => api.name === name)
    for (const host of ['android', 'ios', 'harmony', 'macos', 'windows', 'linux']) {
      const entry = result.forHost(host, name)
      assert(entry.sources.some(source => source.id === 'syncCodecs' && source.role === 'runtimeImplementation'))
      assert.deepEqual(entry.missing, ['fullLockedFileParameterScope'])
      assert.equal(resolveImplementation({ api, core: entry }).implementationState, 'partial')
    }
    assert(!result.forHost('web', name)?.sources.some(source => source.id === 'syncCodecs'))
    assert.equal(resolveImplementation({ api, core: result.forHost('web', name) }).implementationState, 'missing')
  }
})

for (const [description, target, before, after, error] of [
  ['codec installation', 'crates/container-runtime/src/sync_files.rs', '#[path = "sync_file_codecs.rs"]', '#[path = "missing_file_codecs.rs"]', /Shared synchronous file text projection or encoding dispatch/],
  ['codec write dispatch', 'crates/container-runtime/src/sync_files.rs', 'if let Some(bytes) = codecs::encode(payload)?', 'if let Some(bytes) = codecs::removed_encode(payload)?', /Shared synchronous file text projection or encoding dispatch/],
  ['codec read dispatch', 'crates/container-runtime/src/sync_files.rs', 'codecs::decode(&payload, &bytes)?', 'codecs::removed_decode(&payload, &bytes)?', /Shared synchronous file text projection or encoding dispatch/],
  ['UTF16 projection before serialization', 'crates/container-core/src/host-bridge.js', 'syncFileTextInput(api, payload);', 'removedFileTextInput(api, payload);', /Shared synchronous file text projection or encoding dispatch/],
  ['single native wire serialization', 'crates/container-core/src/host-bridge.js', '__container_host_sync_call(api, encodeNativeWire(payload))', '__container_host_sync_call(api, JSON.stringify(encodeNative(payload)))', /Shared synchronous file aliases or single-serialization UTF-16 transport/],
]) test(`codec evidence rejects changed ${description}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(target, before, after)), error)
})

for (const alias of ['ascii', 'base64', 'binary', 'hex', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'utf-8', 'utf8', 'latin1']) {
  test(`codec evidence rejects missing locked alias ${alias}`, async () => {
    await assert.rejects(inventoryCoreApis(catalog, async path => {
      const source = await read(path)
      if (path !== 'crates/container-runtime/src/sync_file_codecs.rs') return source
      const before = `"${alias}"`, after = `"removed-${alias}"`
      assert(source.includes(before), `codec alias negative fixture anchor: ${alias}`)
      // The first occurrence is the live dispatch; fixture aliases below
      // remain intact so fixture text cannot satisfy the production gate.
      return source.replace(before, after)
    }), /Shared synchronous file (text projection or encoding dispatch|aliases or single-serialization UTF-16 transport)/)
  })
}

test('returned Stats signed timestamp fields are complete only on the installed native producer chain', async () => {
  const inventory = await inventoryCoreApis(catalog, read)
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) {
    for (const member of ['lastAccessedTime', 'lastModifiedTime']) {
      const name = `object:Stats.${member}`, entry = inventory.forHost(host, name)
      const api = catalog.apis.find(api => api.name === name)
      assert.equal(resolveImplementation({ api, core: entry }).implementationState, host === 'web' ? 'missing' : 'available')
      if (host !== 'web') {
        assert.deepEqual(entry.missing, [])
        assert(entry.sources.some(source => source.id === 'syncStats' && source.role === 'runtimeImplementation'))
        assert(entry.scopes.some(scope => scope.includes('signed whole POSIX seconds')))
      }
    }
    if (host !== 'web') for (const name of ['object:FileSystemManager.statSync', 'object:FileSystemManager.fstatSync']) assert.deepEqual(inventory.forHost(host, name).missing, ['fullLockedFileParameterScope'])
  }
})

test('Stats timestamp field accounting refuses a changed Number snapshot contract', async () => {
  const changed = structuredClone(catalog)
  changed.apis.find(api => api.name === 'object:Stats.lastAccessedTime').signatures[0].returns = 'bigint'
  await assert.rejects(inventoryCoreApis(changed, read), /Stats timestamp locked signature changed: lastAccessedTime/)
})

test('Stats size and mode accounting requires the locked writable Number property contract', async () => {
  for (const member of ['size', 'mode']) for (const change of ['type', 'writable']) {
    const changed = structuredClone(catalog)
    const property = changed.apis.find(api => api.name === `object:Stats.${member}`)
    if (change === 'type') property.signatures[0].returns = 'bigint'
    else property.writable = false
    await assert.rejects(inventoryCoreApis(changed, read), new RegExp(`Stats numeric snapshot locked signature changed: ${member}`))
  }
})

for (const [name, before, after] of [
  ['actual size export', '"size": self.size', '"size": 0'],
  ['actual mode export', '"mode": self.mode', '"mode": 0o100600'],
  ['Unix metadata mode branch', '#[cfg(unix)]', '#[cfg(any())]'],
]) test(`Stats returned numeric accounting rejects a broken ${name}`, async () => {
  // Restrict the fixture to the production region: tests contain independent
  // real-filesystem examples and must not satisfy a missing producer anchor.
  const path = 'crates/container-runtime/src/sync_file_stats.rs'
  const original = await read(path), boundary = original.indexOf('#[cfg(test)]')
  const production = original.slice(0, boundary)
  assert.equal(production.split(before).length - 1, 1)
  const changed = production.replace(before, after) + original.slice(boundary)
  await assert.rejects(inventoryCoreApis(catalog, async target => target === path ? changed : read(target)), /Stats returned size and mode snapshot changed/)
})

test('descriptor file members require real delegated dispatch, owner retirement and original-buffer read materialization', async () => {
  const result = await inventoryCoreApis(catalog, read)
  for (const member of ['openSync', 'closeSync', 'readSync', 'writeSync', 'fstatSync', 'ftruncateSync', 'truncateSync']) {
    const name = `object:FileSystemManager.${member}`
    for (const host of ['android', 'ios', 'harmony', 'macos', 'windows', 'linux']) {
      const entry = result.forHost(host, name)
      assert(entry.sources.some(source => source.id === 'syncDescriptors' && source.role === 'runtimeImplementation'))
      assert.deepEqual(entry.missing, ['fullLockedFileParameterScope'])
    }
    assert(!result.forHost('web', name)?.sources.some(source => source.id === 'syncDescriptors'))
  }
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/sync_file_descriptors.rs') ? (await read(path)).replace('member == "openSync"', 'member == "removedOpenSync"') : read(path)), /Synchronous managed file implementation missing: openSync/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/sync_files.rs') ? (await read(path)).replace('return self.descriptor_call(member, &payload);', 'return Err("unimplemented".into());') : read(path)), /Synchronous descriptor delegation/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/sync_files.rs') ? (await read(path)).replace('self.provider.retire()', '()') : read(path)), /Synchronous descriptor retirement/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/host-bridge.js') ? (await read(path)).replace('value.arrayBuffer = readTarget;', '') : read(path)), /readSync no longer returns the caller-owned buffer/)
})

test('Performance disconnect is counted separately while metric producers and returned lists remain partial', async () => {
  const result = await inventoryCoreApis(catalog, read)
  const names = ['wx.getPerformance', ...['getEntries', 'getEntriesByName', 'getEntriesByType', 'setBufferSize', 'createObserver'].map(method => `object:Performance.${method}`), ...['observe', 'disconnect', 'supportedEntryTypes'].map(method => `object:PerformanceObserver.${method}`), ...['getEntries', 'getEntriesByName', 'getEntriesByType'].map(method => `object:EntryList.${method}`)]
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) for (const name of names) {
    const entry = result.forHost(host, name)
    assert(entry.sources.some(source => source.id === 'performance' && source.role === 'runtimeImplementation'))
    assert.deepEqual(entry.missing, name === 'object:PerformanceObserver.disconnect' ? [] : ['completePerformanceInstrumentation'])
    if (name === 'object:PerformanceObserver.disconnect') {
      assert.equal(resolveImplementation({ api: catalog.apis.find(api => api.name === name), core: entry }).implementationState, 'available')
      assert(entry.scopes.some(scope => scope.includes('Synchronous void cleanup')))
    }
  }
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/performance.js') ? (await read(path)).replace('entry.name = "evaluateScript"', 'entry.name = "fakeScript"') : read(path)), /Performance measurement dispatch changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/performance.js') ? (await read(path)).replace('setBufferSize: function(', 'removedBufferSize: function(') : read(path)), /Performance member implementation changed: Performance.setBufferSize/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.includes('container-engine-v8') ? (await read(path)).replaceAll('__container_host_performance_now', '__removed_clock') : read(path)), /Native performance clock changed: v8/)
})

const performanceDisconnectNegativeCases = [
  ['inactive fence', 'record.active = false; record.pending = privateArray(); record.generation++;', 'record.active = true; record.pending = privateArray(); record.generation++;'],
  ['pending retirement', 'record.active = false; record.pending = privateArray(); record.generation++;', 'record.active = false; record.generation++;'],
  ['generation retirement', 'record.active = false; record.pending = privateArray(); record.generation++;', 'record.active = false; record.pending = privateArray();'],
  ['detached batch generation check', 'record.generation !== delivery.generation', 'false'],
  ['record removal identity', 'if (observers[index] !== record) continue;', 'if (false) continue;'],
  ['receiver authority', 'disconnect: function() { removeObserver(record); }', 'disconnect: function() { removeObserver(this.record); }'],
  ['synchronous completion', 'disconnect: function() { removeObserver(record); }', 'disconnect: function() { enqueue(checkpoint, function() { removeObserver(record); }); }'],
  ['void return', 'disconnect: function() { removeObserver(record); }', 'disconnect: function() { removeObserver(record); return true; }'],
  ['cleanup after revocation', 'disconnect: function() { removeObserver(record); }', 'disconnect: function() { requireAccess(); removeObserver(record); }'],
  ['no-op with live source decoy', 'disconnect: function() { removeObserver(record); }', 'disconnect: function() { /* removeObserver(record); */ }'],
  ['private array prototype', 'function privateArray() { return setPrototype([], null); }', 'function privateArray() { return []; }'],
  ['captured primitive binding', 'const setPrototype = Object.setPrototypeOf;', 'const setPrototype = function(value) { return value; };'],
  ['error isolation', '} catch (error) { reportFailure(error); }\n    }\n  }\n  function append', '} catch (error) { throw error; }\n    }\n  }\n  function append'],
  ['reobservation generation', 'record.types = types; record.pending = privateArray(); record.active = true; record.generation++;', 'record.types = types; record.pending = privateArray(); record.active = true;'],
]
for (const [label, before, after] of performanceDisconnectNegativeCases) test(`Performance disconnect loses its complete source grant after changing ${label}`, async () => {
  const result = await inventoryCoreApis(catalog, changedRead('crates/container-core/src/performance.js', before, after))
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) {
    const entry = result.forHost(host, 'object:PerformanceObserver.disconnect')
    assert.deepEqual(entry.missing, ['reviewedPerformanceDisconnectSource'])
    assert.equal(resolveImplementation({ api: catalog.apis.find(api => api.name === 'object:PerformanceObserver.disconnect'), core: entry }).implementationState, 'partial')
  }
})

test('Performance disconnect semantic source identity permits only trivia and equivalent literal spelling', async () => {
  const result = await inventoryCoreApis(catalog, async path => {
    const source = await read(path)
    return path.endsWith('/performance.js') ? '// review trivia\n'+source.replace('entry.entryType = "script"', 'entry.entryType = "\\x73cript"')+'\n/* review trivia */\n' : source
  })
  assert.deepEqual(result.forHost('web', 'object:PerformanceObserver.disconnect').missing, [])
})

for (const [label, mutate] of [
  ['receiver', (api, value) => { api.receiver = 'OtherObserver' }],
  ['property', (api, value) => { api.property = { type: 'Function' } }],
  ['baseline inclusion', (api, value) => { api.baseline = 'excluded' }],
  ['parameter', (api, value) => { api.signatures[0].parameters.push({ name: 'options', type: 'object' }) }],
  ['return', (api, value) => { api.signatures[0].returns = 'Promise<void>' }],
  ['overload', (api, value) => { api.signatures.push({ parameters: [], returns: 'void' }) }],
  ['typings version', (api, value) => { value.baseline.typings.version = '5.2.4' }],
  ['base library', (api, value) => { value.baseline.baseLibrary = '3.17.4' }],
  ['typings source pin', (api, value) => { value.baseline.typings.sources.find(source => source.path === 'types/wx/lib.wx.api.d.ts').sha256 = '0'.repeat(64) }],
]) test(`Performance disconnect rejects a changed locked ${label}`, async () => {
  const value = structuredClone(catalog)
  mutate(value.apis.find(api => api.name === 'object:PerformanceObserver.disconnect'), value)
  await assert.rejects(inventoryCoreApis(value, read), /Performance disconnect locked signature changed/)
})

test('EventChannel requires real channel methods and private immediate/deferred navigation ownership', async () => {
  const result = await inventoryCoreApis(catalog, read)
  for (const method of ['emit', 'on', 'once', 'off']) {
    const entry = result.forHost('web', `object:EventChannel.${method}`)
    assert.deepEqual(entry.missing, [])
    assert(entry.sources.some(source => source.id === 'eventChannel' && source.role === 'runtimeImplementation'))
    assert(entry.sources.some(source => source.id === 'navigation'))
  }
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/event-channel.js') ? (await read(path)).replace('channel.once = function(', 'channel.removedOnce = function(') : read(path)), /EventChannel method implementation changed: once/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.includes('container-engine-v8') ? (await read(path)).replaceAll('event_channel_binding', 'removed_channel_binding') : read(path)), /EventChannel private native binding changed: v8/)
  await assert.rejects(inventoryCoreApis(catalog, changedRead('crates/container-runtime/src/navigation_layout.rs', 'session.navigation_result_prepared(&pending.queued.request,&pending.queued.name,engine_request_id,prepared)', 'session.navigation_result_prepared(&pending.queued.request,&pending.queued.name,None,prepared)')), /EventChannel immediate\/deferred navigation dispatch/)
})

test('unimplemented Canvas and selector members are not inferred from their receiver or owner', async () => {
  const result = await inventoryCoreApis(catalog, read)
  assert(result.apis.get('object:CanvasContext.arc'))
  assert.equal(result.apis.get('object:CanvasContext.createCircularGradient'), undefined)
  assert.equal(result.apis.get('object:OffscreenCanvas.createImage'), undefined)
  const context = result.apis.get('object:NodesRef.context')
  assert(!context?.sources.some(source => source.role === 'runtimeImplementation'))
  assert(!result.apis.get('object:NodesRef.ref')?.sources.some(source => source.role === 'runtimeImplementation'))
})

const canvasAffineMissing = {
  setTransform: ['canvasSetTransformNativeScalarRangeParity'],
  transform: ['canvasTransformNativeScalarRangeParity', 'canvasTransformComposedMatrixRangeParity'],
  clip: ['canvasClipFixed3173EdgeCoverageReview'],
}
test('Canvas affine inventory records exactly21 Partial member cells and preserves every other grade', async () => {
  const inventory = await inventoryCoreApis(catalog, read)
  assert.equal(inventory.sources.canvasClip.path, 'crates/container-render-skia/src/canvas_clip.rs')
  assert.match(inventory.sources.canvasClip.sha256, /^[a-f0-9]{64}$/)
  const hosts = ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']
  const changed = new Set(Object.keys(canvasAffineMissing).map(method => `object:CanvasContext.${method}`))
  const matrix = JSON.parse(await read('docs/host-services/api-matrix.json'))
  const gradeChanges = []
  for (const api of catalog.apis) for (const host of hosts) {
    const entry = inventory.forHost(host, api.name)
    const before = matrix.apis.find(item => item.name === api.name).hosts[host]
    // Reuse the checked-in platform registrations/limits so this core-only
    // change is compared against every cell without dropping adapter evidence.
    const state = resolveImplementation({ api, core: entry,
      registeredSources: before.sources.filter(source => source.role === 'platformProvider'),
      delegated: before.implementation === 'delegated', parameterLimit: before.parameterLimit,
    }).implementationState
    if (objectNotificationOffNames.has(api.name)) { assert.equal(state, 'available'); continue }
    if (finiteNotificationNames.has(api.name)) {
      assert.equal(state, finiteNotificationOffNames.includes(api.name) ? 'available' : 'partial'); continue
    }
    if (api.name === 'object:CanvasContext.arcTo') { assert.equal(state, 'partial'); continue }
    if (!changed.has(api.name)) {
      assert.equal(state, before.implementationState, `${host}: unrelated ${api.name}`)
      continue
    }
    const method = api.name.split('.').at(-1)
    assert.deepEqual(entry.missing, canvasAffineMissing[method])
    assert.equal(state, 'partial')
    assert.equal(cellAcceptance(host, api).status, 'pendingAcceptance')
    for (const id of ['canvas', 'environment', 'quickjs', 'v8']) assert(entry.sources.some(source => source.id === id && source.role === 'jsFacade'))
    for (const id of ['runtime', 'renderer', 'canvasBatch', 'canvasService', 'canvasRaster', 'canvasStroke']) assert(entry.sources.some(source => source.id === id && source.role === 'runtimeImplementation'))
    assert.equal(entry.sources.some(source => source.id === 'canvasClip'), method === 'clip')
    assert(entry.scopes.some(scope => scope.includes('No availability or acceptance promotion.')))
    if (before.implementationState === 'missing') gradeChanges.push([api.name, host])
    else assert.equal(before.implementationState, 'partial', `${host}: ${api.name}`)
  }
  assert([0, 21].includes(gradeChanges.length), 'baseline must contain either all21 new cells or none')
  for (const name of ['wx.createCanvasContext', 'object:CanvasContext.draw', 'object:CanvasContext.fill', 'object:CanvasContext.translate']) {
    assert.deepEqual(inventory.apis.get(name).missing, ['fullCanvasContract'])
  }
  assert.equal(inventory.apis.get('object:CanvasContext.createCircularGradient'), undefined)
  for (const name of ['wx.createOffscreenCanvas', 'object:OffscreenCanvas.getContext']) assert.deepEqual(inventory.apis.get(name).missing, ['fullOffscreenCanvasContract'])
})

for (const method of ['setTransform', 'transform', 'clip']) for (const change of ['return', 'parameters']) {
  test(`Canvas affine inventory rejects changed locked ${method} ${change}`, async () => {
    const value = structuredClone(catalog), api = value.apis.find(api => api.name === `object:CanvasContext.${method}`)
    if (change === 'return') api.signatures[0].returns = 'CanvasContext'
    else if (method === 'clip') api.signatures[0].parameters.push({ name: 'fillRule', type: 'string', optional: true })
    else api.signatures[0].parameters[5].optional = true
    await assert.rejects(inventoryCoreApis(value, read), new RegExp(`Canvas affine locked signature changed: ${method}`))
  })
}

const canvasAffineNegativeCases = [
  ['void facade', 'crates/container-core/src/canvas.js', '["setTransform", "transform", "clip"].forEach(function(name) {\n    api[name] = function() { command(name, arguments); };\n  });', '["setTransform", "transform", "clip"].forEach(function(name) { api[name] = function() { return command(name, arguments); }; });', /Canvas affine void facade/],
  ['facade comment decoy', 'crates/container-core/src/canvas.js', '["setTransform", "transform", "clip"].forEach(function(name) {\n    api[name] = function() { command(name, arguments); };\n  });', '/* ["setTransform", "transform", "clip"].forEach(function(name) { api[name] = function() { command(name, arguments); }; }); */', /Canvas affine void facade/],
  ['six scalar validation', 'crates/container-core/src/canvas.js', 'index < 6; index += 1) scalar(args[index]);', 'index < 5; index += 1) scalar(args[index]);', /Canvas affine finite scalar admission/],
  ['scalar number admission', 'crates/container-core/src/canvas.js', 'typeof value !== "number" || !__container_canvas_intrinsics.finite(value)', '!__container_canvas_intrinsics.finite(value)', /Canvas affine scalar validation/],
  ['captured finite predicate', 'crates/container-core/src/canvas.js', 'finite: Number.isFinite,', 'finite: function() { return true; },', /Canvas affine intrinsic captures/],
  ['captured native scalar conversion', 'crates/container-core/src/canvas.js', 'fround: Math.fround', 'fround: function(value) { return value; }', /Canvas affine intrinsic captures/],
  ['typed transform decoder', 'crates/container-render-skia/src/canvas_batch.rs', '"transform" => Self::Transform(numbers(command)?),', '"transform" => Self::SetTransform(numbers(command)?),', /Canvas affine typed decoder/],
  ['typed clip decoder', 'crates/container-render-skia/src/canvas_batch.rs', '"clip" => Self::Clip,', '"clip" => Self::Save,', /Canvas affine typed decoder/],
  ['preflight delegation', 'crates/container-render-skia/src/canvas_batch.rs', 'super::validate_canvas_geometry(&mut commands, frame.width, frame.height)?;', '/* super::validate_canvas_geometry(&mut commands, frame.width, frame.height)?; */', /Canvas affine preflight before replay/],
  ['clip preflight admission', 'crates/container-render-skia/src/lib.rs', 'clips.admit(command)?;', '/* clips.admit(command)?; */', /Canvas affine bounded preflight/],
  ['finite composition validation', 'crates/container-render-skia/src/lib.rs', '.any(|value| !value.is_finite())', '.any(|value| value.is_finite())', /Canvas affine bounded preflight/, 3],
  ['ordered multiplication', 'crates/container-render-skia/src/lib.rs', 'a: self.a * other.a + self.c * other.b,', 'a: self.a * other.a + self.b * other.c,', /Canvas affine ordered matrix composition/],
  ['positional matrix decode', 'crates/container-render-skia/src/lib.rs', 'fn from_values([a, b, c, d, e, f]: [f32; 6]) -> Self', 'fn from_values([a, c, b, d, e, f]: [f32; 6]) -> Self', /Canvas affine positional matrix decode/],
  ['portable point mapping', 'crates/container-render-skia/src/lib.rs', 'x: self.a * point.x + self.c * point.y + self.e,', 'x: self.a * point.x + self.b * point.y + self.e,', /Canvas affine portable point mapping/],
  ['native matrix mapping', 'crates/container-render-skia/src/lib.rs', 'self.a, self.c, self.e, self.b, self.d, self.f, 0.0, 0.0, 1.0,', 'self.a, self.b, self.e, self.c, self.d, self.f, 0.0, 0.0, 1.0,', /Canvas affine native matrix mapping/],
  ['portable transform composition', 'crates/container-render-skia/src/lib.rs', 'state.transform = state\n                .transform\n                .multiply(CanvasTransform::from_values(*values));', 'state.transform = CanvasTransform::from_values(*values);', /Canvas affine portable affine replay/],
  ['clip peak memory budget', 'crates/container-render-skia/src/canvas_clip.rs', 'if (live + 2) * self.mask_bytes > PreparedCanvasBatch::MAX_CLIP_BYTES', 'if false', /Canvas affine live mask budget/],
  ['nonzero contour sum', 'crates/container-render-skia/src/canvas_clip.rs', 'winding != 0', 'winding % 2 != 0', /Canvas affine nonzero closed contours/],
  ['clip intersection', 'crates/container-render-skia/src/canvas_clip.rs', 'if allows(previous, index) && contains(path,', 'if contains(path,', /Canvas affine pixel center intersection/],
  ['stroke clip sink', 'crates/container-render-skia/src/canvas_stroke.rs', 'if !super::canvas_clip::allows(clip, y as usize * width as usize + x as usize)', 'if false', /Canvas affine stroke clip sink/],
  ['native clip baseline', 'crates/container-render-skia/src/canvas_service.rs', 'canvas.clip_path(&path.clone().detach(), None, true);', '/* canvas.clip_path(&path.clone().detach(), None, true); */', /Canvas affine native caller guard and replay/],
  ['native caller cleanup', 'crates/container-render-skia/src/canvas_service.rs', 'canvas.restore_to_count(initial_save_count);\n    canvas.set_matrix(&initial_matrix);\n    result', 'result', /Canvas affine native caller guard and replay/],
]
for (const [name, path, before, after, error, expected = 1] of canvasAffineNegativeCases) test(`Canvas affine inventory rejects broken ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after, expected)), error)
})

test('Canvas arcTo records seven Partial cells with explicit numeric and fixed-version gaps', async () => {
  const inventory = await inventoryCoreApis(catalog, read)
  assert.equal(inventory.sources.canvasArcTo.path, 'crates/container-render-skia/src/canvas_arcto.rs')
  assert.match(inventory.sources.canvasArcTo.sha256, /^[a-f0-9]{64}$/)
  const matrix = JSON.parse(await read('docs/host-services/api-matrix.json'))
  const changed = []
  for (const api of catalog.apis) for (const [host, before] of Object.entries(matrix.apis.find(item => item.name === api.name).hosts)) {
    const core = inventory.forHost(host, api.name)
    const state = resolveImplementation({ api, core,
      registeredSources: before.sources.filter(source => source.role === 'platformProvider'),
      delegated: before.implementation === 'delegated', parameterLimit: before.parameterLimit,
    }).implementationState
    if (objectNotificationOffNames.has(api.name)) { assert.equal(state, 'available'); continue }
    if (finiteNotificationNames.has(api.name)) {
      assert.equal(state, finiteNotificationOffNames.includes(api.name) ? 'available' : 'partial'); continue
    }
    if (api.name !== 'object:CanvasContext.arcTo') {
      assert.equal(state, before.implementationState, `${host}: unrelated ${api.name}`)
      continue
    }
    assert.equal(state, 'partial')
    assert.equal(cellAcceptance(host, api).status, 'pendingAcceptance')
    assert.deepEqual(core.missing, ['canvasArcToNativeScalarRangeParity', 'canvasArcToInvertibleTransformScope',
      'canvasArcToBoundedConicScope', 'canvasArcToFixed3173ErrorParity'])
    for (const id of ['canvasArcTo', 'canvasBatch', 'canvasService', 'canvasRaster', 'canvasClip']) {
      assert(core.sources.some(source => source.id === id && source.role === 'runtimeImplementation'))
    }
    if (state !== before.implementationState) { assert.equal(before.implementationState, 'missing'); changed.push([api.name, host]) }
  }
  assert([0, 7].includes(changed.length))
})

for (const change of ['return', 'optional radius']) test(`Canvas arcTo rejects changed locked ${change}`, async () => {
  const value = structuredClone(catalog), api = value.apis.find(api => api.name === 'object:CanvasContext.arcTo')
  if (change === 'return') api.signatures[0].returns = 'CanvasContext'
  else api.signatures[0].parameters[4].optional = true
  await assert.rejects(inventoryCoreApis(value, read), /Canvas arcTo locked signature changed/)
})

for (const [name, path, before, after, error] of [
  ['void facade', 'crates/container-core/src/canvas.js', 'api.arcTo = function() { command("arcTo", arguments); };', 'api.arcTo = function() { return command("arcTo", arguments); };', /Canvas arcTo void facade/],
  ['fifth scalar', 'crates/container-core/src/canvas.js', 'index < 5; index += 1) scalar(args[index]);', 'index < 4; index += 1) scalar(args[index]);', /Canvas arcTo scalar admission/],
  ['shared lowering', 'crates/container-render-skia/src/lib.rs', '*command = canvas_arcto::lower(*values, state.path.current_point(), state.transform)?;', '/* *command = canvas_arcto::lower(*values, state.path.current_point(), state.transform)?; */', /Canvas arcTo executable boundary/],
  ['subdivision bound', 'crates/container-render-skia/src/canvas_arcto.rs', 'if depth == 12', 'if false', /Canvas arcTo executable boundary/],
  ['native conic', 'crates/container-render-skia/src/canvas_service.rs', 'path.conic_to(', 'path.quad_to(', /Canvas arcTo executable boundary/],
]) test(`Canvas arcTo inventory rejects broken ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after)), error)
})

test('recorded Canvas stroke properties remain partial while unimplemented paint properties stay absent', async () => {
  const result = await inventoryCoreApis(catalog, read)
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) {
    for (const member of ['lineCap', 'lineDashOffset', 'lineJoin', 'miterLimit']) {
      const entry = result.forHost(host, `object:CanvasContext.${member}`)
      assert.deepEqual(entry.missing, ['fullCanvasContract'])
      assert(entry.sources.some(source => source.id === 'canvas' && source.role === 'jsFacade'))
      assert(entry.sources.some(source => source.id === 'canvasService' && source.role === 'runtimeImplementation'))
      for (const id of ['canvasRaster', 'canvasStroke']) assert(entry.sources.some(source => source.id === id && source.role === 'runtimeImplementation'))
      const api = catalog.apis.find(api => api.name === `object:CanvasContext.${member}`)
      assert.equal(resolveImplementation({ api, core: entry }).implementationState, 'partial')
    }
  }
  for (const member of ['font', 'globalCompositeOperation', 'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY']) {
    assert.equal(result.apis.get(`object:CanvasContext.${member}`), undefined)
  }
  assert(!catalog.apis.some(api => api.name === 'object:CanvasContext.fontSize'))
  assert.equal(result.apis.get('object:CanvasContext.fontSize'), undefined)
})

const numericAnimationMethods = ['opacity', 'rotate', 'rotateZ', 'scale', 'scaleX', 'scaleY', 'skew', 'skewX', 'skewY', 'translate', 'translateX', 'translateY']
const animationPlaybackIds = ['animation', 'environment', 'hostInstaller', 'quickjs', 'v8', 'runtime', 'observerComponents', 'browserView', 'renderer', 'webHost', 'domPresenter', 'domSessionClient', 'workerDOM', 'workerRuntime',
  'bridgeOperations', 'viewRuntime', 'viewLegacy', 'viewModern', 'irAssembly', 'irMarkup', 'irBindingProvenance', 'animationBindings', 'animationClock', 'animationTimeline', 'animationProtocol', 'animationPlayback', 'animationSession', 'animationNative', 'browserAnimation', 'frameInput', 'viewExecution', 'renderWork', 'engineTurn', 'devLogicalResize', 'styleTransforms', 'rendererAnimation', 'domAnimationSample', 'presentationScheduler', 'workerBridgeTransport', 'workerSessionClient', 'workerWebSession']
test('numeric Animation chain, factory and step/export retain Partial and every other method retains its playback gap', async () => {
  const inventory = await inventoryCoreApis(catalog, read)
  const hosts = ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']
  const playbackNames = ['wx.createAnimation', ...[...numericAnimationMethods, 'step', 'export'].map(method => `object:Animation.${method}`)]
  const names = ['wx.createAnimation', ...catalog.apis.filter(api => api.receiver === 'Animation').map(api => api.name)]
  assert.equal(numericAnimationMethods.length, 12)
  assert.equal(playbackNames.length, 15)
  assert.equal(names.length, 31)
  for (const host of hosts) for (const name of names) {
    const api = catalog.apis.find(api => api.name === name), entry = inventory.forHost(host, name)
    assert.equal(resolveImplementation({ api, core: entry }).implementationState, 'partial', `${host}: ${name}`)
    assert.equal(cellAcceptance(host, api).status, 'pendingAcceptance', `${host}: ${name}`)
    assert(entry.scopes.some(scope => scope.includes('No availability or acceptance promotion.')))
    if (playbackNames.includes(name)) {
      assert.deepEqual(entry.missing, ['animationFullPlaybackContract', 'animationFixedVersionReplayLifecycleParity'])
      for (const id of animationPlaybackIds) {
        assert(entry.sources.some(source => source.id === id && source.role === 'runtimeImplementation'), `${name}: ${id}`)
        assert(inventory.sources[id]?.path && /^[a-f0-9]{64}$/.test(inventory.sources[id].sha256), id)
      }
      assert(entry.scopes.some(scope => scope.includes('recheck live resource authority for each new frame') && scope.includes('existing resource leases')))
    } else {
      assert.deepEqual(entry.missing, ['rendererAnimationPlayback'])
      assert(!entry.sources.some(source => source.id === 'animationTimeline'))
    }
  }
  // Compare the changed cells to the checked-in 8,855-cell contract without
  // regenerating it or manufacturing acceptance from implementation evidence.
  const matrix = JSON.parse(await read('docs/host-services/api-matrix.json'))
  assert.equal(matrix.apis.length * hosts.length, 8855)
  for (const host of hosts) for (const name of names) {
    const api = catalog.apis.find(api => api.name === name)
    const before = matrix.apis.find(api => api.name === name).hosts[host]
    assert.equal(resolveImplementation({ api, core: inventory.forHost(host, name) }).implementationState, before.implementationState)
    assert.equal(cellAcceptance(host, api).status, before.status)
  }
  assert.equal(matrix.apis.flatMap(api => Object.values(api.hosts)).filter(cell => cell.status === 'implementedAndAccepted').length, 0)
})

const animationNegativeCases = [
  ['finite numeric decoder', 'crates/container-runtime/src/animation_timeline.rs', '"scale" | "skew" | "translate" => 2,', '"scale" | "skew" => 2,', /Numeric Animation finite operation decoder/],
  ['unsupported operation rejection', 'crates/container-runtime/src/animation_timeline.rs', '_ => return Err(unsupported("unsupported animation operation")),', '_ => 1,', /Numeric Animation finite operation decoder/],
  ...['quickjs', 'v8'].map(engine => [`${engine} private write transport`, `crates/container-engine-${engine}/src/lib.rs`, '"kind":"animation-write-snapshot"', '"kind":"public-animation-write-snapshot"', new RegExp(`Numeric Animation private write capture changed: ${engine}`)]),
  ['equal write completion', 'crates/container-engine-quickjs/src/lib.rs', 'finally { __receiver_write_finish(write, writeCompleted); }', 'finally {}', /Numeric Animation successful write and clone prefix changed: quickjs/],
  ['equal write completion comment decoy', 'crates/container-engine-quickjs/src/lib.rs', 'finally { __receiver_write_finish(write, writeCompleted); }', 'finally { /* __receiver_write_finish(write, writeCompleted); */ }', /Numeric Animation successful write and clone prefix changed: quickjs/],
  ['serialization clone prefix', 'crates/container-engine-v8/src/lib.rs', 'const inputIdentity = __receiver_component_input(component);', 'const inputIdentity = null;', /Numeric Animation successful write and clone prefix changed: v8/],
  ['private completion stamp', 'crates/container-core/src/host_environment.rs', 'write.stamp = __host_string(++entry.writeSequence);', 'write.stamp = "1";', /Numeric Animation private completed-write ledger/],
  ['root clone capture', 'crates/container-runtime/src/lib.rs', '.map(|page| self.capture_animation_root_snapshot(page))', '.map(|page| self.unrelated_snapshot(page))', /Numeric Animation root clone boundary/],
  ['component snapshot authentication', 'crates/container-runtime/src/components.rs', 'if authentic == *snapshot {', 'if true {', /Numeric Animation component clone proof/],
  ['resolved equal-write identity', 'crates/container-runtime/src/animation_bindings.rs', 'previous.descriptor.resolved_paths != resolved_paths', 'false', /Numeric Animation equal-write replay/],
  ['legacy View tracer', 'crates/container-core/src/view.js', 'const tracer = bindingTracer(task.data), attributeSources = [];', 'const tracer = unrelatedTracer(task.data), attributeSources = [];', /Numeric Animation View evaluator provenance changed: viewLegacy/],
  ['typed program consumption', 'crates/container-runtime/src/animation_playback.rs', 'Some(Program::decode(&descriptor.payload)?)', 'None', /Numeric Animation typed timeline consumer/],
  ['presentation anchor', 'crates/container-runtime/src/animation_playback.rs', 'run.anchor = run.timeline.as_ref().map(|_| presented_at);', 'run.anchor = None;', /Numeric Animation presentation clock anchor/],
  ['native sample preparation', 'crates/container-runtime/src/animation_native.rs', '.prepare_sample(page.0, now, input.viewport)?', '.unrelated_sample(page.0, now, input.viewport)?', /Numeric Animation native retained sample/],
  ['native resource reauthorization', 'crates/container-runtime/src/render_backend.rs', 'image_cache.prepare(manifest, blobs, &mut root, document, buffer_urls)?', 'Vec::new()', /Numeric Animation native ordinary resource\/layout pipeline/],
  ['native resource comment decoy', 'crates/container-runtime/src/render_backend.rs', 'image_cache.prepare(manifest, blobs, &mut root, document, buffer_urls)?', '/* image_cache.prepare(manifest, blobs, &mut root, document, buffer_urls)? */ Vec::new()', /Numeric Animation native ordinary resource\/layout pipeline/],
  ['DOM baseline observation', 'examples/hosts/web-wasm/dom-presenter.mjs', 'entry.candidate.animationBaselines(animation.baselines)', '[]', /Numeric Animation actual DOM baseline and retained overlay/],
  ['DOM exact accepted topology', 'examples/hosts/web-wasm/dom-animation-sample.mjs', 'value.baseGeometryEpoch !== baseGeometryEpoch', 'false', /Numeric Animation exact DOM sample topology and journal/],
  ['template priority over samples', 'examples/hosts/web-wasm/presentation-scheduler.mjs', "if (later(current.templateRevision, proof.consumedInput.templateRevision)) return 'template'", "if (false) return 'template'", /Numeric Animation template-before-sample scheduling/],
  ['Worker retained sample call', 'examples/hosts/web-wasm/worker-dom-adapter.mjs', 'this.client.prepareSample(demand.sampleDemandRevision,', 'this.client.unrelatedSample(demand.sampleDemandRevision,', /Numeric Animation Worker retained sample proof/],
  ["Worker three-argument sample contract", "examples/hosts/web-wasm/worker-dom-adapter.mjs", "async preparePaint(demand, accepted, context)", "async preparePaint(demand, context)", /Numeric Animation Worker retained sample proof/],
  ["Worker retained ACK base", "examples/hosts/web-wasm/worker-dom-adapter.mjs", "!sameProof(baseProof, this.#acceptedProof)", "false", /Numeric Animation Worker retained sample proof/],
  ["Worker retained input lower bound", "examples/hosts/web-wasm/worker-dom-adapter.mjs", "BigInt(baseProof.consumedInput.templateRevision) < BigInt(demand.templateRevision)", "false", /Numeric Animation Worker retained sample proof/],
  ["Worker exact cloned input", "examples/hosts/web-wasm/worker-dom-adapter.mjs", "!sameInput(input, baseProof.consumedInput)", "false", /Numeric Animation Worker retained sample proof/],
]
for (const [name, path, before, after, error] of animationNegativeCases) test(`Animation inventory rejects broken ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after)), error)
})

const canvasNegativeCases = [
  ['public owner capture', 'crates/container-core/src/canvas.js', '__container_owned_canvases.context(id, component)', 'null', /Canvas public owner-capture delegation/],
  ['public implementation delegation', 'crates/container-core/src/canvas.js', 'return __container_canvas_context_impl(id, null,', 'return unrelated_canvas_context(id, null,', /Canvas public owner-capture delegation/],
  ...['lineCap', 'lineDashOffset', 'lineJoin', 'miterLimit'].map(property => [`${property} descriptor`, 'crates/container-core/src/canvas.js', `${property}: { get:`, `removed${property}: { get:`, new RegExp(`Canvas facade changed: object:CanvasContext.${property}`)]),
  ['lineCap state recording', 'crates/container-core/src/canvas.js', 'case "setLineCap": drawing.lineCap = args[0]; break;', 'case "setLineCap": break;', /Canvas stroke property implementation changed: lineCap/],
  ['lineJoin software replay', 'crates/container-render-skia/src/lib.rs', 'PreparedCanvasCommand::SetLineJoin(join) => state.line_join = *join,', 'PreparedCanvasCommand::SetLineJoin(_) => {},', /Canvas stroke property implementation changed: lineJoin/],
  ['miterLimit native consumer', 'crates/container-render-skia/src/canvas_service.rs', 'paint.set_stroke_miter(state.miter_limit);', 'paint.set_stroke_miter(10.0);', /Canvas stroke property implementation changed: miterLimit/],
  ['lineDashOffset software consumer', 'crates/container-render-skia/src/canvas_stroke.rs', 'Dash::new(style.dash, style.dash_offset)', 'Dash::new(style.dash, 0.0)', /Canvas stroke property implementation changed: lineDashOffset/],
  ['dash offset preparation', 'crates/container-render-skia/src/canvas_batch.rs', '.map(|_| canvas_arg_f32(command, 1))', '.map(|_| Ok(0.0))', /Canvas dash offset preparation/],
  ['dash offset typed operation', 'crates/container-render-skia/src/canvas_batch.rs', 'Self::SetLineDash {\n                    pattern: dash,\n                    offset,\n                }', 'Self::SetLineDash { pattern: dash, offset: 0.0 }', /Canvas dash offset preparation/],
  ['property setter dispatch', 'crates/container-core/src/canvas.js', 'command("setLineDash", [state.drawing.lineDash, value]);', 'command("setLineDash", [state.drawing.lineDash, 0]);', /Canvas facade changed: object:CanvasContext.lineDashOffset/],
]
for (const [name, path, before, after, error] of canvasNegativeCases) test(`Canvas inventory rejects broken ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after)), error)
})

test('shared selector descriptors require the real retained native and DOM chain while every inventoried member stays partial', async () => {
  const result = await inventoryCoreApis(catalog, read)
  const names = ['wx.createSelectorQuery', ...['exec', 'in', 'select', 'selectAll', 'selectViewport'].map(method => `object:SelectorQuery.${method}`), ...['boundingClientRect', 'fields', 'node', 'scrollOffset'].map(method => `object:NodesRef.${method}`)]
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) for (const name of names) {
    const entry = result.forHost(host, name)
    assert.deepEqual(entry.missing, ['fullLockedParameterScope'])
    for (const id of ['selectorQueries', 'environment', 'quickjs', 'v8', 'privateSelectors', 'nativeQueries', 'browserQueries', 'selectorGeometry', 'lifecycleNotifications', 'runtimeLifecycle', 'domPresenter', 'domSessionClient']) assert(entry.sources.some(source => source.id === id && source.role === 'runtimeImplementation'), `${host}: ${name}: ${id}`)
    for (const gap of ['exec', 'fields/style/mark/node', 'ref/context', 'scroll extent', 'public SDK']) assert(entry.scopes.some(scope => scope.includes(gap)), `${name}: ${gap}`)
  }
})

const selectorNegativeCases = [
  ['shared installation', 'crates/container-core/src/host_environment.rs', 'include_str!("selector-query.js")', 'include_str!("removed-selector.js")', /Shared SelectorQuery installation/],
  ['engine facade delegation', 'crates/container-engine-v8/src/lib.rs', 'function __container_selector_query() { return __container_selector_queries.create(); }', 'function __container_selector_query() { return {}; }', /Shared SelectorQuery engine facade changed: v8/],
  ['retained engine request capture', 'crates/container-engine-quickjs/src/lib.rs', '"kind":"selector-query-requests","after":after.to_string()', '"kind":"removed-selector-requests","after":after.to_string()', /Retained selector engine capture changed: quickjs/],
  ['retained private receiver capture', 'crates/container-core/src/host_environment.rs', 'const privateQuery = animationWrites || __receiver_value(request, "kind") === "selector-query-receivers";', 'const privateQuery = false;', /Retained private selector receiver capture/],
  ['immutable field snapshot', 'crates/container-core/src/selector-query.js', 'parse(__receiver_snapshot_json(fields))', 'fields', /Shared selector scope and immutable request ownership/],
  ['actual callback context capture', 'crates/container-core/src/selector-query.js', 'callbackOwner=owner(preferredReceiver)||owner(captureCurrent())', 'callbackOwner=owner(preferredReceiver)||currentPageOwner()', /Selector lifecycle authority and callback context separation/],
  ['same-page callback adoption', 'crates/container-core/src/selector-query.js', 'if(!callbackOwner && next && !invalidScope)callbackOwner=next;', 'if(!callbackOwner && next)callbackOwner=next;', /Selector lifecycle authority and callback context separation/],
  ['ownerless callback separation', 'crates/container-core/src/selector-query.js', 'if(record.callbackOwner) runOwner(record.callbackOwner.receiver,call); else call();', 'if(record.owner) runOwner(record.owner.receiver,call); else call();', /Selector lifecycle authority and callback context separation/],
  ['rejection owner validation', 'crates/container-core/src/selector-query.js', 'function(failure){validate(record);throw failure;}', 'function(failure){throw failure;}', /Private selector request and callback transport/],
  ['private receiver proof', 'crates/container-runtime/src/private_selector.rs', 'self.selector_receiver_snapshot(id, page, &scopes)? != request.receivers', 'false', /Private selector admission and receiver proof/],
  ['private completion acknowledgement', 'crates/container-runtime/src/private_selector.rs', 'if !self.dispatch_lifecycle_notification("selectorQuery", &payload)? {', 'if false {', /Retained selector completion acknowledgement/],
  ['completion task checkpoint', 'crates/container-runtime/src/private_selector.rs', 'container_core::JsEngine::drain_microtasks(', 'container_core::JsEngine::skip_microtasks(', /Private selector acknowledged completion task checkpoint/, 2],
  ['private work retry', 'crates/container-runtime/src/lib.rs', 'if private_queries {', 'if false {', /Private selector effect reconciliation/],
  ['native result routing', 'crates/container-runtime/src/async_host.rs', 'self.resolve_private_selector_query(id, &result)?;', 'return Ok(());', /Private selector native result routing/],
  ['pre/post-job reconciliation', 'crates/container-runtime/src/lib.rs', 'self.drain_private_selector_queries()?;', 'self.reconcile_media_queries()?;', /Private selector effect reconciliation/, 2],
  ['native receiver equality', 'crates/container-runtime/src/native_query.rs', 'Ok(current) if current == waiting.receivers =>', 'Ok(current) =>', /Native selector queue receiver and retirement chain/],
  ['native hide retirement', 'crates/container-runtime/src/lib.rs', 'self.retire_native_queries(Some(id), "native selector page was hidden or unloaded");', '', /Native selector queue receiver and retirement chain/, 2],
  ['browser private result route', 'crates/container-runtime/src/browser_query.rs', 'if id >= private_selector::FIRST_PRIVATE_ID {', 'if false {', /Browser selector private completion and projection/],
  ['actual typed dataset projection', 'crates/container-runtime/src/selector_geometry.rs', '.map(|(_, dataset)| json!(dataset))', '.map(|(_, dataset)| json!({}))', /Shared selector actual geometry projection/],
  ['measured viewport extent', 'examples/hosts/web-wasm/dom-presenter.mjs', 'return { width: scroller?.scrollWidth, height: scroller?.scrollHeight };', 'return { width: 0, height: 0 };', /DOM selector presentation and measured extent transport/],
  ['extent request restriction', 'examples/hosts/web-wasm/dom-session-client.mjs', 'value.includeViewportExtent !== true', 'false', /DOM selector presentation and measured extent transport/],
  ['terminal private state retirement', 'crates/container-runtime/src/lifecycle_notifications.rs', 'self.private_selectors = Default::default();', '', /Terminal private selector retirement/],
  ['descriptor field enumeration', 'crates/container-core/src/selector-query.js', 'fields:function(fields,fn)', 'removedFields:function(fields,fn)', /Shared selector descriptor changed: NodesRef.fields/],
  ['descriptor operation dispatch', 'crates/container-core/src/selector-query.js', "enqueue(selection,'fields',fields,fn)", "enqueue(selection,'removedFields',fields,fn)", /Shared selector operation dispatch changed: fields/],
]
for (const [name, path, before, after, error, expected = 1] of selectorNegativeCases) test(`selector inventory rejects broken ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after, expected)), error)
})

const statsNegativeCases = [
  ['sync API-aware decoder', 'crates/container-core/src/host-bridge.js', 'const value = decodeApiResult(envelope.value, api);', 'const value = decodeNative(envelope.value, 0, false);', /Stats API-aware sync and retained result decoding/],
  ['producer name restriction', 'crates/container-core/src/host-bridge.js', 'if (name === "object:FileSystemManager.fstatSync") return materializeStats(result);', 'if (name === "wx.unrelated") return materializeStats(result);', /Stats producer-specific decoding/],
  ['generic marker reinterpretation', 'crates/container-core/src/host-bridge.js', '  function decodeNative(value, depth, httpBytes) {', '  function decodeNative(value, depth, httpBytes) {\n    value = materializeStats(value);', /Generic native data must not materialize Stats markers/],
  ['recursive FileStats entries', 'crates/container-core/src/host-bridge.js', 'entry.stats = materializeStats(entry.stats);', 'entry.stats = entry.stats;', /Managed recursive FileStats materialization/],
  ['own-data marker validation', 'crates/container-core/src/host-bridge.js', 'hasOwn(value, "__weappFsStats") && value.__weappFsStats === true', 'value.__weappFsStats === true', /Managed Stats snapshot materialization/],
  ['metadata boolean validation', 'crates/container-core/src/host-bridge.js', 'typeof directory !== "boolean" || typeof file !== "boolean"', 'false', /Managed Stats snapshot materialization/],
  ['captured synchronous predicates', 'crates/container-core/src/host-bridge.js', 'value.isDirectory = function() { return directory; };', 'value.isDirectory = function() { return value.directory; };', /Managed Stats snapshot materialization/],
  ['captured ordinary-file predicate', 'crates/container-core/src/host-bridge.js', 'value.isFile = function() { return file; };', 'value.isFile = function() { return value.file; };', /Managed Stats snapshot materialization/],
  ['path metadata lookup', 'crates/container-runtime/src/sync_files.rs', 'let metadata = fs::metadata(path("path", true)?).map_err(|e| e.to_string())?;', 'let metadata = fake_metadata();', /Stats predicates require actual path and opened-file metadata/],
  ['opened-file metadata lookup', 'crates/container-runtime/src/sync_file_descriptors.rs', '.metadata()\n                .map_err(|e| e.to_string())\n                .and_then(stats::from_metadata)', '.fake_metadata()\n                .map_err(|e| e.to_string())\n                .and_then(stats::from_metadata)', /Stats predicates require actual path and opened-file metadata/],
  ['retained ticket decoder', 'crates/container-core/src/host-bridge.js', 'return resolveApi(id, null, null, deliveryTicket, decodeApiResult);', 'return resolveApi(id, null, null, deliveryTicket);', /Stats API-aware sync and retained result decoding/],
  ['shared directory snapshot', 'crates/container-runtime/src/sync_file_stats.rs', 'directory: metadata.is_dir()', 'directory: false', /Shared actual-metadata Stats snapshot changed/],
  ['shared file snapshot', 'crates/container-runtime/src/sync_file_stats.rs', 'file: metadata.is_file()', 'file: false', /Shared actual-metadata Stats snapshot changed/],
  ['stat shared snapshot call', 'crates/container-runtime/src/sync_files.rs', 'stats::from_metadata(metadata)', 'fake_stats(metadata)', /Stats predicates require actual path and opened-file metadata/],
  ['fstat shared snapshot call', 'crates/container-runtime/src/sync_file_descriptors.rs', '.and_then(stats::from_metadata)', '.and_then(fake_stats)', /Stats predicates require actual path and opened-file metadata/],
  ['shared negative fractional conversion', 'crates/container-runtime/src/sync_file_stats.rs', '-i128::from(distance.as_secs()) - i128::from(distance.subsec_nanos() != 0)', '-i128::from(distance.as_secs())', /Shared Stats signed timestamp or error boundary changed/],
  ['shared timestamp accessor errors', 'crates/container-runtime/src/sync_file_stats.rs', 'cannot read Stats.lastModifiedTime: {error}', 'timestamp unavailable: {error}', /Shared Stats signed timestamp or error boundary changed/],
]
for (const [name, path, before, after, error, expected = 1] of statsNegativeCases) test(`Stats inventory rejects broken ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after, expected)), error)
})

test('Stats returned snapshots are complete on native hosts while Windows mode and producer options retain gaps', async () => {
  const inventory = await inventoryCoreApis(catalog, read)
  for (const host of ['android', 'ios', 'harmony', 'macos', 'windows', 'linux']) for (const member of ['isDirectory', 'isFile', 'lastAccessedTime', 'lastModifiedTime', 'mode', 'size']) {
    const name = `object:Stats.${member}`, api = catalog.apis.find(api => api.name === name)
    const result = resolveImplementation({ api, core: inventory.forHost(host, name) })
    assert.equal(result.implementationState, member === 'mode' && host === 'windows' ? 'partial' : 'available', `${host}: ${name}`)
  }
  for (const member of ['isDirectory', 'isFile']) {
    const name = `object:Stats.${member}`, api = catalog.apis.find(api => api.name === name)
    assert.equal(resolveImplementation({ api, core: inventory.forHost('web', name) }).implementationState, 'missing')
  }
  for (const host of ['android', 'ios', 'harmony', 'macos', 'windows', 'linux']) for (const member of ['statSync', 'fstatSync']) assert.deepEqual(inventory.forHost(host, `object:FileSystemManager.${member}`).missing, ['fullLockedFileParameterScope'])
  for (const host of ['android', 'ios', 'harmony', 'macos', 'windows', 'linux']) for (const member of ['isDirectory', 'isFile', 'lastAccessedTime', 'lastModifiedTime', 'mode', 'size']) assert(inventory.forHost(host, `object:Stats.${member}`).sources.some(source => source.id === 'syncStats' && source.role === 'runtimeImplementation'))
})

test('lifecycle inventory requires retained native notification and keeps other lifecycle gaps', async () => {
  const result = await inventoryCoreApis(catalog, read)
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) {
    for (const method of ['onAppShow', 'offAppShow', 'onAppHide', 'offAppHide', 'onBeforePageUnload', 'offBeforePageUnload', 'onAfterPageUnload', 'offAfterPageUnload']) {
      const entry = result.forHost(host, `wx.${method}`)
      assert.deepEqual(entry.missing, [])
      assert(entry.sources.some(source => source.id === 'lifecycleNotifications' && source.role === 'runtimeImplementation'))
      assert(entry.sources.some(source => source.id === 'runtimeLifecycle'))
    }
  }
  for (const method of ['onError', 'onPageNotFound', 'nextTick']) assert(result.apis.get(`wx.${method}`).missing.length > 0)
  assert.deepEqual(result.apis.get('wx.nextTick').missing, ['actualHostNextTurnPumpAcceptance'])
  assert.deepEqual(result.apis.get('wx.onPageNotFound').missing, ['pageNotFoundDispatch'])
  assert.deepEqual(result.apis.get('wx.offError').missing, [])
  assert(result.apis.get('wx.onError').missing.includes('appErrorHookDispatch'))
  for (const name of ['wx.onError','wx.offError']) assert(result.apis.get(name).sources.some(source => source.id === 'errorNotifications' && source.role === 'runtimeImplementation'))
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/lifecycle-notifications.js') ? (await read(path)).replace('!record.identity.retired', '!record.identity.missing') : read(path)), /Actual unload receiver identity changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.includes('container-engine-v8') ? (await read(path)).replace('pub fn dispatch_lifecycle_notification(', 'pub fn missing_lifecycle_notification(') : read(path)), /Private native lifecycle dispatcher changed: v8/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.includes('container-engine-quickjs') ? (await read(path)).replace('__container_lifecycle_notifications.pageForHook(instanceId, index)', '__container_pages[index]') : read(path)), /Retained page hook receiver changed: quickjs/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/lifecycle_notifications.rs') ? (await read(path)).replace('self.lifecycle_notifications.departing.clear();', '') : read(path)), /Terminal lifecycle notification retirement changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path === 'crates/container-runtime/src/lib.rs' ? (await read(path)).replace('validate_page_input(path, payload)?;', '') : read(path)), /Direct navigation input preflight changed/)
})

test('secure random inventory follows concrete runtime ownership without promoting the crypto-manager leaf', async () => {
  const result = await inventoryCoreApis(catalog, read)
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) {
    const entry = result.forHost(host, 'wx.getRandomValues')
    assert.deepEqual(entry.missing, [])
    for (const id of ['randomValues', 'randomValuesRuntime', 'runtime', 'quickjs', 'v8']) assert(entry.sources.some(source => source.id === id && source.role === 'runtimeImplementation'))
    const manager = result.forHost(host, 'object:UserCryptoManager.getRandomValues')
    assert(!manager?.sources.some(source => source.id === 'randomValuesRuntime'))
  }
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/random_values.rs') ? (await read(path)).replace('fill_and_encode(length, getrandom::fill)?', 'fill_and_encode(length, insecure_fill)?') : read(path)), /Runtime secure random implementation/)
})

test('media completion requires private native state and disconnect fencing while observe retains fixed-contract gaps', async () => {
  const result = await inventoryCoreApis(catalog, read)
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) {
    const disconnect = result.forHost(host, 'object:MediaQueryObserver.disconnect')
    assert.deepEqual(disconnect.missing, [])
    for (const id of ['mediaQueries', 'pageMirror', 'observers', 'lifecycleNotifications', 'runtimeLifecycle', 'quickjs', 'v8']) assert(disconnect.sources.some(source => source.id === id && source.role === 'runtimeImplementation'))
    assert.deepEqual(result.forHost(host, 'object:MediaQueryObserver.observe').missing, ['mediaQueryNumericParameterParity', 'mediaQueryRepeatedObserveParity', 'mediaQueryHiddenOwnerTimingParity', 'mediaQuerySquareOrientationParity'])
  }
  assert.equal(catalog.apis.find(api => api.name === 'wx.createMediaQueryObserver'), undefined)
  assert.equal(result.apis.get('wx.createMediaQueryObserver'), undefined)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/media-query-observers.js') ? (await read(path)).replace('value = get(source, key);', 'value = undefined;') : read(path)), /Media descriptor projection changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/media-query-observers.js') ? (await read(path)).replace('__receiver_get(__receiver_weak, record.owner) === identity', 'true') : read(path)), /Private media receiver incarnation changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.includes('container-engine-quickjs') ? (await read(path)).replace('pub fn capture_media_query_state(', 'pub fn removed_media_query_state(') : read(path)), /anchor missing: pub fn capture_media_query_state/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.includes('container-engine-v8') ? (await read(path)).replace('__receiver_current_pages = __host_copy_page_array(instances);', '') : read(path)), /Private current-page media fallback changed: v8/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/media-query-observers.js') ? (await read(path)).replace("put(api, 'disconnect', function() { revoke(record); });", "put(api, 'disconnect', function() {});") : read(path)), /Private media method ownership changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/media-query-observers.js') ? (await read(path)).replace('record.active = false;', '') : read(path)), /Synchronous media disconnect fence changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/observers.rs') ? (await read(path)).replaceAll('.capture_media_query_state(known)', '.removed_media_query_state(known)') : read(path)), /Atomic native media reconciliation changed/)
  await assert.rejects(inventoryCoreApis(catalog, changedRead('crates/container-runtime/src/observers.rs', 'self.observer_observation_pending = true;\n        self.reconcile_observer_queries()?;', 'self.reconcile_observer_queries()?;\n        self.observer_observation_pending = true;')), /Media capture failure retry debt changed/)
  await assert.rejects(inventoryCoreApis(catalog, changedRead('crates/container-runtime/src/observers.rs', 'self.observer_observation_pending = true;\n        self.reconcile_observer_queries()?;', 'self.reconcile_observer_queries()?;')), /Media capture failure retry debt changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/observers.rs') ? (await read(path)).replace('for (key, state) in measurements.media_states', 'for (key, state) in []') : read(path)), /Independent private media delivery commit changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/lifecycle-notifications.js') ? (await read(path)).replace("if (name === 'mediaQuery') return __container_media_queries.dispatch(payload);", '') : read(path)), /Retained private media callback dispatch changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/lifecycle_notifications.rs') ? (await read(path)).replace('*self.observers.borrow_mut() = observers::ObserverRegistry::default();', '') : read(path)), /Terminal media observer retirement changed/)
})

test('Intersection disconnect implements the locked native member while preserving Web and factory gaps', async () => {
  const inventory = await inventoryCoreApis(catalog, read)
  const hosts = ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']
  const name = 'object:IntersectionObserver.disconnect'
  const cells = hosts.flatMap(host => catalog.apis.map(api => {
    const core = inventory.forHost(host, api.name)
    return { host, name: api.name, state: resolveImplementation({ api, core }).implementationState, missing: core?.missing ?? [], scopes: core?.scopes ?? [], sources: core?.sources ?? [] }
  }))
  assert.equal(cells.length, 8855)
  for (const host of hosts) {
    const entry = inventory.forHost(host, name)
    assert.equal(cells.find(cell => cell.host === host && cell.name === name).state, host === 'web' ? 'partial' : 'available')
    assert.deepEqual(entry.missing, host === 'web' ? ['browserIntersectionObserverAdapter'] : [])
    for (const id of ['intersectionQueries', 'environment', 'pageMirror', 'lifecycleNotifications', 'runtimeLifecycle', 'runtime', 'observerComponents', 'observers', 'quickjs', 'v8']) assert(entry.sources.some(source => source.id === id && source.role === 'runtimeImplementation'))
    for (const other of ['wx.createIntersectionObserver', ...['observe', 'relativeTo', 'relativeToViewport'].map(method => `object:IntersectionObserver.${method}`)]) assert.deepEqual(inventory.forHost(host, other).missing, ['fullLockedParameterScope'])
  }
  assert(inventory.forHost('web', name).scopes.some(scope => scope.includes('WebView/DOM route disables observer creation')))

})

const intersectionNegativeCases = [
  ['shared bootstrap', 'crates/container-core/src/host_environment.rs', 'include_str!("intersection-observers.js")', 'include_str!("missing-intersection-observers.js")', /Private intersection installation/],
  ['synchronous fence', 'crates/container-core/src/intersection-observers.js', 'record.active = false;', 'record.active = true;', /Synchronous intersection disconnect fence/],
  ['receiver incarnation', 'crates/container-core/src/intersection-observers.js', '__receiver_get(__receiver_weak, record.owner) === identity', 'true', /Private intersection receiver incarnation/],
  ['complete desired-state transport', 'crates/container-core/src/intersection-observers.js', 'result.subscriptions = subscriptions;', 'result.subscriptions = [];', /Intersection complete desired-state capture/],
  ['QuickJS retained capture', 'crates/container-engine-quickjs/src/lib.rs', '"kind":"intersection-query-state"', '"kind":"public-intersection-state"', /Private native intersection capture changed: quickjs/],
  ['V8 retained capture', 'crates/container-engine-v8/src/lib.rs', 'pub fn capture_intersection_query_state(', 'pub fn missing_intersection_query_state(', /anchor missing: pub fn capture_intersection_query_state/],
  ['native cleanup selection', 'crates/container-runtime/src/observers.rs', 'entry.intersection_identity.is_none() || (supported && present.contains(key))', 'true', /Private intersection native reconciliation/],
  ['retained callback dispatch', 'crates/container-core/src/intersection-observers.js', 'runWithOwner(record.owner, function() { apply(subscription.callback, undefined, [value]); });', 'subscription.callback(value);', /Retained private intersection delivery/],
  ['terminal retirement', 'crates/container-core/src/lifecycle-notifications.js', '__container_intersections.retire();', '', /Intersection owner retirement/],
  ['page retirement', 'crates/container-runtime/src/lib.rs', 'self.observers.borrow_mut().release_page(id);', '', /Intersection owner retirement/],
  ['component retirement', 'crates/container-runtime/src/components.rs', 'self.observers.borrow_mut().release_scopes(scopes);', '', /Intersection owner retirement/],
  ['public native SDK construction', 'crates/container-sdk-ffi/src/lib.rs', 'let session = ContainerSession::new(config)?;', 'let session = missing_session(config)?;', /Native intersection default renderer admission/],
  ['native default renderer', 'crates/container-runtime/src/lib.rs', 'browser_view_enabled: false,', 'browser_view_enabled: true,', /Native intersection default renderer admission/],
  ['DOM observer gap', 'crates/container-runtime/src/browser_view.rs', '|| name == "wx.createIntersectionObserver"', '', /Web intersection renderer gap/],
  ['factory capability ceiling', 'tools/container-manifest/src/index.mjs', "'wx.createIntersectionObserver': 'partial'", "'wx.createIntersectionObserver': 'full'", /Intersection factory Partial capability/],
]
for (const [name, path, before, after, error] of intersectionNegativeCases) test(`Intersection inventory rejects broken ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after)), error)
})

test('Intersection cleanup accounting rejects an expanded locked signature', async () => {
  const changed = structuredClone(catalog)
  changed.apis.find(api => api.name === 'object:IntersectionObserver.disconnect').signatures[0].returns = 'Promise<void>'
  await assert.rejects(inventoryCoreApis(changed, read), /Intersection disconnect locked signature/)
})

test('inventory refuses silently changed source anchors and divergent engine methods', async () => {
  await assert.rejects(inventoryCoreApis(catalog, async path => path.includes('container-engine-v8') ? (await read(path)).replace('const __container_array_buffer_to_base64 = function(', 'function __container_array_buffer_to_base64(') : read(path)), /Core JS function missing: __container_array_buffer_to_base64/)
  await assert.rejects(inventoryCoreApis(catalog, async path => (await read(path)).replace('const SYNC_APIS:', 'const RENAMED_SYNC_APIS:')), /anchor missing/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/animation.js') ? (await read(path)).replace('numeric("rotate3d", 4)', 'numeric("changedRotate3d", 4)') : read(path)), /Animation.rotate3d changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.includes('container-engine-v8') ? (await read(path)).replace('createAnimation: __container_create_animation', 'createAnimation: removed_animation') : read(path)), /Shared Animation engine facade changed: v8/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/host_environment.rs') ? (await read(path)).replace('include_str!("canvas.js")', 'include_str!("removed.js")') : read(path)), /Shared Canvas installation changed/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.includes('container-sdk') ? (await read(path)).replaceAll('container_runtime::merge_host_geometry', 'changed_geometry') : read(path)), /SDK NativeProvider/)
  await assert.rejects(inventoryCoreApis(catalog, async path => path.endsWith('/async_host.rs') ? (await read(path)).replace('host_services::observed_host_result(', 'changed_result(') : read(path)), /Asynchronous native completion/)
})


test('TabBar counts exactly five Partial operations on five installed Flutter consumer hosts', async () => {
  const result = await inventoryCoreApis(catalog, read)
  const implemented = ['setTabBarBadge', 'removeTabBarBadge', 'showTabBarRedDot', 'hideTabBarRedDot', 'setTabBarStyle']
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) for (const method of [...implemented, 'showTabBar', 'hideTabBar', 'setTabBarItem']) {
    const name = `wx.${method}`, api = catalog.apis.find(api => api.name === name), entry = result.forHost(host, name)
    const counted = !['web', 'harmony'].includes(host) && implemented.includes(method)
    assert.equal(resolveImplementation({ api, core: entry }).implementationState, counted ? 'partial' : 'missing', `${host}: ${name}`)
    assert(!result.apis.get(name)?.sources.some(source => source.role === 'runtimeImplementation'), `${name}: shared map must not promote uncounted hosts`)
    if (!counted) continue
    assert.deepEqual(entry.missing, ['fullLockedTabBarContract', 'allPublicSdkPresenterChains', 'platformTabBarExecutionAndPixels'])
    for (const id of ['tabBarState', 'chrome', 'nativeProvider', 'manifestPacker', 'flutterController', 'playerModel', 'playerChrome']) assert(entry.sources.some(source => source.id === id && source.role === 'runtimeImplementation'), `${host}: ${name}: ${id}`)
    for (const gap of ['defaults false', 'Promisify', 'Unicode/indicator', 'accessibility', 'Standalone', 'pixels']) assert(entry.scopes.some(scope => scope.includes(gap)), `${host}: ${name}: ${gap}`)
    if (['windows', 'linux'].includes(host)) for (const id of ['flutterView', 'desktopRegistry', 'nativePreview', 'nativeChrome']) assert(entry.sources.some(source => source.id === id), `${host}: ${name}: ${id}`)
  }
})

const tabBarNegativeCases = [
  ['shared installation', 'environment', 'include_str!("tab-bar.js")', 'include_str!("removed-tab.js")', /Shared TabBar installation/],
  ['own data snapshot', 'tabBar', 'descriptor && !own(descriptor, "value")', 'false', /TabBar own primitive snapshot/],
  ['primitive index guard', 'tabBar', 'typeof value !== "number" || !isInteger(value) || value < 0', 'false', /TabBar own primitive snapshot/],
  ['nonenumerable original callbacks', 'tabBar', 'define(request, key, {__proto__: null, value: callback});', 'data(request, key, callback);', /TabBar retained callbacks/],
  ['local callback settlement', 'tabBar', 'return complete(request, null,', 'return null && complete(request, null,', /TabBar retained callbacks/],
  ['optional style options', 'tabBar', 'if (options === undefined && method === "setTabBarStyle") options = create(null);', '', /TabBar retained callbacks/],
  ['default manifest candidate', 'manifestPacker', "'wx.setTabBarBadge': 'partial'", "'wx.setTabBarBadge': 'unsupported'", /Default pack must admit TabBar/],
  ['default host diagnostic', 'manifestPacker', "PRESENTER_REQUIRED_CAPABILITIES.has(name)\n          ? 'unsupported'", "false\n          ? 'unsupported'", /TabBar pack diagnostic/],
  ['presenter false default', 'nativeProvider', 'system_tab_bar: false,', 'system_tab_bar: true,', /SDK trusted TabBar false\/true/],
  ['presenter false omission', 'nativeProvider', 'fn system_tab_bar_disabled(value: &bool) -> bool {\n    !value\n}', 'fn system_tab_bar_disabled(value: &bool) -> bool {\n    *value\n}', /SDK trusted TabBar false\/true/],
  ['presenter true opt in', 'nativeProvider', 'if self.config.system_tab_bar {', 'if true {', /SDK trusted TabBar false\/true/],
  ['custom tabBar admission', 'runtime', 'self.has_custom_tab_bar()', 'false', /TabBar explicit presenter admission/],
  ['capability Partial ceiling', 'runtime', '                CapabilitySupport::Partial\n            } else {\n                CapabilitySupport::Full\n            };', '                CapabilitySupport::Full\n            } else {\n                CapabilitySupport::Full\n            };', /TabBar explicit presenter admission/],
  ['direct dispatcher', 'runtime', 'let result = self.tab_bar_api_result(\n                name,\n                payload,\n                request.deadline_ns,\n                request.cancel_token.as_deref(),', 'let result = self.tab_bar_api_result(\n                name,\n                payload,\n                None,\n                None,', /TabBar session state and both API dispatch/],
  ['engine dispatcher', 'runtime', 'self.tab_bar_api_result(name, &options, deadline, cancel)', 'self.tab_bar_api_result(name, &options, None, None)', /TabBar session state and both API dispatch/],
  ['pre-mutation cancellation', 'tabBarState', 'cancel.is_some_and(|token| self.is_cancelled(token))', 'false', /TabBar lifecycle\/admission\/deadline\/cancellation/],
  ['pre-mutation deadline', 'tabBarState', 'deadline.is_some_and(crate::deadline_expired)', 'false', /TabBar lifecycle\/admission\/deadline\/cancellation/],
  ['retired lifecycle', 'tabBarState', 'self.app_service.lifecycle().state() == container_core::LifecycleState::Destroyed', 'false', /TabBar lifecycle\/admission\/deadline\/cancellation/],
  ['atomic style validation', 'tabBarState', 'let background_color = optional_color(payload, "backgroundColor")?;', 'let background_color = None;', /TabBar validated atomic/],
  ['catalog index bounds', 'tabBarState', '.filter(|index| *index < chrome.list.len())', '.filter(|index| *index < 5)', /TabBar validated atomic/],
  ['UTF16 policy', 'tabBarState', 'text.encode_utf16().count() > 4', 'text.len() > 4', /TabBar validated atomic/],
  ['color normalization', 'tabBarState', 'full.push(byte);', 'full.push(\'0\');', /TabBar normalized color/, 2],
  ['chrome projection', 'chrome', 'self.tab_bar_state.project(&mut chrome.tab_bar);', '', /TabBar actual chrome projection/],
  ['terminal retirement', 'runtimeLifecycle', 'self.tab_bar_state = crate::tab_bar::TabBarState::default();', '', /TabBar actual chrome projection/],
  ['independent metadata revision', 'nativeProvider', 'if observed != self.observed_chrome {', 'if false {', /TabBar independent metadata revision/],
  ['Player opt in', 'playerModel', 'systemTabBar: true,', 'systemTabBar: false,', /TabBar independent metadata revision/],
  ['Flutter opt in forwarding', 'flutterController', "if (systemTabBar) 'systemTabBar': true,", '', /Flutter trusted TabBar opt-in/],
  ['Android native forwarding', 'androidSession', 'if (systemTabBarEnabled) config.put("systemTabBar", true)', '', /Android Flutter-to-native/],
  ['iOS native forwarding', 'iosSession', 'if configuration.systemTabBar { config["systemTabBar"] = .bool(true) }', '', /iOS Flutter-to-native/],
  ['desktop native forwarding', 'desktopRegistry', 'if (args["systemTabBar"].get<bool>()) e->config["systemTabBar"] = true;', '', /Desktop\/macOS Flutter/],
  ['Flutter red dot paint', 'playerChrome', "widget.chrome.tabs[i]['redDot'] == true", 'false', /Player actual Flutter TabBar/],
  ['Flutter badge paint', 'playerChrome', "ValueKey('mini-program-tab-badge-$i')", "ValueKey('removed-badge-$i')", /Player actual Flutter TabBar/],
  ['same geometry metadata', 'playerChrome', "!_equal(_native!['chrome'], metadata)", 'false', /TabBar same-geometry/],
  ['SDK metadata forwarding', 'flutterView', '_controller.updateNativeChrome(snapshot)', '_controller.updateNativeChrome({})', /TabBar same-geometry/],
  ['installed native overlay', 'nativePreview', 'auto status = chrome_->update(value, std::move(action));', 'auto status = Status{};', /TabBar installed Windows\/Gtk/],
  ['native badge projection', 'nativeChrome', 'result.badge = item["badgeText"].get<std::string>();', 'result.badge = "";', /Native TabBar actual indicator/],
  ['native dot projection', 'nativeChrome', 'result.dot = item["redDot"].get<bool>();', 'result.dot = false;', /Native TabBar actual indicator/],
  ['Windows badge painter', 'nativeChrome', 'RoundRect(item.hDC, badge.left', 'RemovedDraw(item.hDC, badge.left', /Windows actual TabBar/],
  ['Gtk badge painter', 'nativeChrome', 'gtk_overlay_add_overlay(GTK_OVERLAY(overlay), badge)', 'removed_overlay_add_overlay(GTK_OVERLAY(overlay), badge)', /Gtk actual TabBar/],
]
const tabBarSourcePaths = {
  androidSession: 'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/WeappContainerSession.kt',
  chrome: 'crates/container-runtime/src/chrome.rs',
  desktopRegistry: 'sdk/flutter/native_desktop/src/registry.cpp',
  environment: 'crates/container-core/src/host_environment.rs',
  flutterController: 'sdk/flutter/weapp_container/lib/src/controller.dart',
  flutterView: 'sdk/flutter/weapp_container/lib/src/view.dart',
  iosSession: 'sdk/ios/Sources/WeappContainer/Session.swift',
  manifestPacker: 'tools/container-manifest/src/index.mjs',
  nativeChrome: 'sdk/flutter/native_desktop/include/native_chrome_overlay.hpp',
  nativePreview: 'sdk/flutter/native_desktop/include/native_preview_texture.hpp',
  nativeProvider: 'crates/container-sdk/src/lib.rs',
  playerChrome: 'apps/dev-player/lib/src/mini_program_chrome.dart',
  playerModel: 'apps/dev-player/lib/src/player_model.dart',
  runtime: 'crates/container-runtime/src/lib.rs',
  runtimeLifecycle: 'crates/container-runtime/src/lifecycle_notifications.rs',
  tabBar: 'crates/container-core/src/tab-bar.js',
  tabBarState: 'crates/container-runtime/src/tab_bar.rs',
}
for (const [name, id, before, after, error, expected = 1] of tabBarNegativeCases) test(`TabBar inventory rejects broken ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(tabBarSourcePaths[id], before, after, expected)), error)
})


test('route cleanup and Partial producers keep Done in its separate finite owner', async () => {
  const inventory = await inventoryCoreApis(catalog, read)
  const names = ['wx.onBeforeAppRoute', 'wx.offBeforeAppRoute', 'wx.onAppRoute', 'wx.offAppRoute', 'wx.rewriteRoute']
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) for (const name of names) {
    const entry = inventory.forHost(host, name), api = catalog.apis.find(api => api.name === name)
    const cleanup = ['wx.offBeforeAppRoute', 'wx.offAppRoute'].includes(name)
    assert.equal(resolveImplementation({api, core: entry}).implementationState, cleanup ? 'available' : 'partial')
    for (const id of ['routeNotifications', 'routeLease', 'hostInstaller', 'environment', 'quickjs', 'v8', 'runtimeRoutes', 'runtime', 'navigation', 'manifestPacker']) assert(entry.sources.some(source => source.id === id && source.role === 'runtimeImplementation'))
    if (cleanup) {
      assert.deepEqual(entry.missing, [])
      for (const id of ['boundary', 'hostServices']) assert(entry.sources.some(source => source.id === id))
    } else {
      for (const gap of ['appRouteFixedVersionEventParity', 'appRouteInitialSdkRecovery', 'appRouteInitialGeometryRewrite', 'appRoutePluginOwnership']) assert(entry.missing.includes(gap))
      assert.equal(entry.missing.includes('appRouteRewriteChaining'), ['wx.onBeforeAppRoute', 'wx.rewriteRoute'].includes(name))
    }
  }
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) for (const name of ['wx.onAppRouteDone', 'wx.offAppRouteDone']) {
    const entry = inventory.forHost(host, name), api = catalog.apis.find(api => api.name === name)
    assert.equal(resolveImplementation({api, core: entry}).implementationState, name === 'wx.offAppRouteDone' ? 'available' : 'partial')
    assert(entry.sources.some(source => source.id === 'finiteNotifications' && source.role === 'runtimeImplementation'))
    for (const id of ['routeNotifications', 'routeLease', 'runtimeRoutes']) assert(!entry.sources.some(source => source.id === id))
    assert.deepEqual(entry.missing, name === 'wx.offAppRouteDone' ? [] : [
      'finiteNotificationActualProducer', 'finiteNotificationFixedPayloadParity', 'finiteNotificationFixedTimingAndPluginParity',
    ])
  }
  assert(!inventory.apis.get('wx.router')?.sources.some(source => source.role === 'runtimeImplementation'))
})

for (const [label, path, before, after, error, expected = 1] of [
  ['shared installation', 'crates/container-core/src/host_environment.rs', 'include_str!("route-transaction.js")', 'include_str!("removed-route.js")', /Shared route transaction installation/],
  ['trusted publication', 'crates/container-core/src/host-environment-install.js', '__container_routes.install(capabilities);', '', /Route trusted capability publication/, 2],
  ['private admission', 'crates/container-core/src/route-transaction.js', "require('wx.onAppRoute')", "require('wx.removedAppRoute')", /Route private admission and revocation/],
  ['synchronous revocation cleanup', 'crates/container-core/src/route-transaction.js', 'splice(afterListeners, 0, afterListeners.length)', '', /Route private admission and revocation/, 2],
  ['native before preflight', 'crates/container-runtime/src/route_transaction.rs', 'validate_page_input(path, payload)?;', '', /Native route preparation input preflight/],
  ['owner lease retirement', 'crates/container-core/src/route_transaction.rs', 'self.slot.validator.borrow_mut().take()', 'None::<()>', /Route owner-thread rewrite lease/],
  ['retained QuickJS closure', 'crates/container-engine-quickjs/src/lib.rs', '"dispatchRouteNotification"', '"removedRouteNotification"', /Route retained native engine transport/],
  ['native V8 lease', 'crates/container-engine-v8/src/lib.rs', '.map(|validator| slot.begin(validator))', '.map(|validator| Ok(()))', /Route retained native engine transport/],
  ['Partial ceiling', 'crates/container-runtime/src/route_transaction.rs', 'min_support(support, CapabilitySupport::Partial)', 'support', /Route effective Partial ceiling/],
  ['native delivery guard', 'crates/container-runtime/src/route_transaction.rs', 'if self.effective_capability(api) == CapabilitySupport::Unsupported', 'if false', /Route native Unsupported delivery guard/],
  ['rewrite reservation', 'crates/container-runtime/src/route_transaction.rs', '*selection.borrow_mut() = Some(target);', '', /Route native rewrite authority/],
  ['after commit owner', 'crates/container-runtime/src/route_transaction.rs', 'let result = self.with_route_event_id(id, |session| action(session, &payload))?;', 'let result = action(self, &payload)?;', /Route after notification commit ownership/],
  ['deferred final target', 'crates/container-runtime/src/navigation_layout.rs', 'queued.payload = prepared.payload.clone();', '', /Route common admission and deferred prepared target/],
  ['prepared EventChannel id', 'crates/container-runtime/src/lib.rs', 'session.navigation_result_in_route(request, name, payload, engine_request_id)', 'session.navigation_result_in_route(request, name, payload, None)', /EventChannel immediate\/deferred navigation dispatch/, 2],
]) test(`Route inventory rejects broken ${label}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after, expected)), error)
})

for (const [name,path,before,after,error] of [
  ['private exact identity','crates/container-core/src/error-notifications.js','callbacks[index] !== callback','false',/Private error listener ownership/],
  ['optional remove all','crates/container-core/src/error-notifications.js','callback === undefined','callback === null',/Private error listener ownership/],
  ['host pair protection','crates/container-core/src/host-bridge.js','if (runtimeErrorApi(name) || retainedRuntimeApi(name) || runtimePageNotFoundApi(name) || runtimeUnhandledRejectionApi(name) || runtimeWindowResizeApi(name) || runtimeLifecycleApi(name)) return;','',/Error pair host registration boundary/],
  ['runtime registration denial','crates/container-runtime/src/host_services.rs','"wx.onError"','"wx.missingError"',/Error pair host registration boundary/],
  ['terminal cleanup','crates/container-core/src/lifecycle-notifications.js','__container_error_notifications.retire();','',/Trusted error notification publication or retirement/],
]) test(`error inventory rejects broken ${name}`,async()=>{
  await assert.rejects(inventoryCoreApis(catalog,changedRead(path,before,after)),error)
})

for (const [name,before,after] of [
  ['manifest publication bypass', 'name.clone(),\n                    self.effective_capability_with_provider(name, &provider),', 'name.clone(),\n                    CapabilitySupport::Full,'],
  ['registered extension omission', '.registered\n            .iter()\n            .chain(self.host_services.compatibility_cleanup_apis.iter())', '.compatibility_cleanup_apis\n            .iter()'],
]) test(`capability inventory rejects ${name}`,async()=>{
  await assert.rejects(inventoryCoreApis(catalog,changedRead('crates/container-runtime/src/lib.rs',before,after)),/Shared capability publication and admission policy/)
})


// Scheduler inventory describes source boundaries only. Actual host acceptance
// stays explicit even while the source provides a retained next-turn driver.
test('turn scheduler inventory uses the private source chain without a pixel-presentation requirement or host promotion', async () => {
  const result = await inventoryCoreApis(catalog, read)
  assert.equal(Object.keys(result.sources).length, 134)
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) {
    for (const [name, missing] of [
      ['wx.nextTick', ['actualHostNextTurnPumpAcceptance']],
      ['wx.requestIdleCallback', ['actualHostIdleOpportunityProducer', 'fixedIdleCallbackDeclarationParity']],
      ['wx.cancelIdleCallback', []],
    ]) {
      const entry = result.forHost(host, name)
      assert.deepEqual(entry.missing, missing)
      for (const id of ['turnScheduler', 'runtimeTurnScheduler', 'environment', 'hostInstaller', 'lifecycleNotifications', 'timerTasks', 'quickjs', 'v8', 'runtime']) assert(entry.sources.some(source => source.id === id && source.role === 'runtimeImplementation'))
      assert.equal(resolveImplementation({ api: catalog.apis.find(api => api.name === name), core: entry }).implementationState, name === 'wx.cancelIdleCallback' ? 'available' : 'partial')
      assert(!entry.missing.includes('renderTransactionNextTick'))
      assert(!entry.scopes.some(scope => scope.includes('Engine Promise microtask callback')))
    }
    assert(result.forHost(host, 'wx.nextTick').scopes.some(scope => scope.includes('does not require completed pixel presentation')))
  }
})

const schedulerNegativeCases = [
  ['shared installation', 'crates/container-core/src/host_environment.rs', 'include_str!("turn-scheduler.js")', 'include_str!("removed-scheduler.js")', /Shared private turn scheduler installation/],
  ['private retained capture', 'crates/container-core/src/host_environment.rs', 'return __container_turn_scheduler.capture(request);', 'return globalThis.__container_turn_scheduler.capture(request);', /Shared private turn scheduler installation/],
  ['captured native clock', 'crates/container-core/src/host_environment.rs', 'const __host_scheduler_clock = globalThis.__container_host_performance_now;', 'const __host_scheduler_clock = Date.now;', /Shared private turn scheduler installation/],
  ['void nextTick entry', 'crates/container-core/src/turn-scheduler.js', "function(callback) { register('tick', callback); }", "function(callback) { return register('tick', callback); }", /Private turn scheduler public entry changed: nextTick/],
  ['idle entry', 'crates/container-core/src/turn-scheduler.js', "return register('idle', callback, options);", "return register('tick', callback, options);", /Private turn scheduler public entry changed: requestIdleCallback/],
  ['cancel entry', 'crates/container-core/src/turn-scheduler.js', "function(id) { cancel(id); }", "function(id) { return id; }", /Private turn scheduler public entry changed: cancelIdleCallback/],
  ['pending budget', 'crates/container-core/src/turn-scheduler.js', 'const maximumPending = 1024;', 'const maximumPending = Infinity;', /Private turn scheduler admission, frontier or budget/],
  ['dispatch budget', 'crates/container-core/src/turn-scheduler.js', 'const maximumDispatch = 64;', 'const maximumDispatch = Infinity;', /Private turn scheduler admission, frontier or budget/],
  ['owner admission snapshot', 'crates/container-core/src/turn-scheduler.js', 'record.owner = admittedOwner;', 'record.owner = null;', /Private turn scheduler admission, frontier or budget/],
  ['frozen tick frontier', 'crates/container-core/src/turn-scheduler.js', 'turn.ticks[turn.tickLength++] = record;', 'turn.ticks[turn.tickLength++] = head;', /Private turn scheduler admission, frontier or budget/],
  ['stale queue prune', 'crates/container-core/src/turn-scheduler.js', 'if (!live(record.owner)) { remove(record); continue; }', 'if (false) { remove(record); continue; }', /Private turn scheduler admission, frontier or budget/, 2],
  ['private receiver identity', 'crates/container-core/src/turn-scheduler.js', 'weakGet(__receiver_weak, entry.receiver) !== entry', 'false', /Private turn scheduler receiver lifetime or policy/],
  ['incarnation token', 'crates/container-core/src/turn-scheduler.js', 'page.token !== (entry.scopeId === null ? entry.token : entry.pageToken)', 'false', /Private turn scheduler receiver lifetime or policy/],
  ['private owner restoration', 'crates/container-core/src/turn-scheduler.js', 'owner = previous;', 'owner = null;', /Private turn scheduler receiver lifetime or policy/, 2],
  ['Partial publication', 'crates/container-core/src/turn-scheduler.js', "tickOn ? 'partial' : 'unsupported'", "tickOn ? 'full' : 'unsupported'", /Private turn scheduler receiver lifetime or policy/],
  ['timer readiness', 'crates/container-core/src/turn-scheduler.js', "typeof timerReady === 'function' && !apply(timerReady, root, [])", 'true', /Private turn scheduler idle opportunity, timeout or cancellation/],
  ['tick priority', 'crates/container-core/src/turn-scheduler.js', '!turn.didTick && !pendingTick()', 'true', /Private turn scheduler idle opportunity, timeout or cancellation/],
  ['timeout fallback', 'crates/container-core/src/turn-scheduler.js', 'record.deadline !== null && record.deadline <= current', 'true', /Private turn scheduler idle opportunity, timeout or cancellation/],
  ['idle-only cancellation', 'crates/container-core/src/turn-scheduler.js', "if (record && record.kind === 'idle') remove(record);", 'if (record) remove(record);', /Private turn scheduler idle opportunity, timeout or cancellation/],
  ['policy reinstallation', 'crates/container-core/src/host-environment-install.js', '__container_turn_scheduler.install(capabilities);', '', /Trusted turn scheduler lifecycle or policy/, 2],
  ['terminal retirement', 'crates/container-core/src/lifecycle-notifications.js', '__container_turn_scheduler.retire();', '', /Trusted turn scheduler lifecycle or policy/],
  ['visibility suspension', 'crates/container-core/src/lifecycle-notifications.js', "__container_turn_scheduler.visibility(name === 'show');", '', /Trusted turn scheduler lifecycle or policy/],
  ['QuickJS callback checkpoint', 'crates/container-engine-quickjs/src/lib.rs', 'Some(true) => self.drain_microtasks()?', 'Some(true) => ()', /Native retained turn scheduler checkpoints changed: quickjs/],
  ['V8 callback checkpoint', 'crates/container-engine-v8/src/lib.rs', 'Some(true) => self.drain_microtasks()?', 'Some(true) => ()', /Native retained turn scheduler checkpoints changed: v8/],
  ['native absolute idle deadline', 'crates/container-engine-v8/src/lib.rs', 'deadline > TurnSchedulerInstant::now()', 'true', /Native retained turn scheduler checkpoints changed: v8/],
  ['Session timer poll', 'crates/container-runtime/src/lib.rs', 'self.drain_engine_turn_scheduler(None)?;', '', /Session next-turn timer poll boundary/],
  ['Session idle opportunity', 'crates/container-runtime/src/turn_scheduler.rs', 'session.drain_engine_turn_scheduler(Some(opportunity.deadline))?;', 'session.drain_engine_turn_scheduler(None)?;', /Session retained idle opportunity driver/],
  ['Session idle effect drain', 'crates/container-runtime/src/turn_scheduler.rs', 'session.append_engine_effects(&mut messages)?;', '', /Session retained idle opportunity driver/],
  ['Session scheduler ceiling', 'crates/container-runtime/src/lib.rs', '"wx.nextTick" | "wx.requestIdleCallback"', '"wx.nextTick"', /Session turn scheduler Partial ceiling/],
]
for (const [name, path, before, after, error, expected = 1] of schedulerNegativeCases) test(`turn scheduler inventory rejects broken ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after, expected)), error)
})


// Independent review controls: executable evidence cannot be a comment/string
// decoy, a detached private method, or a changed TabBar condition.
const schedulerExecutableNegativeCases = [
  [
    "tabbar-negated",
    "crates/container-runtime/src/lib.rs",
    "let ceiling =\n            if tab_bar::is_api(name)",
    "let ceiling = if !tab_bar::is_api(name)",
    1,
    "TabBar explicit presenter admission"
  ],
  [
    "tabbar-disabled",
    "crates/container-runtime/src/lib.rs",
    "let ceiling =\n            if tab_bar::is_api(name)",
    "let ceiling = if false && tab_bar::is_api(name)",
    1,
    "TabBar explicit presenter admission"
  ],
  [
    "tabbar-excludes-style",
    "crates/container-runtime/src/lib.rs",
    "let ceiling =\n            if tab_bar::is_api(name)",
    "let ceiling =\n            if tab_bar::is_api(name) && name != \"wx.setTabBarStyle\"",
    1,
    "TabBar explicit presenter admission"
  ],
  [
    "tick-install-comment",
    "crates/container-core/src/turn-scheduler.js",
    "put(wx, 'nextTick', function(callback) { register('tick', callback); });",
    "/* put(wx, 'nextTick', function(callback) { register('tick', callback); }); */ put(wx, 'nextTick', function(callback) {});",
    1,
    "Private turn scheduler public entry changed: nextTick"
  ],
  [
    "tick-install-string",
    "crates/container-core/src/turn-scheduler.js",
    "put(wx, 'nextTick', function(callback) { register('tick', callback); });",
    "const unusedInventoryProof = \"put(wx, 'nextTick', function(callback) { register('tick', callback); });\"; put(wx, 'nextTick', function(callback) {});",
    1,
    "Private turn scheduler public entry changed: nextTick"
  ],
  [
    "owner-comment",
    "crates/container-core/src/turn-scheduler.js",
    "record.owner = admittedOwner;",
    "/* record.owner = admittedOwner; */ record.owner = null;",
    1,
    "Private turn scheduler admission, frontier or budget"
  ],
  [
    "frontier-comment",
    "crates/container-core/src/turn-scheduler.js",
    "turn.ticks[turn.tickLength++] = record;",
    "/* turn.ticks[turn.tickLength++] = record; */ turn.ticks[turn.tickLength++] = head;",
    1,
    "Private turn scheduler admission, frontier or budget"
  ],
  [
    "pending-limit-comment",
    "crates/container-core/src/turn-scheduler.js",
    "const maximumPending = 1024;",
    "/* const maximumPending = 1024; */ const maximumPending = Infinity;",
    1,
    "Private turn scheduler admission, frontier or budget"
  ],
  [
    "receiver-comment",
    "crates/container-core/src/turn-scheduler.js",
    "weakGet(__receiver_weak, entry.receiver) !== entry",
    "/* weakGet(__receiver_weak, entry.receiver) !== entry */ false",
    1,
    "Private turn scheduler receiver lifetime or policy"
  ],
  [
    "cancel-comment",
    "crates/container-core/src/turn-scheduler.js",
    "if (record && record.kind === 'idle') remove(record);",
    "/* if (record && record.kind === 'idle') remove(record); */ if (record) remove(record);",
    1,
    "Private turn scheduler idle opportunity, timeout or cancellation"
  ],
  [
    "private-capture-comment",
    "crates/container-core/src/host_environment.rs",
    "if (__receiver_value(request, \"kind\") === \"turn-scheduler\") return __container_turn_scheduler.capture(request);",
    "/* if (__receiver_value(request, \"kind\") === \"turn-scheduler\") return __container_turn_scheduler.capture(request); */ if (__receiver_value(request, \"kind\") === \"turn-scheduler\") return null;",
    1,
    "Shared private turn scheduler installation"
  ],
  [
    "trusted-install-comment",
    "crates/container-core/src/host-environment-install.js",
    "__container_turn_scheduler.install(capabilities);",
    "/* __container_turn_scheduler.install(capabilities); */ ;",
    2,
    "Trusted turn scheduler lifecycle or policy"
  ],
  [
    "retire-comment",
    "crates/container-core/src/lifecycle-notifications.js",
    "__container_turn_scheduler.retire();",
    "/* __container_turn_scheduler.retire(); */ ;",
    1,
    "Trusted turn scheduler lifecycle or policy"
  ],
  [
    "qjs-checkpoint-comment",
    "crates/container-engine-quickjs/src/lib.rs",
    "Some(true) => self.drain_microtasks()?",
    "Some(true) => { /* Some(true) => self.drain_microtasks()? */ }",
    1,
    "Native retained turn scheduler checkpoints changed: quickjs"
  ],
  [
    "v8-checkpoint-comment",
    "crates/container-engine-v8/src/lib.rs",
    "Some(true) => self.drain_microtasks()?",
    "Some(true) => { /* Some(true) => self.drain_microtasks()? */ }",
    1,
    "Native retained turn scheduler checkpoints changed: v8"
  ],
  [
    "qjs-public-driver-detached",
    "crates/container-engine-quickjs/src/lib.rs",
    "self.with_execution(|engine| engine.poll_turn_scheduler_within_turn(idle_deadline))",
    "Ok(())",
    1,
    "Native retained turn scheduler checkpoints changed: quickjs"
  ],
  [
    "v8-public-driver-detached",
    "crates/container-engine-v8/src/lib.rs",
    "self.poll_turn_scheduler_within_turn(idle_deadline)",
    "Ok(())",
    1,
    "Native retained turn scheduler checkpoints changed: v8"
  ],
  [
    "session-poll-comment",
    "crates/container-runtime/src/lib.rs",
    "self.drain_engine_turn_scheduler(None)?;",
    "/* self.drain_engine_turn_scheduler(None)?; */ ;",
    1,
    "Session next-turn timer poll boundary"
  ],
  [
    "session-idle-comment",
    "crates/container-runtime/src/turn_scheduler.rs",
    "session.drain_engine_turn_scheduler(Some(opportunity.deadline))?;",
    "/* session.drain_engine_turn_scheduler(Some(opportunity.deadline))?; */ ;",
    1,
    "Session retained idle opportunity driver"
  ],
  [
    "session-engine-forwarding-comment",
    "crates/container-runtime/src/turn_scheduler.rs",
    ".poll_turn_scheduler(idle_deadline)",
    "/* .poll_turn_scheduler(idle_deadline) */",
    2,
    "Session retained idle opportunity driver"
  ]
]
for (const [name, path, before, after, expected, message] of schedulerExecutableNegativeCases) test(`turn scheduler executable inventory rejects ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after, expected)), error => error.message.includes(message))
})


test('executable scheduler evidence tolerates JavaScript trivia around a live statement', async () => {
  const result = await inventoryCoreApis(catalog, changedRead('crates/container-core/src/turn-scheduler.js',
    'record.owner = admittedOwner;', '/* real owner capture */ record /* member */ . owner = admittedOwner ;'))
  assert.deepEqual(result.apis.get('wx.nextTick').missing, ['actualHostNextTurnPumpAcceptance'])
})

test('scheduler Rust source identity requires review for benign Partial-condition trivia', async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead('crates/container-runtime/src/lib.rs',
    'let ceiling =\n            if tab_bar::is_api(name)', 'let ceiling =\n if tab_bar /* retained scope */ :: is_api ( name )')),
  /Session runtime scheduler Rust source bytes changed; source evidence requires review/)
})


// Follow-up review: live anchors also need their reviewed control flow.
const schedulerUnreachableNegativeCases = [
  [
    "tick-false-and",
    "crates/container-core/src/turn-scheduler.js",
    "put(wx, 'nextTick', function(callback) { register('tick', callback); });",
    "false && put(wx, 'nextTick', function(callback) { register('tick', callback); });",
    1,
    "Private turn scheduler public entry changed: nextTick"
  ],
  [
    "tick-if-false-unbraced",
    "crates/container-core/src/turn-scheduler.js",
    "put(wx, 'nextTick', function(callback) { register('tick', callback); });",
    "if(false) put(wx, 'nextTick', function(callback) { register('tick', callback); });",
    1,
    "Private turn scheduler public entry changed: nextTick"
  ],
  [
    "tick-after-return",
    "crates/container-core/src/turn-scheduler.js",
    "put(wx, 'nextTick', function(callback) { register('tick', callback); });",
    "return; put(wx, 'nextTick', function(callback) { register('tick', callback); });",
    1,
    "Private turn scheduler public entry changed: nextTick"
  ],
  [
    "frontier-if-false",
    "crates/container-core/src/turn-scheduler.js",
    "turn.ticks[turn.tickLength++] = record;",
    "if(false){turn.ticks[turn.tickLength++] = record;}",
    1,
    "executable control flow"
  ],
  [
    "trusted-install-false-and",
    "crates/container-core/src/host-environment-install.js",
    "__container_turn_scheduler.install(capabilities);",
    "false && __container_turn_scheduler.install(capabilities);",
    2,
    "Trusted turn scheduler installer control flow"
  ],
  [
    "tick-install-regexp",
    "crates/container-core/src/turn-scheduler.js",
    "put(wx, 'nextTick', function(callback) { register('tick', callback); });",
    "const unusedInventoryProof = /put(wx, 'nextTick', function(callback) { register('tick', callback); });/; put(wx, 'nextTick', function(callback) {});",
    1,
    "Private turn scheduler public entry changed: nextTick"
  ]
]
for (const [name, path, before, after, expected, message] of schedulerUnreachableNegativeCases) test(`turn scheduler executable inventory rejects ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after, expected)), error => error.message.includes(message))
})


// Independent ASI controls: parse original bytes, including all line terminators.
const schedulerAsiCases = [
  [
    "idle-return-line-break",
    "crates/container-core/src/turn-scheduler.js",
    "return register('idle', callback, options);",
    "return\nregister('idle', callback, options);",
    "reject"
  ],
  [
    "idle-return-comment-line-break",
    "crates/container-core/src/turn-scheduler.js",
    "return register('idle', callback, options);",
    "return/*\n*/register('idle', callback, options);",
    "reject"
  ],
  [
    "line-comment-carriage-return",
    "crates/container-core/src/turn-scheduler.js",
    "return register('idle', callback, options);",
    "// lexical comment\rreturn;\nreturn register('idle', callback, options);",
    "reject"
  ],
  [
    "line-comment-line-separator",
    "crates/container-core/src/turn-scheduler.js",
    "return register('idle', callback, options);",
    "// lexical comment\u2028return;\nreturn register('idle', callback, options);",
    "reject"
  ],
  [
    "line-comment-paragraph-separator",
    "crates/container-core/src/turn-scheduler.js",
    "return register('idle', callback, options);",
    "// lexical comment\u2029return;\nreturn register('idle', callback, options);",
    "reject"
  ],
  [
    "idle-live-comment-trivia",
    "crates/container-core/src/turn-scheduler.js",
    "return register('idle', callback, options);",
    "return /* ordinary comment */ register('idle', callback, options);",
    "accept"
  ]
]
for (const [name, path, before, after, expected] of schedulerAsiCases) test(`turn scheduler AST inventory ${expected}s ${name}`, async () => {
  if (expected === 'reject') await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after)))
  else assert.deepEqual((await inventoryCoreApis(catalog, changedRead(path, before, after))).apis.get('wx.requestIdleCallback').missing, ['actualHostIdleOpportunityProducer', 'fixedIdleCallbackDeclarationParity'])
})

const schedulerAstFormattingCases = [
  [
    "multiline arguments",
    "return register('idle', callback, options);",
    "return register(\n  'idle',\n  callback, /* argument comment */\n  options\n);"
  ],
  [
    "parenthesized multiline return",
    "return register('idle', callback, options);",
    "return (\n  register('idle', callback, options)\n);"
  ],
  [
    "optional semicolon",
    "return register('idle', callback, options);",
    "return register('idle', callback, options)"
  ],
  [
    "escaped literal spelling",
    "return register('idle', callback, options);",
    "return register('\\x69dle', callback, options);"
  ]
]
for (const [name, before, after] of schedulerAstFormattingCases) test(`turn scheduler AST evidence accepts ${name}`, async () => {
  const result = await inventoryCoreApis(catalog, changedRead('crates/container-core/src/turn-scheduler.js', before, after))
  assert.deepEqual(result.apis.get('wx.requestIdleCallback').missing, ['actualHostIdleOpportunityProducer', 'fixedIdleCallbackDeclarationParity'])
})

const schedulerAstBoundaryCases = [
  [
    "receiver bootstrap early return",
    "crates/container-core/src/host_environment.rs",
    "function __receiver_capture(request)",
    "return;\nfunction __receiver_capture(request)"
  ],
  [
    "retained installer early return",
    "crates/container-core/src/host-environment-install.js",
    "return function(snapshot)",
    "return;\nreturn function(snapshot)"
  ],
  [
    "scheduler closure not invoked",
    "crates/container-core/src/turn-scheduler.js",
    "\n})();\n",
    "\n});\n"
  ]
]
for (const [name, path, before, after] of schedulerAstBoundaryCases) test(`turn scheduler AST inventory rejects ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after)))
})


// Independent complete-bootstrap composition counterexamples.
const schedulerBootstrapAssemblyCases = [
  [
    "assembly-early-return-before-scheduler",
    "crates/container-core/src/host_environment.rs",
    "        include_str!(\"turn-scheduler.js\"),",
    "        \"\\nreturn;\\n\",\n        include_str!(\"turn-scheduler.js\"),"
  ],
  [
    "installer-wrapper-early-return",
    "crates/container-core/src/host_environment.rs",
    "\"\\nconst __host_install_environment = (function() {\\n\",",
    "\"\\nconst __host_install_environment = (function() {\\nreturn;\\n\","
  ],
  [
    "assembly-return-null",
    "crates/container-core/src/host_environment.rs",
    "\"\\nreturn { installHostEnvironment:",
    "\"\\nreturn null; return { installHostEnvironment:"
  ],
  [
    "assembly-closure-not-invoked",
    "crates/container-core/src/host_environment.rs",
    "};\\n})()\",",
    "};\\n})\","
  ]
]
for (const [name, path, before, after] of schedulerBootstrapAssemblyCases) test(`turn scheduler complete bootstrap rejects ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after)))
})

const schedulerBootstrapSchemaCases = [
  [
    "reordered scheduler and page mirror",
    "        include_str!(\"page-mirror.js\"),\n        include_str!(\"turn-scheduler.js\"),",
    "        include_str!(\"turn-scheduler.js\"),\n        include_str!(\"page-mirror.js\"),"
  ],
  [
    "duplicate facade instead of receiver",
    "        RECEIVER_INCARNATIONS,",
    "        facade,"
  ],
  [
    "extra contribution expression",
    "        facade,",
    "        { facade },"
  ],
  [
    "removed source slot",
    "        include_str!(\"component-relations.js\"),\n",
    ""
  ],
  [
    "unparsed final expression",
    "    .concat()\n",
    "    .concat(); String::new()\n"
  ],
  [
    "extra source expression after last comma",
    "    ]\n    .concat()",
    "        facade\n    ]\n    .concat()"
  ]
]
for (const [name, before, after] of schedulerBootstrapSchemaCases) test(`turn scheduler complete bootstrap rejects ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead('crates/container-core/src/host_environment.rs', before, after)))
})

const schedulerBootstrapTriviaCases = [
  [
    "Rust include comments",
    "        include_str!(\"turn-scheduler.js\"),",
    "        /* reviewed source slot */ include_str! ( \"turn-scheduler.js\" ) ,"
  ],
  [
    "Rust concat whitespace",
    "    .concat()\n",
    "    /* reviewed tail */ . concat ( )\n"
  ],
  [
    "decoded raw literal wrapper",
    "        \"\\n})();\\n\",",
    "        r#\"\n})();\n\"#,"
  ]
]
// Whole-file Rust identity is intentional: these benign edits need a new pin review.
for (const [name, before, after] of schedulerBootstrapTriviaCases) test(`turn scheduler Rust byte pin requires review for ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead('crates/container-core/src/host_environment.rs', before, after)))
})


test('turn scheduler complete bootstrap rejects a byte string in a str slot', async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead('crates/container-core/src/host_environment.rs',
    '        "\\n})();\\n",', '        br#"\n})();\n"#,')))
})


// Exact ordinary Rust correctness fixtures from the independent v4 review.
const schedulerRustCorrectnessCases = [
  [
    "clock-string-continuation",
    "crates/container-core/src/host_environment.rs",
    "const __host_scheduler_clock",
    "const\\\n __host_scheduler_clock"
  ],
  [
    "installer-string-continuation",
    "crates/container-core/src/host_environment.rs",
    "const __host_install_environment",
    "const\\\n __host_install_environment"
  ],
  [
    "facade-parameter-binding",
    "crates/container-core/src/host_environment.rs",
    "pub fn app_service_environment_bootstrap(facade: &str) -> String {",
    "const facade: &str = \"\";\npub fn app_service_environment_bootstrap(_facade: &str) -> String {"
  ]
]
for (const [name, path, before, after] of schedulerRustCorrectnessCases) test(`turn scheduler Rust byte pin rejects ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, before, after)))
})


// A reviewed Rust method body cannot establish parameter or cfg binding.
// These controls preserve the old body-token evidence while changing the
// declaration context. Whole-file identity must require a new source review.
const schedulerRustDeclarationCases = [
  ['QuickJS private driver parameter', 'crates/container-engine-quickjs/src/lib.rs', 'fn poll_turn_scheduler_within_turn(', 'idle_deadline', 'QuickJS retained turn scheduler'],
  ['V8 private driver parameter', 'crates/container-engine-v8/src/lib.rs', 'fn poll_turn_scheduler_within_turn(', 'idle_deadline', 'V8 retained turn scheduler'],
  ['Session timer parameter', 'crates/container-runtime/src/lib.rs', 'fn poll_timers_within_turn(', 'now_ns', 'Session runtime scheduler'],
  ['Session idle parameter', 'crates/container-runtime/src/turn_scheduler.rs', 'pub fn poll_idle(', 'opportunity', 'Session retained idle scheduler'],
  ['Session forwarding parameter', 'crates/container-runtime/src/turn_scheduler.rs', 'fn drain_engine_turn_scheduler(', 'idle_deadline', 'Session retained idle scheduler'],
  ['Session capability parameter', 'crates/container-runtime/src/lib.rs', 'fn effective_capability_with_provider(', 'name', 'Session runtime scheduler'],
  ['Session capability wrapper parameter', 'crates/container-runtime/src/lib.rs', 'fn effective_capability(', 'name', 'Session runtime scheduler'],
]
for (const [name, path, declaration, parameter, boundary] of schedulerRustDeclarationCases) test(`scheduler Rust source identity rejects unbound ${name}`, async () => {
  const original = await read(path), first = original.indexOf(declaration)
  assert(first >= 0)
  assert.equal(original.indexOf(declaration, first + declaration.length), -1)
  const end = original.indexOf('{', first)
  assert(end > first)
  const signature = original.slice(first, end), pattern = new RegExp(`\\b${parameter}\\b`, 'g')
  assert.equal([...signature.matchAll(pattern)].length, 1)
  const changed = original.slice(0, first) + signature.replace(pattern, '__inventory_unbound_parameter') + original.slice(end)
  await assert.rejects(inventoryCoreApis(catalog, async target => target === path ? changed : read(target)),
    error => error.message === `${boundary} Rust source bytes changed; source evidence requires review`)
})
for (const [name, path, declaration, , boundary] of schedulerRustDeclarationCases.slice(0, 4).filter((_, index) => index !== 2)) test(`scheduler Rust source identity rejects disabled ${name}`, async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead(path, declaration, `#[cfg(any())]\n    ${declaration}`)),
    error => error.message === `${boundary} Rust source bytes changed; source evidence requires review`)
})
for (const [name, path, boundary] of [
  ['QuickJS', 'crates/container-engine-quickjs/src/lib.rs', 'QuickJS retained turn scheduler'],
  ['V8', 'crates/container-engine-v8/src/lib.rs', 'V8 retained turn scheduler'],
  ['runtime', 'crates/container-runtime/src/lib.rs', 'Session runtime scheduler'],
  ['idle driver', 'crates/container-runtime/src/turn_scheduler.rs', 'Session retained idle scheduler'],
]) test(`scheduler Rust source identity requires review for ${name} file trivia`, async () => {
  const original = await read(path)
  await assert.rejects(inventoryCoreApis(catalog, async target => target === path ? original + '\n// Deliberate reviewed-source change.\n' : read(target)),
    error => error.message === `${boundary} Rust source bytes changed; source evidence requires review`)
})


// These controls bind complete lexical/native ownership for four finite cleanup
// contracts. Pure Node source eligibility cannot establish native/host execution.
const cleanupNames = ['wx.offBeforeAppRoute', 'wx.offAppRoute', 'wx.cancelIdleCallback', 'wx.offPageNotFound']
const cleanupHosts = ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']
test('the four existing reviewed cleanup methods preserve 28 conditional source cells', async () => {
  const result = await inventoryCoreApis(catalog, read)
  for (const host of cleanupHosts) for (const name of cleanupNames) {
    const entry = result.forHost(host, name)
    assert.deepEqual(entry.missing, [])
    assert.equal(resolveImplementation({ api: catalog.apis.find(api => api.name === name), core: entry }).implementationState, 'available')
    for (const id of ['boundary', 'hostServices', 'environment', 'hostInstaller', 'lifecycleNotifications', 'quickjs', 'v8', 'runtime']) assert(entry.sources.some(source => source.id === id))
  }
  assert.deepEqual(result.apis.get('wx.onPageNotFound').missing, ['pageNotFoundDispatch'])
  assert.deepEqual(result.apis.get('wx.requestIdleCallback').missing, ['actualHostIdleOpportunityProducer', 'fixedIdleCallbackDeclarationParity'])
  assert.deepEqual(result.apis.get('object:PerformanceObserver.disconnect').missing, [])
})
for (const name of cleanupNames) for (const mutation of ['required', 'name', 'type', 'return', 'overload', 'owner', 'kind', 'baseline', 'counterpart']) {
  test(`cleanup signature requires exact ${name} ${mutation}`, async () => {
    const changed = structuredClone(catalog), api = changed.apis.find(api => api.name === name)
    if (mutation === 'required') api.signatures[0].parameters[0].optional = !api.signatures[0].parameters[0].optional
    if (mutation === 'name') api.signatures[0].parameters[0].name = 'changed'
    if (mutation === 'type') api.signatures[0].parameters[0].type = 'unknown'
    if (mutation === 'return') api.signatures[0].returns = 'number'
    if (mutation === 'overload') api.signatures.push({ parameters: [], returns: 'void' })
    if (mutation === 'owner') api.owner = 'host'
    if (mutation === 'kind') api.kind = 'syncLocal'
    if (mutation === 'baseline') api.baseline = 'excluded'
    if (mutation === 'counterpart') api.counterpart = 'wx.changed'
    await assert.rejects(inventoryCoreApis(changed, read), /Cleanup locked signature changed/)
  })
}
const finiteCleanupMutations = [
  ['route different-list cleanup', 'route-transaction.js', "require('wx.offAppRoute'); remove(afterListeners, callback);", "require('wx.offAppRoute'); remove(beforeListeners, callback);", ['wx.offAppRoute', 'wx.offBeforeAppRoute']],
  ['route comment decoy cleanup', 'route-transaction.js', "require('wx.offAppRoute'); remove(afterListeners, callback);", "/* require('wx.offAppRoute'); remove(afterListeners, callback); */", ['wx.offAppRoute', 'wx.offBeforeAppRoute']],
  ['route nonvoid cleanup', 'route-transaction.js', "function(callback) { require('wx.offAppRoute'); remove(afterListeners, callback); }", "function(callback) { require('wx.offAppRoute'); return remove(afterListeners, callback); }", ['wx.offAppRoute', 'wx.offBeforeAppRoute']],
  ['PageNotFound callback identity', 'page-not-found-notifications.js', 'callbacks[index] !== callback', 'false', ['wx.offPageNotFound']],
  ['PageNotFound remove all', 'page-not-found-notifications.js', 'callback === undefined', 'callback === null', ['wx.offPageNotFound']],
  ['PageNotFound projection authority', 'page-not-found-notifications.js', 'let callbacks = create(null);', 'let callbacks = __container_app_listeners.pageNotFound;', ['wx.offPageNotFound']],
  ['PageNotFound delayed admission revocation', 'page-not-found-notifications.js', 'on = nextOn;\n    off = nextOff;\n    if (!nextOn) clear(true);', 'if (!nextOn) clear(true);\n    on = nextOn;\n    off = nextOff;', ['wx.offPageNotFound']],
  ['PageNotFound snapshot generations', 'page-not-found-notifications.js', 'generation !== admitted', 'false', ['wx.offPageNotFound']],
  ['PageNotFound terminal fence', 'page-not-found-notifications.js', 'retired = true;', 'retired = false;', ['wx.offPageNotFound']],
  ['stale counterpart runtime descriptor', 'host-bridge.js', '!retainedRuntimeApi(descriptor.counterpart)', 'true', cleanupNames],
  ['stale Page counterpart descriptor', 'host-bridge.js', '!runtimePageNotFoundApi(descriptor.counterpart)', 'true', cleanupNames],
]
for (const [label, file, before, after, names] of finiteCleanupMutations) test(`cleanup source identity rejects ${label}`, async () => {
  const result = await inventoryCoreApis(catalog, changedRead('crates/container-core/src/' + file, before, after))
  for (const name of names) {
    assert(result.apis.get(name).missing.some(gap => gap.startsWith('reviewed')))
    assert.equal(resolveImplementation({ api: catalog.apis.find(api => api.name === name), core: result.apis.get(name) }).implementationState, 'partial')
  }
})
for (const [file, names] of [
  ['route-transaction.js', ['wx.offBeforeAppRoute', 'wx.offAppRoute']],
  ['page-not-found-notifications.js', ['wx.offPageNotFound']],
  ['host-bridge.js', cleanupNames],
]) test(`cleanup semantic AST tolerates trivia in ${file}`, async () => {
  const result = await inventoryCoreApis(catalog, async path => path === 'crates/container-core/src/' + file ? '// source trivia\n' + await read(path) : read(path))
  for (const name of names) assert.deepEqual(result.apis.get(name).missing, [])
})
for (const [file, names] of [
  ['crates/container-runtime/src/host_services.rs', cleanupNames],
  ['crates/container-runtime/src/route_transaction.rs', ['wx.offBeforeAppRoute', 'wx.offAppRoute']],
]) test(`cleanup whole Rust source identity requires review for trivia in ${file}`, async () => {
  const result = await inventoryCoreApis(catalog, async path => path === file ? '// source trivia\n' + await read(path) : read(path))
  for (const name of names) assert(result.apis.get(name).missing.some(gap => gap.startsWith('reviewed')))
})

test('cleanup direct descriptor bypass also fails the existing error-owner boundary', async () => {
  await assert.rejects(inventoryCoreApis(catalog, changedRead('crates/container-core/src/host-bridge.js',
    'runtimeErrorApi(name) || retainedRuntimeApi(name) || runtimePageNotFoundApi(name) || runtimeUnhandledRejectionApi(name) || runtimeWindowResizeApi(name)',
    'runtimeErrorApi(name) || runtimePageNotFoundApi(name) || runtimeUnhandledRejectionApi(name) || runtimeWindowResizeApi(name)')), /Error pair host registration boundary/)
})

// This separate layer proposes two finite source contracts only. Native/control
// and workspace validation of the exact union is required before root adoption.
const retainedRemovalNames = ['wx.offUnhandledRejection', 'wx.offWindowResize']

test('finite notifications account for exactly210 Available removals and210 Partial producers within all8855 cells', async () => {
  const inventory = await inventoryCoreApis(catalog, read)
  assert.equal(inventory.sources.finiteNotifications.path, 'crates/container-core/src/finite-notifications.js')
  assert.equal(inventory.sources.finiteNotificationResources.path, 'crates/container-runtime/src/finite_notifications.rs')
  const matrix = JSON.parse(await read('docs/host-services/api-matrix.json'))
  assert.equal(catalog.apis.length, 1265)
  let cells = 0, changes = 0, notApplicable = 0, ordinaryAvailable = 0, ordinaryPartial = 0
  for (const api of catalog.apis) {
    const beforeApi = matrix.apis.find(item => item.name === api.name)
    assert(beforeApi)
    for (const [host, before] of Object.entries(beforeApi.hosts)) {
      cells++
      const core = inventory.forHost(host, api.name)
      const implementation = resolveImplementation({ api, core,
        registeredSources: before.sources.filter(source => source.role === 'platformProvider'),
        delegated: before.implementation === 'delegated', parameterLimit: before.parameterLimit,
      })
      // Source accounting has no authority to change acceptance or coverage.
      assert(!Object.hasOwn(implementation, 'status') && !Object.hasOwn(implementation, 'coverage'))
      if (before.status === 'platformNotApplicable') notApplicable++
      if (objectNotificationOffNames.has(api.name)) {
        assert.equal(implementation.implementationState, 'available'); continue
      }
      if (performanceNames.has(api.name)) {
        assert.equal(implementation.implementationState, before.implementationState); continue
      }
      if (!ordinaryNotificationNames.has(api.name)) {
        // Compare the full cell object, retaining restrictions, registrations,
        // limits, scopes, missing requirements, acceptance and coverage. The
        // original ten are included here and must remain byte-equivalent data.
        const retained = Object.fromEntries(Object.entries(before)
          .filter(([key]) => ['status', 'coverage', 'restriction', 'parameterLimit'].includes(key)))
        assert.deepEqual({ ...implementation, ...retained }, before, `${host}: unrelated complete cell ${api.name}`)
        if (!finiteNotificationNames.has(api.name)) continue
      }
      const removal = finiteNotificationOffNames.includes(api.name)
      const expected = removal ? 'available' : 'partial'
      assert.equal(implementation.implementationState, expected, `${host}: ${api.name}`)
      assert.equal(before.status, 'pendingAcceptance')
      assert.equal(cellAcceptance(host, api.name).status, 'pendingAcceptance')
      assert.deepEqual(core.missing, removal ? [] : ['finiteNotificationActualProducer',
        'finiteNotificationFixedPayloadParity', 'finiteNotificationFixedTimingAndPluginParity'])
      for (const id of ['finiteNotifications', 'finiteNotificationResources', 'boundary', 'hostServices',
        'environment', 'hostInstaller', 'lifecycleNotifications', 'runtimeLifecycle', 'manifestPacker',
        'coreAssembly', 'quickjsExecution', 'terminalResources', 'engineExecution', 'quickjs', 'v8', 'runtime']) {
        assert(core.sources.some(source => source.id === id && source.role === 'runtimeImplementation'))
      }
      if (ordinaryNotificationNames.has(api.name)) {
        assert.equal(before.implementation, 'absent')
        assert.equal(before.sources.some(source => source.role === 'platformProvider'), false)
        assert.equal(before.status, 'pendingAcceptance')
        assert.equal(before.restriction, undefined)
        if (removal) ordinaryAvailable++; else ordinaryPartial++
      }
      if (before.implementationState !== expected) { assert.equal(before.implementationState, 'missing'); changes++ }
    }
  }
  assert.equal(cells, 8855)
  assert.equal(notApplicable, 87)
  assert.equal(ordinaryAvailable, 140)
  assert.equal(ordinaryPartial, 140)
  assert([0, 280].includes(changes), 'matrix must precede or contain the complete app20 batch while retaining the original ten')
})

for (const name of finiteNotificationNames) test(`finite notification requires exact locked return for ${name}`, async () => {
  const value = structuredClone(catalog), api = value.apis.find(api => api.name === name)
  api.signatures[0].returns = 'Promise<void>'
  await assert.rejects(inventoryCoreApis(value, read), /Finite notification locked signature changed/)
})
for (const mutation of ['required off', 'optional on', 'CopyUrl argument', 'listener type', 'listener name', 'owner',
  'kind', 'baseline', 'event', 'counterpart', 'property', 'receiver', 'duplicate', 'overload']) {
  test(`finite notification requires exact locked ${mutation}`, async () => {
    const value = structuredClone(catalog)
    const name = mutation === 'optional on' ? 'wx.onBeforePageLoad' : mutation === 'CopyUrl argument' ? 'wx.offCopyUrl' : 'wx.offBeforePageLoad'
    const api = value.apis.find(api => api.name === name)
    if (mutation === 'required off') api.signatures[0].parameters[0].optional = false
    if (mutation === 'optional on') api.signatures[0].parameters[0].optional = true
    if (mutation === 'CopyUrl argument') api.signatures[0].parameters.push({ name: 'listener', type: 'OffCopyUrlCallback', optional: true })
    if (mutation === 'listener type') api.signatures[0].parameters[0].type = 'unknown'
    if (mutation === 'listener name') api.signatures[0].parameters[0].name = 'changed'
    if (mutation === 'owner') api.owner = 'runtime'
    if (mutation === 'kind') api.kind = 'async'
    if (mutation === 'baseline') api.baseline = 'excluded'
    if (mutation === 'event') api.event = 'Changed'
    if (mutation === 'counterpart') api.counterpart = 'wx.changed'
    if (mutation === 'property') api.property = true
    if (mutation === 'receiver') api.receiver = 'Changed'
    if (mutation === 'duplicate') value.apis.push(structuredClone(api))
    if (mutation === 'overload') api.signatures.push({ parameters: [], returns: 'void' })
    await assert.rejects(inventoryCoreApis(value, read), /Finite notification locked signature changed/)
  })
}

test('ordinary notification closed ownership tables preserve the original10 ceiling and existing registered producer resolver', async () => {
  const source = await read('crates/container-core/src/finite-notifications.js')
  const ast = parseJavaScript(source, { ecmaVersion: 'latest', sourceType: 'script' })
  const owner = ast.body.find(node => node.type === 'VariableDeclaration'
    && node.declarations[0].id.name === '__container_finite_notifications').declarations[0].init.callee.body.body
  const literalArray = name => {
    const declaration = owner.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
      .find(node => node.id.name === name)
    assert.equal(declaration.init.type, 'ArrayExpression')
    assert(declaration.init.elements.every(node => node.type === 'Literal' && typeof node.value === 'string'))
    return declaration.init.elements.map(node => node.value)
  }
  assert.deepEqual(literalArray('partialProducerEvents'), partialNotificationEvents)
  assert.deepEqual(literalArray('ordinaryProducerEvents'), ordinaryNotificationEvents)
  assert.equal(new Set([...partialNotificationEvents, ...ordinaryNotificationEvents]).size, 30)
  const native = await read('crates/container-runtime/src/finite_notifications.rs')
  const names = text => [...text.matchAll(/"(wx\.[A-Za-z]+)"/g)].map(match => match[1])
  const nativeOffTable=native.match(/const OFF_APIS: \[&str; 49\] = \[([\s\S]*?)\];/)[1]
  assert.deepEqual([...nativeOffTable.matchAll(/"([^"]+)"/g)].map(match=>match[1]),[
    ...finiteNotificationOffNames,...objectNotificationOffNames,
    ...['Canplay','Ended','Error','Pause','Play','Seeked','Seeking','Stop','TimeUpdate','Waiting']
      .map(event=>`object:InnerAudioContext.off${event}`),
  ])
  const producer = native.slice(native.indexOf('pub(super) fn is_producer('), native.indexOf('\nfn has_partial_producer_ceiling('))
  assert(producer.includes('has_partial_producer_ceiling(name)'))
  assert.deepEqual(names(producer), ordinaryNotificationEvents.map(event => `wx.on${event}`))
  const ceiling = native.slice(native.indexOf('\nfn has_partial_producer_ceiling('), native.indexOf('\n#[cfg('))
  assert.deepEqual(names(ceiling), partialNotificationEvents.map(event => `wx.on${event}`))
  const capability = native.slice(native.indexOf('pub(super) fn finite_notification_capability('), native.indexOf('pub(super) fn dispatch_finite_notification('))
  assert(capability.includes('if !has_partial_producer_ceiling(name) && !OFF_APIS.contains(&name) {\n            return None;'))
  const services = await read('crates/container-runtime/src/host_services.rs')
  const owned = services.slice(services.indexOf('pub(super) fn runtime_owned('), services.indexOf('\n#[derive(Default)]'))
  assert(owned.includes('finite_notifications::OFF_APIS.contains(&name)'))
  assert(!owned.includes('finite_notifications::is_producer'))
  assert(!ordinaryNotificationEvents.some(event => owned.includes(`"wx.on${event}"`)))
  const runtime = await read('crates/container-runtime/src/lib.rs')
  assert(runtime.indexOf('self.finite_notification_capability(name, provider_capabilities)')
    < runtime.indexOf('self.registered_host_capability(name, provider_capabilities)'))
  const inventory = await inventoryCoreApis(catalog, read)
  assert.equal(Object.keys(inventory.sources).length, 134)
  for (const event of ['GeneratePoster', 'UserCaptureScreen', 'KeyDown', 'KeyUp', 'WindowStateChange']) {
    for (const mode of ['on', 'off']) assert(!inventory.apis.get(`wx.${mode}${event}`)?.sources
      .some(source => source.id === 'finiteNotifications'))
  }
})

test('ordinary notification source scopes retain asymmetric plugin metadata and exact callback alias payloads', async () => {
  const inventory = await inventoryCoreApis(catalog, read)
  for (const [event, onPlugin, offPlugin, permission, onPayload, offPayload] of [
    ['DeviceMotionChange', '不支持', '需要基础库 `2.9.1`', 'none', 'OnDeviceMotionChangeListenerResult', 'GeneralCallbackResult'],
    ['LocalServiceResolveFail', '需要基础库 `2.15.0`', '需要基础库 `2.15.0`', 'none', 'OnLocalServiceLostListenerResult', 'OnLocalServiceLostListenerResult'],
    ['ScreenRecordingStateChanged', '不支持', '不支持', 'microphone', 'OnScreenRecordingStateChangedListenerResult', 'OnScreenRecordingStateChangedListenerResult'],
    ['BLEPeripheralConnectionStateChanged', '需要基础库 `2.22.1`', '需要基础库 `2.22.1`', 'bluetooth', 'OnBLEPeripheralConnectionStateChangedListenerResult', 'OnBLEPeripheralConnectionStateChangedListenerResult'],
    ['AudioInterruptionBegin', '需要基础库 `2.15.0`', '需要基础库 `2.15.0`', 'none', 'GeneralCallbackResult', 'GeneralCallbackResult'],
    ['VoIPChatInterrupted', '需要基础库 `2.9.1`', '需要基础库 `2.9.1`', 'none', 'OnVoIPChatInterruptedListenerResult', 'OnVoIPChatInterruptedListenerResult'],
  ]) for (const mode of ['on', 'off']) {
    const entry = inventory.apis.get(`wx.${mode}${event}`), scopes = entry.scopes.join('\n')
    for (const metadata of [`on 在插件中使用：${onPlugin}`, `off 在插件中使用：${offPlugin}`, `permission ${permission}`,
      `on callback alias payload ${onPayload}`, `off callback alias payload ${offPayload}`]) assert(scopes.includes(metadata), metadata)
    assert(scopes.includes('never invokes that callback alias'))
    if (mode === 'on') {
      assert(scopes.includes('existing registered-host capability resolver, Full/Partial support'))
      assert(scopes.includes('installed producer descriptor is required before callback or ID allocation'))
      assert.deepEqual(entry.missing, ['finiteNotificationActualProducer', 'finiteNotificationFixedPayloadParity', 'finiteNotificationFixedTimingAndPluginParity'])
    }
  }
})

for (const name of ordinaryNotificationNames) for (const mutation of ['optionality', 'listener alias', 'arity', 'since', 'permission']) {
  test(`ordinary notification requires exact locked ${mutation} for ${name}`, async () => {
    const value = structuredClone(catalog), api = value.apis.find(api => api.name === name)
    if (mutation === 'optionality') api.signatures[0].parameters[0].optional = !api.signatures[0].parameters[0].optional
    if (mutation === 'listener alias') api.signatures[0].parameters[0].type = name === 'wx.offDeviceMotionChange' ? 'OnDeviceMotionChangeCallback' : 'GeneralCallback'
    if (mutation === 'arity') api.signatures[0].parameters = []
    if (mutation === 'since') api.since = '3.17.3'
    if (mutation === 'permission') api.permission = 'camera'
    await assert.rejects(inventoryCoreApis(value, read), /Finite notification locked signature changed/)
  })
}
for (const mutation of ['listener name', 'owner', 'kind', 'baseline', 'event', 'counterpart', 'property', 'receiver', 'duplicate', 'overload']) {
  test(`ordinary notification requires exact structural contract ${mutation}`, async () => {
    const value = structuredClone(catalog), api = value.apis.find(api => api.name === 'wx.offDeviceMotionChange')
    if (mutation === 'listener name') api.signatures[0].parameters[0].name = 'changed'
    if (mutation === 'owner') api.owner = 'runtime'
    if (mutation === 'kind') api.kind = 'syncLocal'
    if (mutation === 'baseline') api.baseline = 'excluded'
    if (mutation === 'event') api.event = 'Changed'
    if (mutation === 'counterpart') api.counterpart = 'wx.offNetworkWeakChange'
    if (mutation === 'property') api.property = true
    if (mutation === 'receiver') api.receiver = 'Changed'
    if (mutation === 'duplicate') value.apis.push(structuredClone(api))
    if (mutation === 'overload') api.signatures.push({ parameters: [], returns: 'void' })
    await assert.rejects(inventoryCoreApis(value, read), /Finite notification locked signature changed/)
  })
}

async function assertFiniteNotificationsUnreviewed(changedSource) {
  let inventory
  try { inventory = await inventoryCoreApis(catalog, changedSource) }
  catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error
    assert(error instanceof Error)
    return
  }
  for (const name of finiteNotificationOffNames) {
    const core = inventory.apis.get(name)
    assert(core.missing.includes('reviewedFiniteNotificationRemovalOwnership'))
    assert.notEqual(resolveImplementation({ api: catalog.apis.find(api => api.name === name), core }).implementationState, 'available')
  }
  for (const name of finiteNotificationOnNames) {
    const core = inventory.apis.get(name)
    assert(core.missing.includes('reviewedFiniteNotificationProducerOwnership'))
    assert(!core.sources.some(source => source.role === 'runtimeImplementation'))
  }
}
for (const [label, path, before, after, count = 1] of [
  ['original callback identity', 'crates/container-core/src/finite-notifications.js', 'record.callback === callback', 'false', 2],
  ['omitted remove-all', 'crates/container-core/src/finite-notifications.js', 'if (callback === undefined) { clear(state); return; }', 'if (callback === undefined) { return; }'],
  ['CopyUrl unconditional clear-all', 'crates/container-core/src/finite-notifications.js', 'function() { remove(state, undefined); }', 'function(callback) { remove(state, callback); }'],
  ['private live callback authority', 'crates/container-core/src/finite-notifications.js', 'record.active = false; delete records[record.id];', 'record.active = false; /* delete records[record.id]; */'],
  ['immediate callback release', 'crates/container-core/src/finite-notifications.js', 'record.callback = null;', '/* record.callback = null; */'],
  ['independent off admission', 'crates/container-core/src/finite-notifications.js', 'require(state.offName, (state.policy || state).off);', 'require(state.offName, (state.policy || state).on);'],
  ['producer Partial ceiling', 'crates/container-core/src/finite-notifications.js', "state.on ? (state.partialProducer ? 'partial' : on) : 'unsupported'", "state.on ? on : 'unsupported'"],
  ['off own grade', 'crates/container-core/src/finite-notifications.js', "state.off ? off : 'unsupported'", "state.off ? 'partial' : 'unsupported'", 2],
  ['withdrawal of actual callbacks', 'crates/container-core/src/finite-notifications.js', 'if (!state.on) clear(state);', 'if (!state.on) return;'],
  ['terminal private retirement', 'crates/container-core/src/finite-notifications.js', 'retired = true;', 'retired = false;', 2],
  ['pre-callback exact sequence claim', 'crates/container-core/src/finite-notifications.js', 'record.sequence = next;', '/* record.sequence = next; */'],
  ['retained prefix ACK', 'crates/container-core/src/finite-notifications.js', 'const next = through.cancelNext;', 'const next = null;'],
  ['private active snapshot', 'crates/container-core/src/finite-notifications.js', "let result = '{\"active\":['", "let result = '{\"forged\":['"],
  ['captured transport binder', 'crates/container-core/src/host-bridge.js', 'delete globalThis.__container_bind_finite_notifications;', '/* delete globalThis.__container_bind_finite_notifications; */'],
  ['owned descriptor migration', 'crates/container-core/src/host-bridge.js', 'if (finiteNotifications.owns(name)) {', 'if (false) {'],
  ['foreign counterpart bypass', 'crates/container-core/src/host-bridge.js', '&& !finiteNotifications.owns(descriptor.counterpart)', '&& true'],
  ['trusted ingress', 'crates/container-core/src/host-environment-install.js', '__container_finite_notifications.receive(__host_value(snapshot, "api"), __host_value(snapshot, "event"));', '/* retained ingress removed */'],
  ['both trusted capability installs', 'crates/container-core/src/host-environment-install.js', '__container_finite_notifications.install(capabilities);', '/* install removed */', 2],
  ['trusted owner retirement', 'crates/container-core/src/lifecycle-notifications.js', '__container_finite_notifications.retire();', '/* retirement removed */'],
  ['retained private snapshot', 'crates/container-core/src/host_environment.rs', 'return __container_finite_notifications.snapshot();', 'return "{}";'],
  ['native subscription ownership', 'crates/container-runtime/src/host_services.rs', 'registration.api == name && registration.object_id == object_id', 'registration.api == name'],
  ['runtime cleanup ownership', 'crates/container-runtime/src/host_services.rs', 'finite_notifications::OFF_APIS.contains(&name)', 'false'],
  ['private complete active replacement', 'crates/container-runtime/src/finite_notifications.rs', 'self.host_services.finite_notification_registrations = active;', 'self.host_services.finite_notification_registrations.clear();'],
  ['real native cancellation', 'crates/container-runtime/src/finite_notifications.rs', 'self.cancel_native_subscription(id)', 'Ok::<(), BridgeError>(())'],
  ['native producer registration admission', 'crates/container-runtime/src/finite_notifications.rs', 'has_partial_producer_ceiling(name) && !self.host_service_registered(name)', 'false'],
  ['native producer Partial ceiling', 'crates/container-runtime/src/finite_notifications.rs', 'min_support(support, CapabilitySupport::Partial)', 'support'],
  ['both conversion reconciliation barriers', 'crates/container-runtime/src/lib.rs', 'self.reconcile_finite_notification_cancellations()', 'self.reconcile_engine_storage()', 2],
  ['QuickJS private snapshot ingress', 'crates/container-engine-quickjs/src/lib.rs', 'self.capture_receiver_transport(serde_json::json!({"kind":"finite-notification-snapshot"}))', 'Ok(serde_json::json!({}))'],
  ['V8 private snapshot ingress', 'crates/container-engine-v8/src/lib.rs', 'self.capture_receiver_transport(serde_json::json!({"kind":"finite-notification-snapshot"}))', 'Ok(serde_json::json!({}))'],
  ['ordinary closed membership', 'crates/container-core/src/finite-notifications.js', "'ApiCategoryChange', 'AudioInterruptionBegin'", "'AudioInterruptionBegin'"],
  ['ordinary descriptor gate', 'crates/container-core/src/finite-notifications.js', 'policy.on && policy.available', 'policy.on'],
  ['ordinary Full policy projection', 'crates/container-core/src/finite-notifications.js', "state.partialProducer ? 'partial' : on", "'partial'"],
  ['original-only admission order', 'crates/container-core/src/finite-notifications.js', 'if (state.partialProducer) require(state.onName, policy.on);', 'require(state.onName, policy.on);'],
  ['ordinary producer classification', 'crates/container-core/src/finite-notifications.js', 'state.partialProducer = own(partialProducers, state.onName) === true;', 'state.partialProducer = true;'],
  ['private closed facade owner', 'crates/container-core/src/finite-notifications.js', "name === 'wx.on' + event || name === 'wx.off' + event", "name === 'wx.off' + event"],
  ['native ordinary producer membership', 'crates/container-runtime/src/finite_notifications.rs', '"wx.onApiCategoryChange"', '"wx.onGeneratePoster"'],
  ['native off-only runtime ownership', 'crates/container-runtime/src/finite_notifications.rs', '"wx.offDeviceMotionChange"', '"wx.onDeviceMotionChange"'],
  ['native ordinary policy fallthrough', 'crates/container-runtime/src/finite_notifications.rs', '!has_partial_producer_ceiling(name) && !OFF_APIS.contains(&name)', '!is_producer(name) && !OFF_APIS.contains(&name)'],
  ['native original-only Partial predicate', 'crates/container-runtime/src/finite_notifications.rs', 'Some(if has_partial_producer_ceiling(name) {', 'Some(if is_producer(name) {'],
  ['native canonical id authority', 'crates/container-runtime/src/finite_notifications.rs', "!suffix.starts_with('0') && suffix.bytes().all(|byte| byte.is_ascii_digit())", 'true'],
  ['native closed active producer authority', 'crates/container-runtime/src/finite_notifications.rs', '!is_producer(&registration.api)', 'false'],
  ['native disjoint cancellation authority', 'crates/container-runtime/src/finite_notifications.rs', 'active.contains_key(id)', 'false'],
  ['native retained failed sweep', 'crates/container-runtime/src/finite_notifications.rs', 'return Err(error);', 'return Ok(());'],
  ['native successful prefix ACK QuickJS', 'crates/container-runtime/src/finite_notifications.rs', '.acknowledge_finite_notification_cancellations(last)', '.acknowledge_finite_notification_cancellations("foreign")', 2],
  ['registered Full/default/provider resolution', 'crates/container-runtime/src/host_services.rs', 'if !self.host_services.registered.contains(name)\n            && !self.host_services.compatibility_cleanup_apis.contains(name)\n        {', 'if false {'],
]) test(`finite notification source grant rejects broken ${label}`, async () => {
  await assertFiniteNotificationsUnreviewed(changedRead(path, before, after, count))
})

test('finite notification semantic AST tolerates source trivia without changing any of its60 grades', async () => {
  const inventory = await inventoryCoreApis(catalog, async path => path === 'crates/container-core/src/finite-notifications.js'
    ? '// reviewed source trivia\n' + await read(path) : read(path))
  for (const name of finiteNotificationNames) {
    const core = inventory.apis.get(name)
    assert.equal(resolveImplementation({ api: catalog.apis.find(api => api.name === name), core }).implementationState,
      finiteNotificationOffNames.includes(name) ? 'available' : 'partial')
  }
})
for (const path of ['crates/container-runtime/src/finite_notifications.rs', 'crates/container-core/src/engine_execution.rs',
  'crates/container-core/src/engine_terminal_resources.rs', 'tools/container-manifest/src/index.mjs']) {
  test(`finite notification complete source context requires review for ${path}`, async () => {
    await assertFiniteNotificationsUnreviewed(async target => target === path ? '// source review changed\n' + await read(target) : read(target))
  })
}

test('two retained removals preserve 14 conditional Available cells and prior 35', async () => {
  const result = await inventoryCoreApis(catalog, read)
  for (const host of cleanupHosts) {
    for (const name of retainedRemovalNames) {
      const entry = result.forHost(host, name)
      assert.deepEqual(entry.missing, [])
      assert.equal(resolveImplementation({ api: catalog.apis.find(api => api.name === name), core: entry }).implementationState, 'available')
      for (const id of ['boundary', 'hostServices', 'environment', 'hostInstaller', 'lifecycleNotifications',
        'runtimeLifecycle', 'manifestPacker', 'quickjs', 'v8', 'runtime',
        name === 'wx.offUnhandledRejection' ? 'unhandledRejections' : 'windowResizeNotifications']) {
        assert(entry.sources.some(source => source.id === id && source.role === 'runtimeImplementation'))
      }
    }
    for (const name of [...cleanupNames, 'object:PerformanceObserver.disconnect']) {
      assert.equal(resolveImplementation({ api: catalog.apis.find(api => api.name === name), core: result.forHost(host, name) }).implementationState, 'available')
    }
    for (const name of ['wx.onUnhandledRejection', 'wx.onWindowResize']) {
      const entry = result.forHost(host, name)
      assert(entry.sources.some(source => source.role === 'runtimeImplementation'))
      assert(entry.missing.length > 0)
      assert.equal(resolveImplementation({ api: catalog.apis.find(api => api.name === name), core: entry }).implementationState, 'partial')
    }
  }
})
for (const name of retainedRemovalNames) for (const mutation of [
  'required', 'name', 'type', 'return', 'overload', 'owner', 'kind', 'baseline', 'event', 'counterpart', 'property', 'receiver', 'duplicate',
]) test(`retained removal signature requires exact ${name} ${mutation}`, async () => {
  const changed = structuredClone(catalog), api = changed.apis.find(api => api.name === name)
  if (mutation === 'required') api.signatures[0].parameters[0].optional = false
  if (mutation === 'name') api.signatures[0].parameters[0].name = 'changed'
  if (mutation === 'type') api.signatures[0].parameters[0].type = 'unknown'
  if (mutation === 'return') api.signatures[0].returns = 'number'
  if (mutation === 'overload') api.signatures.push({ parameters: [], returns: 'void' })
  if (mutation === 'owner') api.owner = 'host'
  if (mutation === 'kind') api.kind = 'syncLocal'
  if (mutation === 'baseline') api.baseline = 'excluded'
  if (mutation === 'event') api.event = 'Changed'
  if (mutation === 'counterpart') api.counterpart = 'wx.changed'
  if (mutation === 'property') api.property = true
  if (mutation === 'receiver') api.receiver = 'Changed'
  if (mutation === 'duplicate') changed.apis.push(structuredClone(api))
  await assert.rejects(inventoryCoreApis(changed, read), /Retained removal locked signature changed/)
})

async function assertRetainedRemovalUnavailable(changedSource, names = retainedRemovalNames) {
  let result
  try { result = await inventoryCoreApis(catalog, changedSource) } catch (error) {
    // A changed live boundary may fail an existing stricter global source gate.
    // Fixture anchor assertions must still fail, never count as valid denial.
    if (error.code === 'ERR_ASSERTION') throw error
    assert(error instanceof Error)
    return
  }
  for (const name of names) {
    assert(result.apis.get(name).missing.includes('reviewedRetainedRemovalOwnership'))
    assert.notEqual(resolveImplementation({ api: catalog.apis.find(api => api.name === name), core: result.apis.get(name) }).implementationState, 'available')
  }
}
const retainedHubMutations = [
  ['rejection same function', 'unhandled-rejections.js', 'listeners[index] !== callback', 'false', ['wx.offUnhandledRejection']],
  ['rejection omitted all', 'unhandled-rejections.js', 'callback === undefined', 'callback === null', ['wx.offUnhandledRejection']],
  ['rejection actual private list', 'unhandled-rejections.js', 'let listeners = create(null), listenerCount = 0, generation = 0;', 'let listeners = __container_app_listeners.unhandledRejection, listenerCount = 0, generation = 0;', ['wx.offUnhandledRejection']],
  ['rejection remove all clears real list', 'unhandled-rejections.js', 'if (callback === undefined) { listeners = create(null); listenerCount = 0; return; }', 'if (callback === undefined) { return; }', ['wx.offUnhandledRejection']],
  ['rejection removal compaction', 'unhandled-rejections.js', 'listeners[next - 1] = listeners[next]', 'listeners[next] = listeners[next - 1]', ['wx.offUnhandledRejection']],
  ['rejection saved off admission', 'unhandled-rejections.js', "require('wx.offUnhandledRejection', off);", '/* private admission removed */', ['wx.offUnhandledRejection']],
  ['rejection off keeps own grade', 'unhandled-rejections.js', "off ? own(policy, 'wx.offUnhandledRejection') : 'unsupported'", "off ? 'partial' : 'unsupported'", ['wx.offUnhandledRejection']],
  ['rejection withdrawal clears owner', 'unhandled-rejections.js', 'if (!on) { listeners = create(null); listenerCount = 0; generation += 1; }', 'if (!on) { generation += 1; }', ['wx.offUnhandledRejection']],
  ['rejection captured tail generation', 'unhandled-rejections.js', 'generation !== admittedGeneration', 'false', ['wx.offUnhandledRejection']],
  ['rejection permanent retirement', 'unhandled-rejections.js', 'retired = true; generation += 1;', 'retired = false; generation += 1;', ['wx.offUnhandledRejection']],
  ['rejection void return', 'unhandled-rejections.js', 'function(callback) { remove(callback); }', 'function(callback) { remove(callback); return 1; }', ['wx.offUnhandledRejection']],
  ['rejection ASI cleanup bypass', 'unhandled-rejections.js', 'function(callback) { remove(callback); }', 'function(callback) { return\n remove(callback); }', ['wx.offUnhandledRejection']],
  ['rejection dead closure', 'unhandled-rejections.js', '\n})();\n', '\n});\n', ['wx.offUnhandledRejection']],
  ['window same function', 'window-resize-notifications.js', 'callbacks[index] !== callback', 'false', ['wx.offWindowResize']],
  ['window omitted all', 'window-resize-notifications.js', 'callback === undefined', 'callback === null', ['wx.offWindowResize']],
  ['window actual private list', 'window-resize-notifications.js', 'let callbacks = create(null);', 'let callbacks = __container_app_listeners.windowResize;', ['wx.offWindowResize']],
  ['window remove all clears real list', 'window-resize-notifications.js', 'if (callback === undefined) { clear(); return; }', 'if (callback === undefined) { return; }', ['wx.offWindowResize']],
  ['window removal compaction', 'window-resize-notifications.js', 'callbacks[next - 1] = callbacks[next]', 'callbacks[next] = callbacks[next - 1]', ['wx.offWindowResize']],
  ['window saved off admission', 'window-resize-notifications.js', "require('wx.offWindowResize', off);", '/* private admission removed */', ['wx.offWindowResize']],
  ['window off keeps own grade', 'window-resize-notifications.js', "off ? own(policy, 'wx.offWindowResize') : 'unsupported'", "off ? 'partial' : 'unsupported'", ['wx.offWindowResize']],
  ['window withdrawal clears owner', 'window-resize-notifications.js', 'if (!on) clear(true);', 'if (!on) clear(false);', ['wx.offWindowResize']],
  ['window captured tail generation', 'window-resize-notifications.js', 'generation !== admitted', 'false', ['wx.offWindowResize']],
  ['window permanent retirement', 'window-resize-notifications.js', 'retired = true;', 'retired = false;', ['wx.offWindowResize']],
  ['window void return', 'window-resize-notifications.js', "put(wx, 'offWindowResize', remove);", "put(wx, 'offWindowResize', function(callback) { remove(callback); return 1; });", ['wx.offWindowResize']],
  ['window comment decoy cleanup', 'window-resize-notifications.js', "put(wx, 'offWindowResize', remove);", "/* put(wx, 'offWindowResize', remove); */", ['wx.offWindowResize']],
  ['window dead closure', 'window-resize-notifications.js', '\n})();\n', '\n});\n', ['wx.offWindowResize']],
]
for (const [label, file, before, after, names] of retainedHubMutations) test(`retained removal complete hub AST denies ${label}`, async () => {
  await assertRetainedRemovalUnavailable(changedRead('crates/container-core/src/' + file, before, after), names)
})
const retainedBoundaryMutations = [
  ['rejection direct host predicate', 'crates/container-core/src/host-bridge.js', 'runtimeUnhandledRejectionApi(name) || runtimeWindowResizeApi(name)', 'runtimeWindowResizeApi(name)'],
  ['window direct host predicate', 'crates/container-core/src/host-bridge.js', 'runtimeUnhandledRejectionApi(name) || runtimeWindowResizeApi(name)', 'runtimeUnhandledRejectionApi(name)'],
  ['rejection counterpart exclusion', 'crates/container-core/src/host-bridge.js', '!runtimeUnhandledRejectionApi(descriptor.counterpart)', 'true'],
  ['window counterpart exclusion', 'crates/container-core/src/host-bridge.js', '!runtimeWindowResizeApi(descriptor.counterpart)', 'true'],
  ['rejection trusted capability-only install', 'crates/container-core/src/host-environment-install.js', '    __container_unhandled_rejections.install(capabilities);', '    /* removal owner install bypassed */'],
  ['window trusted capability-only install', 'crates/container-core/src/host-environment-install.js', '    __container_window_resize.install(capabilities);', '    /* removal owner install bypassed */'],
  ['rejection trusted full snapshot install', 'crates/container-core/src/host-environment-install.js', '\n  __container_unhandled_rejections.install(capabilities);', '\n  /* removal owner install bypassed */'],
  ['window trusted full snapshot install', 'crates/container-core/src/host-environment-install.js', '\n  __container_window_resize.install(capabilities);', '\n  /* removal owner install bypassed */'],
  ['rejection unconditional lifecycle retirement', 'crates/container-core/src/lifecycle-notifications.js', '__container_unhandled_rejections.retire();', 'if (false) __container_unhandled_rejections.retire();'],
  ['window unconditional lifecycle retirement', 'crates/container-core/src/lifecycle-notifications.js', '__container_window_resize.retire();', 'if (false) __container_window_resize.retire();'],
  ['window Session early branch', 'crates/container-runtime/src/lib.rs', 'if let Some(support) = self.window_resize_capability(name, provider_capabilities) {', 'if let Some(support) = None::<CapabilitySupport> {'],
  ['rejection Session early branch', 'crates/container-runtime/src/lib.rs', 'if let Some(support) = self.error_notification_capability(name, provider_capabilities) {', 'if let Some(support) = None::<CapabilitySupport> {'],
  ['rejection incorrectly caps cleanup at Partial', 'crates/container-runtime/src/lib.rs', '"wx.onError" | "wx.onPageNotFound" | "wx.onUnhandledRejection"', '"wx.onError" | "wx.onPageNotFound" | "wx.onUnhandledRejection" | "wx.offUnhandledRejection"'],
  ['rejection host runtime owner', 'crates/container-runtime/src/host_services.rs', '| "wx.offUnhandledRejection"', '| "wx.fakeOffUnhandledRejection"'],
  ['window host runtime owner', 'crates/container-runtime/src/host_services.rs', '| "wx.offWindowResize"', '| "wx.fakeOffWindowResize"'],
  ['native terminal transport bypass', 'crates/container-runtime/src/lifecycle_notifications.rs', '"retire", &Value::Null', '"fake-retire", &Value::Null'],
]
for (const [label, path, before, after] of retainedBoundaryMutations) test(`retained removal full ownership boundary denies ${label}`, async () => {
  await assertRetainedRemovalUnavailable(changedRead(path, before, after))
})
for (const file of ['unhandled-rejections.js', 'window-resize-notifications.js']) test(`retained removal semantic AST accepts ordinary trivia in ${file}`, async () => {
  const result = await inventoryCoreApis(catalog, async path => path === 'crates/container-core/src/' + file ? '// source trivia\n' + await read(path) : read(path))
  for (const name of retainedRemovalNames) assert.deepEqual(result.apis.get(name).missing, [])
})
for (const file of ['crates/container-core/src/host_environment.rs', 'crates/container-engine-quickjs/src/lib.rs',
  'crates/container-engine-v8/src/lib.rs', 'crates/container-runtime/src/lib.rs', 'crates/container-runtime/src/host_services.rs',
  'crates/container-runtime/src/lifecycle_notifications.rs', 'tools/container-manifest/src/index.mjs']) {
  test(`retained removal complete source pin requires review for ${file} trivia`, async () => {
    await assertRetainedRemovalUnavailable(async path => path === file ? '// source trivia\n' + await read(path) : read(path))
  })
}
for (const [path, declaration, parameter] of [
  ['crates/container-runtime/src/lib.rs', 'fn window_resize_capability(', 'name'],
  ['crates/container-runtime/src/lib.rs', 'fn error_notification_capability(', 'name'],
  ['crates/container-runtime/src/lib.rs', 'fn effective_capability_with_provider(', 'provider_capabilities'],
  ['crates/container-runtime/src/lifecycle_notifications.rs', 'fn dispatch_lifecycle_notification(', 'name'],
]) test(`retained removal complete Rust boundary denies unbound ${declaration}`, async () => {
  const original = await read(path), start = original.indexOf(declaration)
  assert(start >= 0 && original.indexOf(declaration, start + declaration.length) === -1)
  const end = original.indexOf('{', start), signature = original.slice(start, end)
  const pattern = new RegExp(`\\b${parameter}\\b`, 'g')
  assert.equal([...signature.matchAll(pattern)].length, 1)
  const changed = original.slice(0, start) + signature.replace(pattern, '__unbound_parameter') + original.slice(end)
  await assertRetainedRemovalUnavailable(async target => target === path ? changed : read(target))
})

// Producer provenance is deliberately Partial and separate from finite off.
const retainedProducerGaps = {
  'wx.onUnhandledRejection': ['fixedUnhandledRejectionCheckpointTiming', 'fixedUnhandledRejectionReasonDeclarationParity', 'fixedUnhandledRejectionCaptureBudgetParity'],
  'wx.onWindowResize': ['fixedWindowResizeCallbackPolicyParity'],
}
test('two retained producers add exactly scoped Partial evidence while removals stay Available', async () => {
  const result = await inventoryCoreApis(catalog, read)
  for (const host of cleanupHosts) {
    for (const [name, missing] of Object.entries(retainedProducerGaps)) {
      const entry = result.forHost(host, name)
      assert.deepEqual(entry.missing, missing)
      assert(entry.sources.some(source => source.id === 'boundary' && source.role === 'protectedBoundary'))
      assert(entry.sources.some(source => source.role === 'runtimeImplementation'))
      assert.equal(resolveImplementation({ api: catalog.apis.find(api => api.name === name), core: entry }).implementationState, 'partial')
    }
    for (const name of [...retainedRemovalNames, ...cleanupNames, 'object:PerformanceObserver.disconnect']) {
      assert.equal(resolveImplementation({ api: catalog.apis.find(api => api.name === name), core: result.forHost(host, name) }).implementationState, 'available')
    }
  }
})
for (const name of Object.keys(retainedProducerGaps)) for (const mutation of [
  'required', 'name', 'type', 'return', 'overload', 'owner', 'kind', 'baseline', 'event', 'counterpart', 'property', 'receiver', 'duplicate',
]) test(`retained producer signature requires exact ${name} ${mutation}`, async () => {
  const changed = structuredClone(catalog), api = changed.apis.find(api => api.name === name)
  if (mutation === 'required') api.signatures[0].parameters[0].optional = true
  if (mutation === 'name') api.signatures[0].parameters[0].name = 'changed'
  if (mutation === 'type') api.signatures[0].parameters[0].type = 'unknown'
  if (mutation === 'return') api.signatures[0].returns = 'number'
  if (mutation === 'overload') api.signatures.push({ parameters: [], returns: 'void' })
  if (mutation === 'owner') api.owner = 'host'
  if (mutation === 'kind') api.kind = 'syncLocal'
  if (mutation === 'baseline') api.baseline = 'excluded'
  if (mutation === 'event') api.event = 'Changed'
  if (mutation === 'counterpart') api.counterpart = 'wx.changed'
  if (mutation === 'property') api.property = true
  if (mutation === 'receiver') api.receiver = 'Changed'
  if (mutation === 'duplicate') changed.apis.push(structuredClone(api))
  await assert.rejects(inventoryCoreApis(changed, read), /Retained producer locked signature changed/)
})
async function assertRetainedProducerMissing(changedSource, names) {
  let result
  try { result = await inventoryCoreApis(catalog, changedSource) } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error
    assert(error instanceof Error)
    return
  }
  for (const name of names) {
    const entry = result.apis.get(name)
    assert(!entry.sources.some(source => source.role === 'runtimeImplementation'))
    assert(entry.missing.includes('reviewedRetainedProducerOwnership'))
    assert.equal(resolveImplementation({ api: catalog.apis.find(api => api.name === name), core: entry }).implementationState, 'missing')
  }
}
for (const [label, path, before, after, names] of [
  ['rejection registration bypass', 'crates/container-core/src/unhandled-rejections.js', 'function(callback) { add(callback); }', 'function(callback) {}', ['wx.onUnhandledRejection']],
  ['rejection reason projection', 'crates/container-core/src/unhandled-rejections.js', "put(event, 'reason', entry.reason)", "put(event, 'reason', String(entry.reason))", ['wx.onUnhandledRejection']],
  ['rejection checkpoint flush bypass', 'crates/container-core/src/unhandled-rejections.js', 'function flush() {', 'function flush() { return;', ['wx.onUnhandledRejection']],
  ['window registration bypass', 'crates/container-core/src/window-resize-notifications.js', "put(wx, 'onWindowResize', add);", "put(wx, 'onWindowResize', function() {});", ['wx.onWindowResize']],
  ['window payload shape', 'crates/container-core/src/window-resize-notifications.js', "put(value, 'size', size);", "put(value, 'wrongSize', size);", ['wx.onWindowResize']],
  ['window actual Session producer bypass', 'crates/container-runtime/src/lib.rs', '"windowResize", &json!({"size": size})', '"fakeWindowResize", &json!({"size": size})', ['wx.onWindowResize']],
  ['rejection trusted install bypass', 'crates/container-core/src/host-environment-install.js', '\n  __container_unhandled_rejections.install(capabilities);', '\n  /* retained producer install removed */', ['wx.onUnhandledRejection']],
  ['window counterpart overwrite', 'crates/container-core/src/host-bridge.js', '!runtimeWindowResizeApi(descriptor.counterpart)', 'true', ['wx.onWindowResize']],
]) test(`retained producer exact source gate denies Partial credit for ${label}`, async () => {
  await assertRetainedProducerMissing(changedRead(path, before, after), names)
})
for (const file of ['unhandled-rejections.js', 'window-resize-notifications.js']) test(`retained producer semantic AST accepts trivia in ${file}`, async () => {
  const result = await inventoryCoreApis(catalog, async path => path === 'crates/container-core/src/' + file ? '// source trivia\n' + await read(path) : read(path))
  for (const [name, missing] of Object.entries(retainedProducerGaps)) assert.deepEqual(result.apis.get(name).missing, missing)
})


test('dedicated LogManager counts exactly five Partial leaves on all seven hosts', async () => {
  const inventory = await inventoryCoreApis(catalog, read)
  const names = ['wx.getLogManager', ...['debug', 'info', 'log', 'warn'].map(level => `object:LogManager.${level}`)]
  for (const host of ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']) for (const name of names) {
    const core = inventory.forHost(host, name)
    const api = catalog.apis.find(api => api.name === name)
    assert.equal(resolveImplementation({ api, core }).implementationState, 'partial')
    assert.deepEqual(core.missing, ['fixedLogManagerProjectionBudgetPersistenceUploadParity'])
    assert(core.sources.some(source => source.id === 'logJournal' && source.role === 'runtimeImplementation'))
    assert(core.sources.some(source => source.id === 'nativeProvider'))
    assert(core.sources.some(source => source.id === 'simulatorWeb'))
  }
  assert(!inventory.apis.get('wx.getRealtimeLogManager')?.sources.some(source => source.id === 'logJournal'))
})
for (const [name, file, before, after] of [
  ['writer admission', 'crates/container-core/src/log-manager.js', 'writer(prefix + argumentsJson +', 'writer(prefix + null +'],
  ['native retained tail', 'crates/container-core/src/log_manager.rs', 'state.records.front()', 'state.records.back()'],
  ['actual SDK full message', 'crates/container-sdk/src/lib.rs', '"message":text}', '"message":"truncated"}'],
  ['Web byte bound', 'crates/container-simulator/src/web.rs', 'const MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;', 'const MAX_EVENT_BYTES: usize = 1024;'],
]) test(`LogManager source grant disappears after changing ${name}`, async () => {
  const inventory = await inventoryCoreApis(catalog, changedRead(file, before, after))
  for (const name of ['wx.getLogManager', 'object:LogManager.log']) {
    const api = catalog.apis.find(api => api.name === name)
    assert.equal(resolveImplementation({ api, core: inventory.apis.get(name) }).implementationState, 'missing')
  }
})


test('BufferURL fixed declarations have private immutable owner and actual native/Worker consumer evidence', async () => {
  const result=await inventoryCoreApis(catalog,read)
  for(const name of ['wx.createBufferURL','wx.revokeBufferURL'])for(const host of ['android','ios','harmony','web','macos','windows','linux']){
    const entry=result.forHost(host,name)
    assert.deepEqual(entry.missing,['bufferURLNativeWasmConsumerValidation'])
    for(const id of ['bufferURLs','bufferURLStore','bufferURLProjection','imageResources','workerDOM','workerRuntime','commonHost','webHost','browserView','quickjs','v8','runtime'])assert(entry.sources.some(source=>source.id===id&&source.role==='runtimeImplementation'))
    assert.equal(resolveImplementation({api:catalog.apis.find(api=>api.name===name),core:entry}).implementationState,'partial')
  }
})
test('BufferURL source identity rejects snapshot, revoke, cache, Session and worker path substitution', async () => {
  for(const [path,before,after] of [
    ['crates/container-core/src/buffer-url.js','get(typed, "byteOffset").get','get(typed, "byteLength").get'],
    ['crates/container-core/src/buffer_urls.rs','state.leases.remove(url)','state.leases.get(url)'],
    ['crates/container-runtime/src/images.rs','buffer_urls.resolve(url)','buffer_urls.missing(url)'],
    ['crates/container-runtime/src/browser_view.rs','self.buffer_urls.resolve(&url)','self.buffer_urls.missing(&url)'],
    ['examples/hosts/web-wasm/worker-runtime.mjs','payload.sha256, payload.path','payload.sha256, "forged"'],
  ]){const changed=await inventoryCoreApis(catalog,changedRead(path,before,after));for(const name of ['wx.createBufferURL','wx.revokeBufferURL'])assert(changed.forHost('web',name).missing.includes('bufferURLSourceReview'))}
})


// Preserve the old token strings in comments while changing actual production
// linkage. Full reviewed identities must revoke every one of the 35 cells.
for (const [label, file, before, after, count = 1] of [
  ['trusted installer linkage', 'crates/container-core/src/host-environment-install.js', '__container_log_manager.install(capabilities);', 'void 0; /* __container_log_manager.install(capabilities); */', 2],
  ['QuickJS native writer ingress', 'crates/container-engine-quickjs/src/lib.rs', 'log_writer.append_json(&text)', 'false /* log_writer.append_json(&text) */'],
  ['V8 native writer ingress', 'crates/container-engine-v8/src/lib.rs', 'result.set_bool(journal.append_json(&text.to_rust_string_lossy(scope)));', 'result.set_bool(false); // result.set_bool(journal.append_json(&text.to_rust_string_lossy(scope)));'],
  ['Session retained native drain', 'crates/container-runtime/src/lib.rs', 'let logs = self.log_manager.take();', 'let logs = container_core::LogManagerDrain::default(); // let logs = self.log_manager.take();'],
  ['host terminal retirement', 'crates/container-runtime/src/async_host.rs', 'self.log_manager.retire();', '// self.log_manager.retire();'],
  ['QuickJS terminal callback', 'crates/container-engine-quickjs/src/lib.rs', 'execution.retire_on_fault(move || log_retirement.retire());', '// execution.retire_on_fault(move || log_retirement.retire());'],
  ['V8 terminal callback', 'crates/container-engine-v8/src/lib.rs', 'terminal_resources.register(move || log_retirement.retire());', '// terminal_resources.register(move || log_retirement.retire());'],
  ['native journal module authority', 'crates/container-core/src/lib.rs', 'mod log_manager;', '// mod log_manager;'],
]) test(`LogManager full production grant rejects ${label} with token decoys`, async () => {
  let inventory
  try { inventory = await inventoryCoreApis(catalog, changedRead(file, before, after, count)) }
  catch (error) {
    if(error.code==='ERR_ASSERTION')throw error
    assert(error instanceof Error)
    return
  }
  for(const host of ['android','ios','harmony','web','macos','windows','linux'])for(const name of ['wx.getLogManager','object:LogManager.debug','object:LogManager.info','object:LogManager.log','object:LogManager.warn']){
    const core=inventory.forHost(host,name),api=catalog.apis.find(api=>api.name===name)
    assert(!core.sources.some(source=>source.id==='logJournal'&&source.role==='runtimeImplementation'))
    assert.equal(resolveImplementation({api,core}).implementationState,'missing')
  }
})


// The object9 proposal is a separate complete-cell scope. It never adds on,
// factory, close or Ads grades while rebinding shared source identities.
test('object notification removals preserve63 Available cells alongside reviewed Performance source updates within8855', async () => {
  const inventory=await inventoryCoreApis(catalog,read),matrix=JSON.parse(await read('docs/host-services/api-matrix.json'))
  assert.equal(Object.keys(inventory.sources).length,134)
  assert.equal(catalog.apis.length,1265)
  const counts={available:0,partial:0,requiresHostService:0,missing:0},changed=new Set()
  let cells=0,selected=0,notApplicable=0
  for(const api of catalog.apis){
    const beforeApi=matrix.apis.find(row=>row.name===api.name);assert(beforeApi)
    for(const [host,before] of Object.entries(beforeApi.hosts)){
      cells++
      const core=inventory.forHost(host,api.name)
      const implementation=resolveImplementation({api,core,
        registeredSources:before.sources.filter(source=>source.role==='platformProvider'),
        delegated:before.implementation==='delegated',parameterLimit:before.parameterLimit,
      })
      assert(!Object.hasOwn(implementation,'status')&&!Object.hasOwn(implementation,'coverage'))
      // Preserve only metadata outside implementation authority. Rebuilding the
      // remaining full object catches removed optional scopes/missing fields,
      // rather than hiding deletions by merging the complete old cell first.
      const retained=Object.fromEntries(Object.entries(before).filter(([key])=>['status','coverage','restriction','parameterLimit'].includes(key)))
      const after={...implementation,...retained}
      counts[after.implementationState]++
      if(before.status==='platformNotApplicable')notApplicable++
      if(reviewedSourceScopeUpdates.has(api.name))continue
      if(!objectNotificationOffNames.has(api.name)){
        assert.deepEqual(after,before,`${host}: unrelated complete cell ${api.name}`)
        continue
      }
      selected++
      assert.equal(before.implementation,'absent');assert.equal(before.status,'pendingAcceptance')
      assert.equal(before.restriction,undefined);assert.equal(before.parameterLimit,undefined)
      assert.equal(before.sources.some(source=>source.role==='platformProvider'),false)
      assert.deepEqual(after.coverage,before.coverage);assert.equal(after.status,before.status)
      assert.deepEqual(core.missing,[]);assert.equal(after.implementationState,'available')
      assert.equal(cellAcceptance(host,api.name).status,'pendingAcceptance')
      for(const id of ['finiteNotifications','finiteNotificationResources','boundary','hostServices','asyncHost',
        'environment','hostInstaller','lifecycleNotifications','runtimeLifecycle','manifestPacker','coreAssembly',
        'quickjsExecution','terminalResources','engineExecution','quickjs','v8','runtime']){
        assert(core.sources.some(source=>source.id===id&&source.role==='runtimeImplementation'),`${api.name}: ${id}`)
      }
      if(before.implementationState==='available')assert.deepEqual(after,before,`${host}: adopted object cell ${api.name}`)
      else{assert.equal(before.implementationState,'missing');assert.deepEqual(before.sources,[]);changed.add(`${host}/${api.name}`)}
    }
  }
  assert.equal(cells,8855);assert.equal(selected,63);assert.equal(notApplicable,87)
  assert([0,63].includes(changed.size),'only the whole object9 batch may differ')
  assert.deepEqual(counts,{available:1777,partial:1308,requiresHostService:86,missing:5684})
})

test('object notification source scope keeps aliases permissions plugins and socket lifetime distinctions',async()=>{
  const inventory=await inventoryCoreApis(catalog,read)
  for(const [receiver,event] of objectNotificationPairs){
    const name=`object:${receiver}.off${event}`,core=inventory.apis.get(name),scope=core.scopes.join('\n')
    assert.deepEqual(core.missing,[])
    for(const proof of ['real native factory creator','exact receiver type, objectId, API and listener identity',
      'Own off manifest/host/provider admission is independent','saved aliases cannot target another object',
      'cancels actual subscription creator calls before retained ACK','Off never closes or destroys the socket',
      'never cancels its object factory creator','Trusted typed native object retirement precedes any guest resolver',
      'pending resolver failure cannot stop remaining native creator cleanup','failed UDP.close preserves ownership',
      'TCP.close only closes a connection and preserves socket lifetime','Off never invokes its callback alias',
      'No producer, factory, close, Ads, default capability, SDK/platform or fixed-WeChat event-production credit'])assert(scope.includes(proof),proof)
    assert(scope.includes(receiver==='TCPSocket'?'off 在插件中使用：不支持':'off 在插件中使用：需要基础库 `2.11.1`'))
    assert(scope.includes(event==='BindWifi'?'off permission wifi':'off permission none'))
    if(receiver==='TCPSocket'&&event==='Close')assert(scope.includes('off alias UDPSocketOffCloseCallback'))
    if(receiver==='TCPSocket'&&event==='Error')assert(scope.includes('off alias UDPSocketOffErrorCallback'))
    if(receiver==='UDPSocket'&&event==='Message')assert(scope.includes('off alias UDPSocketOffMessageCallback'))
    assert(!inventory.apis.get(`object:${receiver}.on${event}`)?.sources.some(source=>source.role==='runtimeImplementation'))
  }
  for(const name of ['wx.createTCPSocket','wx.createUDPSocket','object:TCPSocket.close','object:UDPSocket.close',
    'object:InterstitialAd.offClose','object:InterstitialAd.offError','object:InterstitialAd.offLoad',
    'object:RewardedVideoAd.offClose','object:RewardedVideoAd.offError','object:RewardedVideoAd.offLoad']){
    assert(!inventory.apis.get(name)?.sources.some(source=>source.id==='finiteNotifications'))
  }
})

for(const [receiver,event] of objectNotificationPairs)for(const mode of ['on','off'])for(const mutation of [
  'optionality','listener alias','listener name','arity','return','since','permission','receiver','event','counterpart',
  'owner','kind','baseline','documentation','property','duplicate','overload',
])test(`object notification locked ${receiver}.${mode}${event} rejects ${mutation}`,async()=>{
  const value=structuredClone(catalog),name=`object:${receiver}.${mode}${event}`,api=value.apis.find(row=>row.name===name)
  if(mutation==='optionality')api.signatures[0].parameters[0].optional=!api.signatures[0].parameters[0].optional
  if(mutation==='listener alias')api.signatures[0].parameters[0].type='GeneralCallback'
  if(mutation==='listener name')api.signatures[0].parameters[0].name='callback'
  if(mutation==='arity')api.signatures[0].parameters=[]
  if(mutation==='return')api.signatures[0].returns='Promise<void>'
  if(mutation==='since')api.since=event==='BindWifi'?'2.18.0':'2.7.0'
  if(mutation==='permission')api.permission='camera'
  if(mutation==='receiver')api.receiver=receiver==='TCPSocket'?'UDPSocket':'TCPSocket'
  if(mutation==='event')api.event='Foreign'
  if(mutation==='counterpart')api.counterpart='object:Foreign.onMessage'
  if(mutation==='owner')api.owner='runtime'
  if(mutation==='kind')api.kind='async'
  if(mutation==='baseline')api.baseline='excluded'
  if(mutation==='documentation')api.documentation='https://example.invalid/foreign'
  if(mutation==='property')api.property=true
  if(mutation==='duplicate')value.apis.push(structuredClone(api))
  if(mutation==='overload')api.signatures.push({parameters:[],returns:'void'})
  await assert.rejects(inventoryCoreApis(value,read),/Object notification locked signature changed/)
})
for(const factory of ['wx.createTCPSocket','wx.createUDPSocket'])for(const mutation of ['kind','objectType','return','parameters','since','owner','duplicate']){
  test(`object notification real creator contract ${factory} rejects ${mutation}`,async()=>{
    const value=structuredClone(catalog),api=value.apis.find(row=>row.name===factory)
    if(mutation==='kind')api.kind='async'
    if(mutation==='objectType')api.objectType='Foreign'
    if(mutation==='return')api.signatures[0].returns='void'
    if(mutation==='parameters')api.signatures[0].parameters=[]
    if(mutation==='since')api.since='3.17.3'
    if(mutation==='owner')api.owner='runtime'
    if(mutation==='duplicate')value.apis.push(structuredClone(api))
    await assert.rejects(inventoryCoreApis(value,read),/Object notification locked factory changed/)
  })
}

async function assertObjectNotificationsUnreviewed(changedSource){
  let inventory
  try{inventory=await inventoryCoreApis(catalog,changedSource)}catch(error){
    if(error.code==='ERR_ASSERTION')throw error
    assert(error instanceof Error);return
  }
  for(const name of objectNotificationOffNames)for(const host of cleanupHosts){
    const core=inventory.forHost(host,name)
    assert(core.missing.includes('reviewedObjectNotificationRemovalOwnership'))
    assert(!core.sources.some(source=>source.role==='runtimeImplementation'))
    assert.equal(resolveImplementation({api:catalog.apis.find(row=>row.name===name),core}).implementationState,'missing')
  }
}
for(const [label,path,before,after,count=1]of[
  ['closed receiver table','crates/container-core/src/finite-notifications.js',"['TCPSocket', ['BindWifi', 'Close', 'Connect', 'Error', 'Message']]","['TCPSocket', ['Close', 'Connect', 'Error', 'Message']]"],
  ['private receiver identity','crates/container-core/src/finite-notifications.js','state.objectId = id; state.event = event;','state.objectId = undefined; state.event = event;'],
  ['actual on registry','crates/container-core/src/finite-notifications.js',"put(target, 'on' + event, function(callback) { assertLive(state.onName); add(state, callback); });","put(target, 'on' + event, function(callback) {});"],
  ['independently admitted off','crates/container-core/src/finite-notifications.js','require(state.offName, (state.policy || state).off);','require(state.offName, (state.policy || state).on);'],
  ['creator lifetime fence','crates/container-core/src/finite-notifications.js','if (owner.retired) {','if (false) {'],
  ['exact native object','crates/container-core/src/finite-notifications.js','object !== state.objectId','false'],
  ['exact native API','crates/container-core/src/finite-notifications.js','state.onName !== name','false'],
  ['native object snapshot binding','crates/container-core/src/finite-notifications.js',"+ '\",\"objectId\":\"' + state.objectId", "+ '\",\"objectId\":\"' + 'native-object-1'"],
  ['private owner index','crates/container-core/src/finite-notifications.js','delete objectOwners[owner.id];','/* delete objectOwners[owner.id]; */'],
  ['trusted bridge retirement','crates/container-core/src/finite-notifications.js','owner.onRetire();','/* owner.onRetire(); */'],
  ['per-owner states','crates/container-core/src/finite-notifications.js','owner.states = create(null);','owner.states = [];'],
  ['actual facade migration','crates/container-core/src/host-bridge.js','if (finiteNotifications.owns(api)) return;','if (false) return;'],
  ['factory owner binding','crates/container-core/src/host-bridge.js','finiteNotifications.attachObject(id, record.type, object,','finiteNotifications.attachObject(id, "UDPSocket", object,'],
  ['null prototype receiver','crates/container-core/src/host-bridge.js','const record = nativeCreate(null);','const record = {};'],
  ['synchronous bridge index retirement','crates/container-core/src/host-bridge.js','function() { record.closed = true; delete nativeObjects[id]; }','function() {}'],
  ['primitive native object binding','crates/container-core/src/host-bridge.js','if (objectId !== undefined) payload.objectId = objectId;','/* receiver binding removed */',3],
  ['captured producer transport','crates/container-core/src/host-bridge.js','finiteThen(finiteNativeCall(name, payload), undefined, failed);','Promise.resolve().then(function() {});'],
  ['successful UDP destruction','crates/container-core/src/host-bridge.js','api === "object:UDPSocket.close") forgetObject(record);','api === "object:TCPSocket.close") forgetObject(record);'],
  ['typed retirement ingress','crates/container-core/src/host-environment-install.js','__container_finite_notifications.retireObject(__host_value(snapshot, "objectId"))','true'],
  ['typed retirement canonical admission','crates/container-core/src/host-environment-install.js','if (!__container_finite_notifications.validObjectId(__host_value(snapshot, "objectId"))) return false;','if (false) return false;'],
  ['typed retirement idempotent acknowledgement','crates/container-core/src/host-environment-install.js','__container_finite_notifications.retireObject(__host_value(snapshot, "objectId"));\n    return true;','return __container_finite_notifications.retireObject(__host_value(snapshot, "objectId"));'],
  ['receiver native type','crates/container-runtime/src/host_services.rs','object.object_type == receiver','true'],
  ['native API/id/object authority','crates/container-runtime/src/host_services.rs','registration.api == name && registration.object_id == object_id','registration.api == name'],
  ['UDP native destruction','crates/container-runtime/src/host_services.rs','name == "object:UDPSocket.close"','name == "object:TCPSocket.close"'],
  ['native success guard','crates/container-runtime/src/host_services.rs','Some(NativeOperation::Destroy { object_id }) if succeeded','Some(NativeOperation::Destroy { object_id })'],
  ['native subscription creator cancellation','crates/container-runtime/src/host_services.rs','self.cancel_native_resource_call(&call_id)?;','/* creator cancellation removed */'],
  ['typed object register schema','crates/container-runtime/src/finite_notifications.rs','pub(super) object_id: Option<String>','pub(super) receiver: Option<String>'],
  ['global/object distinction','crates/container-runtime/src/finite_notifications.rs','None => registration.object_id.is_none(),','None => true,'],
  ['canonical object IDs','crates/container-runtime/src/finite_notifications.rs','valid_prefixed_id(id, "native-object-")','true'],
  ['all pending native cleanup','crates/container-runtime/src/async_host.rs','cleanup_error.get_or_insert(error);','return Err(error);',3],
  ['retirement before public settlement','crates/container-runtime/src/async_host.rs','let mut cleanup_error = self\n            .reconcile_finite_notification_object_retirements()\n            .err();','let mut cleanup_error = None;'],
  ['actual subscription cleanup before ACK','crates/container-runtime/src/finite_notifications.rs','self.cancel_native_subscription(id)','Ok::<(), BridgeError>(())'],
  ['typed QuickJS retirement','crates/container-engine-quickjs/src/lib.rs','"kind":"finite-notification-object-retire", "objectId":object_id,','"kind":"finite-notification-object-retire", "objectId":"foreign",'],
  ['typed V8 retirement','crates/container-engine-v8/src/lib.rs','"kind":"finite-notification-object-retire", "objectId":object_id,','"kind":"finite-notification-object-retire", "objectId":"foreign",'],
])test(`object notification source rejects broken ${label}`,async()=>{
  await assertObjectNotificationsUnreviewed(changedRead(path,before,after,count))
})
for(const path of ['crates/container-core/src/finite-notifications.js','crates/container-core/src/host-bridge.js',
  'crates/container-core/src/host-environment-install.js','crates/container-runtime/src/finite_notifications.rs',
  'crates/container-runtime/src/host_services.rs','crates/container-runtime/src/async_host.rs',
  'crates/container-engine-quickjs/src/lib.rs','crates/container-engine-v8/src/lib.rs']){
  test(`object notification exact source identity requires review for ${path}`,async()=>{
    await assertObjectNotificationsUnreviewed(async target=>target===path?'// requires a fresh object ownership review\n'+await read(target):read(target))
  })
}


test('Performance source refresh preserves implementation and acceptance while audio cleanup credit stays pending', async () => {
  const inventory=await inventoryCoreApis(catalog,read)
  const matrix=JSON.parse(await read('docs/host-services/api-matrix.json'))
  const counts={available:0,partial:0,requiresHostService:0,missing:0}
  const audioOffNames=new Set(['Canplay','Ended','Error','Pause','Play','Seeked','Seeking','Stop','TimeUpdate','Waiting']
    .map(event=>`object:InnerAudioContext.off${event}`))
  let cells=0,audioAvailable=0,audioMissing=0,performance=0,accepted=0,notApplicable=0
  for(const api of catalog.apis)for(const [host,before] of Object.entries(matrix.apis.find(row=>row.name===api.name).hosts)){
    const core=inventory.forHost(host,api.name)
    const implementation=resolveImplementation({api,core,
      registeredSources:before.sources.filter(source=>source.role==='platformProvider'),
      delegated:before.implementation==='delegated',parameterLimit:before.parameterLimit})
    const retained=Object.fromEntries(Object.entries(before).filter(([key])=>['status','coverage','restriction','parameterLimit'].includes(key)))
    const after={...implementation,...retained}
    assert.deepEqual(after,before,`${host}: generated complete cell ${api.name}`)
    cells++;counts[after.implementationState]++
    if(after.status==='implementedAndAccepted')accepted++
    if(after.status==='platformNotApplicable')notApplicable++
    if(performanceNames.has(api.name)){
      performance++
      for(const id of ['performance','moduleOwner','performanceLifetime','engineBatch','hostInstaller','runtime','quickjs','v8'])
        assert(core.sources.some(source=>source.id===id&&source.role==='runtimeImplementation'),`${api.name}: ${id}`)
      assert.deepEqual(core.missing,api.name==='object:PerformanceObserver.disconnect'?[]:['completePerformanceInstrumentation'])
    }
    if(audioOffNames.has(api.name)){
      assert(!core?.sources.some(source=>source.role==='runtimeImplementation'),'Audio source credit requires a separate reviewed batch')
      if(after.implementationState==='available')audioAvailable++
      else{assert.equal(after.implementationState,'missing');audioMissing++}
    }
  }
  assert.equal(cells,8855);assert.equal(performance,84)
  assert.equal(audioAvailable,26);assert.equal(audioMissing,44)
  assert.equal(accepted,0);assert.equal(notApplicable,87)
  assert.deepEqual(counts,{available:1777,partial:1308,requiresHostService:86,missing:5684})
})

for(const [label,path,before,after,count=1] of [
  ['actual Session module ingress','crates/container-runtime/src/lib.rs','self.run_engine_task(EngineTask::EvaluateModule(id), BridgeErrorCode::ModuleLoad)','self.run_engine_task(EngineTask::Call { target: CallTarget::Global("__container_evaluate_module".into()), args: Vec::new() }, BridgeErrorCode::ModuleLoad)'],
  ['real adapter evaluation','crates/container-runtime/src/lib.rs','engine.evaluate_module_with_id(id).map(|()| Vec::new())','Ok(Vec::new())',2],
  ['trusted registered record','crates/container-core/src/modules.js','if (record.trusted) measured(record.id, run); else run();','measured(record.id, run);'],
  ['retained App authority','crates/container-core/src/engine-batch-call.js','const invokeApp = __container_performance.invokeApp;','const invokeApp = root.__container_invoke_app;'],
  ['private typed module command','crates/container-core/src/host-environment-install.js','if (kind === "module-command") return __container_module_owner.command(snapshot);','if (kind === "module-command") return true;'],
  ['native terminal lifetime','crates/container-core/src/performance_lifetime.rs','self.active.store(false, Ordering::Release);','self.active.store(true, Ordering::Release);'],
])test(`Performance source proof rejects missing ${label}`, async()=>{
  await assert.rejects(inventoryCoreApis(catalog,changedRead(path,before,after,count)),/Performance (actual Session|private owner|retained module)|source evidence requires review/)
})
