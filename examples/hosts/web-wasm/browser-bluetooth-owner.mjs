/** Web Bluetooth GATT subset for explicitly initialized, application-scoped
 * host grants. Browser-origin permission alone never grants a mini app access.
 * See WEB-BLUETOOTH.md for the intentionally absent radio/discovery APIs.
 */
const brokers = new WeakMap()
const fail = (message, code = 'invalid_request') => Object.assign(new Error(message), { code })
const check = (value, message, code) => { if (!value) throw fail(message, code) }
const ok = api => ({ errMsg: `${api.replace(/^wx\./, '')}:ok` })
const identityKeys = ['hostAppId','tenantId','publisherId','appId','environment','version','packRoot']
export function bluetoothUuid(value) {
  check(typeof value === 'string', 'Bluetooth UUID must be a string')
  const text = value.toLowerCase()
  if (/^[0-9a-f]{4}$/.test(text)) return `0000${text}-0000-1000-8000-00805f9b34fb`
  if (/^[0-9a-f]{8}$/.test(text)) return `${text}-0000-1000-8000-00805f9b34fb`
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text), 'invalid Bluetooth UUID')
  return text
}
function nativeError(error) {
  const result = new Error(error?.message || String(error))
  result.name = error?.name || 'Error'
  if (typeof error?.code === 'string') result.code = error.code
  if (error?.errCode !== undefined || typeof error?.code === 'number') result.errCode = error.errCode ?? error.code
  if (error?.errMsg !== undefined) result.errMsg = error.errMsg
  result.details = { ...(error?.details || {}), nativeName: result.name }
  return result
}

export class BrowserBluetoothOwner {
  #grants = new Map(); #records = new Set(); #latest = new Map(); #broker
  #initialized = true; #closed = false; #grantListeners = new Map()
  constructor({ configuration, application, account, bluetooth, emit, diagnostic = () => {} }) {
    check(configuration?.initialized === true, 'host-initialized Bluetooth sessions are required', 'unsupported')
    check(bluetooth && typeof bluetooth === 'object', 'Web Bluetooth is unavailable', 'unsupported')
    check(Array.isArray(configuration.grants) && configuration.grants.length > 0 && configuration.grants.length <= 32, 'one to 32 explicit Bluetooth grants are required')
    this.emit = emit; this.diagnostic = diagnostic
    this.#broker = brokers.get(bluetooth)
    if (!this.#broker) brokers.set(bluetooth, this.#broker = new Map())
    for (const grant of configuration.grants) {
      check(identityKeys.every(key => grant.application?.[key] === application[key])
        && grant.account?.principalId === account.principalId && String(grant.account?.epoch) === String(account.epoch), 'Bluetooth grant belongs to another application, package or account', 'permission_denied')
      check(typeof grant.purpose === 'string' && grant.purpose.trim().length > 0 && grant.purpose.length <= 256
        && typeof grant.permissionVersion === 'string' && grant.permissionVersion.length > 0 && grant.permissionVersion.length <= 64, 'Bluetooth purpose and permissionVersion are required')
      check(grant.exclusiveSession === true, 'host must hand off exclusive use of this GATT session', 'permission_denied')
      const device = grant.device
      check(device && typeof device.id === 'string' && device.id.length > 0 && device.id.length <= 512
        && device.gatt && typeof device.gatt.connect === 'function' && typeof device.gatt.disconnect === 'function'
        && typeof device.addEventListener === 'function' && typeof device.removeEventListener === 'function', 'grant requires an actual host-selected BluetoothDevice')
      check(!this.#grants.has(device.id), 'duplicate Bluetooth device grant')
      check(Array.isArray(grant.services) && grant.services.length > 0 && grant.services.length <= 32, 'explicit Bluetooth service allowlist is required')
      const services = new Set(grant.services.map(bluetoothUuid))
      check(services.size === grant.services.length, 'duplicate Bluetooth service UUID')
      if (grant.signal) check(typeof grant.signal.aborted === 'boolean' && typeof grant.signal.addEventListener === 'function' && typeof grant.signal.removeEventListener === 'function', 'invalid Bluetooth permission revocation signal')
      const owned = { device, services, signal: grant.signal, revoked: grant.signal?.aborted === true }
      this.#grants.set(device.id, owned)
    }
    // Register only after all grants have passed validation, so a rejected
    // configuration cannot strand listeners on a host permission signal.
    for (const [deviceId, grant] of this.#grants) if (grant.signal) {
      const listener = () => { grant.revoked = true; for (const record of this.#records) if (record.device.id === deviceId) this.#retire(record) }
      grant.signal.addEventListener('abort', listener)
      this.#grantListeners.set(grant, listener)
    }
  }
  handlers() {
    return new Map([
      ['wx.closeBluetoothAdapter', (payload, call) => this.#closeAdapter(call)],
      ['wx.createBLEConnection', (payload, call) => this.#connect(payload, call)],
      ['wx.closeBLEConnection', (payload, call) => this.#disconnect(payload, call)],
      ['wx.getBLEDeviceServices', (payload, call) => this.#command(payload, call, async record => {
        const services = []
        for (const uuid of record.grant.services) {
          const service = await this.#service(record, uuid, call.signal, true)
          if (service) services.push({ uuid, isPrimary: service.isPrimary })
        }
        return { ...ok(call.context.api), services }
      })],
      ['wx.getBLEDeviceCharacteristics', (payload, call) => this.#command(payload, call, async record => {
        const service = await this.#service(record, payload.serviceId, call.signal)
        const list = await this.#native(record, () => service.getCharacteristics())
        this.#assert(record, call.signal)
        check(list.length <= 256, 'Bluetooth characteristic count exceeds limit')
        const found = new Set(), result = [], entries = []
        for (const target of list) {
          const uuid = bluetoothUuid(target.uuid)
          check(!found.has(uuid), 'duplicate characteristic UUID cannot be addressed by the wx contract', 'unsupported'); found.add(uuid)
          entries.push([`${bluetoothUuid(service.uuid)}/${uuid}`, target])
          const p = target.properties
          result.push({ uuid, properties: { read: !!p.read, write: !!p.write || !!p.writeWithoutResponse, writeDefault: !!p.write, writeNoResponse: !!p.writeWithoutResponse, notify: !!p.notify, indicate: !!p.indicate } })
        }
        check(new Set([...record.characteristics.keys(),...entries.map(([key])=>key)]).size <= 256, 'Bluetooth characteristic cache exceeds limit')
        for (const [key, target] of entries) record.characteristics.set(key, target)
        return { ...ok(call.context.api), characteristics: result }
      })],
      ['wx.readBLECharacteristicValue', (payload, call) => this.#command(payload, call, async record => {
        const target = await this.#characteristic(record, payload, call.signal)
        check(target.properties.read, 'Bluetooth characteristic is not readable', 'unsupported')
        const value = await this.#native(record, () => target.readValue())
        this.#assert(record, call.signal)
        this.#value(record, payload, value, () => this.#current(record) && !call.signal.aborted)
        return ok(call.context.api)
      })],
      ['wx.writeBLECharacteristicValue', (payload, call) => this.#command(payload, call, async record => {
        check(payload.writeType === undefined || ['write','writeNoResponse'].includes(payload.writeType), 'invalid Bluetooth writeType')
        const target = await this.#characteristic(record, payload, call.signal), bytes = payload.value
        check(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes), 'Bluetooth value must be binary')
        check(bytes.byteLength <= 512, 'Bluetooth characteristic write exceeds 512 bytes')
        const method = payload.writeType === 'writeNoResponse' ? 'writeValueWithoutResponse' : 'writeValueWithResponse'
        check(payload.writeType === 'writeNoResponse' ? target.properties.writeWithoutResponse : target.properties.write, 'Bluetooth write mode is unsupported', 'unsupported')
        check(typeof target[method] === 'function', 'browser lacks the requested Bluetooth write mode', 'unsupported')
        this.#assert(record, call.signal)
        await this.#native(record, () => target[method](bytes)); this.#assert(record, call.signal)
        return ok(call.context.api)
      })],
      ['wx.notifyBLECharacteristicValueChange', (payload, call) => this.#notify(payload, call)],
    ])
  }
  #grant(deviceId) {
    check(!this.#closed && this.#initialized, 'Bluetooth owner is not initialized', 'cancelled')
    const grant = this.#grants.get(deviceId)
    check(grant && !grant.revoked && !grant.signal?.aborted, 'device is not granted to this application account', 'permission_denied')
    return grant
  }
  #current(record) { return !this.#closed && record.active && this.#initialized && !record.grant.revoked && !record.grant.signal?.aborted && this.#latest.get(record.device.id) === record && this.#broker.get(record.device.id) === record }
  #assert(record, signal) { check(!signal?.aborted && this.#current(record) && record.device.gatt.connected, 'Bluetooth connection or call was retired', 'cancelled') }
  async #native(record, operation) {
    let promise
    try { promise = Promise.resolve(operation()) } catch (error) { throw nativeError(error) }
    record.pending.add(promise)
    try { return await promise } catch (error) { throw nativeError(error) } finally { record.pending.delete(promise) }
  }
  #lane(record, operation) {
    const command = record.tail.then(operation)
    record.tail = command.catch(() => {})
    record.commands.add(command)
    void command.then(() => record.commands.delete(command), () => record.commands.delete(command))
    return command
  }
  #command(payload, call, operation) {
    this.#grant(payload.deviceId)
    const record = this.#latest.get(payload.deviceId)
    check(record, 'Bluetooth device is disconnected')
    return this.#lane(record, async () => {
      this.#assert(record, call.signal)
      const cancel = () => this.#retire(record)
      call.signal.addEventListener('abort', cancel, { once: true })
      try { return await operation(record) } finally { call.signal.removeEventListener('abort', cancel) }
    })
  }
  #retire(record) {
    record.active = false
    for (const intent of record.intents.values()) intent.active = false
    for (const notification of record.notifications.values()) notification.active = false
    this.#backgroundRelease(record)
  }
  #backgroundRelease(record) { void this.#release(record).catch(error => this.diagnostic(error)) }
  #release(record) {
    record.active = false
    for (const intent of record.intents.values()) intent.active = false
    for (const notification of record.notifications.values()) notification.active = false
    if (record.releasePromise) return record.releasePromise
    const releasing = Promise.resolve().then(async () => {
      if (!record.disconnected) { record.device.gatt.disconnect(); record.disconnected = true }
      // disconnect() aborts actual connect/GATT algorithms; wait their actual
      // terminals, including commands that were waiting for their turn.
      while (record.commands.size || record.pending.size) await Promise.allSettled([...record.commands, ...record.pending])
      for (const notification of record.notifications.values()) {
        if (notification.listenerAttached) { notification.target.removeEventListener('characteristicvaluechanged', notification.listener); notification.listenerAttached = false }
      }
      for (const [event, listener] of record.listeners) { record.device.removeEventListener(event, listener); record.listeners.delete(event) }
      if (record.connectAbort?.attached) { record.connectAbort.signal.removeEventListener('abort', record.connectAbort.listener); record.connectAbort.attached = false }
      for (const intent of record.intents.values()) this.#removeIntent(intent)
      record.notifications.clear(); record.services.clear(); record.characteristics.clear(); record.intents.clear()
      if (this.#broker.get(record.device.id) === record) this.#broker.delete(record.device.id)
      this.#records.delete(record)
    })
    record.releasePromise = releasing.catch(error => { record.releasePromise = null; throw error })
    return record.releasePromise
  }
  async #connect(payload, call) {
    const grant = this.#grant(payload.deviceId), device = grant.device
    check(!call.signal.aborted, 'Bluetooth connection call was cancelled', 'cancelled')
    const previous = this.#latest.get(device.id)
    if (previous && this.#current(previous) && device.gatt.connected) return { ...ok(call.context.api), deviceId: device.id }
    check(!this.#broker.has(device.id), 'Bluetooth device has an active or retiring owner', 'permission_denied')
    check(!device.gatt.connected, 'already-connected host Bluetooth devices cannot be adopted', 'permission_denied')
    const record = { device, grant, active: true, services: new Map(), characteristics: new Map(), notifications: new Map(), intents: new Map(), pending: new Set(), commands: new Set(), listeners: new Map(), tail: Promise.resolve(), disconnected: false, releasePromise: null, reportedDisconnect: false }
    this.#broker.set(device.id, record); this.#records.add(record); this.#latest.set(device.id, record)
    const disconnected = () => {
      if (this.#broker.get(device.id) !== record) return
      record.active = false
      for (const intent of record.intents.values()) intent.active = false
      for (const notification of record.notifications.values()) notification.active = false
      if (!record.reportedDisconnect) {
        record.reportedDisconnect = true
        this.emit('BLEConnectionStateChange', { deviceId: device.id, connected: false }, () => !this.#closed && this.#latest.get(device.id) === record)
      }
      this.#backgroundRelease(record)
    }
    const changed = () => this.#retire(record)
    const cancel = () => this.#retire(record)
    try {
      for (const [event, listener] of [['gattserverdisconnected',disconnected],['servicechanged',changed],['serviceremoved',changed]]) { device.addEventListener(event, listener); record.listeners.set(event, listener) }
      call.signal.addEventListener('abort', cancel, { once: true })
      record.connectAbort = { signal: call.signal, listener: cancel, attached: true }
      return await this.#lane(record, async () => {
        check(!call.signal.aborted && this.#current(record), 'Bluetooth connection call was retired', 'cancelled')
        await this.#native(record, () => device.gatt.connect())
        this.#assert(record, call.signal)
        this.emit('BLEConnectionStateChange', { deviceId: device.id, connected: true }, () => this.#current(record))
        return { ...ok(call.context.api), deviceId: device.id }
      })
    } catch (error) { this.#retire(record); throw error }
    // Keep the successful acquisition's abort hook until native release. Its
    // result can still be cancelled while waiting in the owner terminal queue.
  }
  async #disconnect(payload, call) {
    this.#grant(payload.deviceId)
    const record = this.#latest.get(payload.deviceId)
    check(record && this.#records.has(record), 'Bluetooth device is disconnected')
    await this.#release(record)
    return ok(call.context.api)
  }
  async #service(record, input, signal, optional = false) {
    const uuid = bluetoothUuid(input)
    check(record.grant.services.has(uuid), 'Bluetooth service is not granted to this application', 'permission_denied')
    this.#assert(record, signal)
    if (record.services.has(uuid)) return record.services.get(uuid)
    let list
    try { list = await this.#native(record, () => record.device.gatt.getPrimaryServices(uuid)) }
    catch (error) { this.#assert(record, signal); if (optional && error.name === 'NotFoundError') return null; throw error }
    this.#assert(record, signal)
    if (optional && list.length === 0) return null
    check(list.length === 1, 'Bluetooth service UUID is absent or ambiguous', list.length ? 'unsupported' : 'invalid_request')
    check(bluetoothUuid(list[0].uuid) === uuid, 'browser returned a different Bluetooth service')
    record.services.set(uuid, list[0]); return list[0]
  }
  async #characteristic(record, payload, signal) {
    const serviceId = bluetoothUuid(payload.serviceId), characteristicId = bluetoothUuid(payload.characteristicId), key = `${serviceId}/${characteristicId}`
    const service = await this.#service(record, serviceId, signal)
    if (!record.characteristics.has(key)) {
      const list = await this.#native(record, () => service.getCharacteristics(characteristicId))
      this.#assert(record, signal)
      check(list.length === 1 && bluetoothUuid(list[0].uuid) === characteristicId, 'Bluetooth characteristic UUID is absent or ambiguous', list.length > 1 ? 'unsupported' : 'invalid_request')
      check(record.characteristics.size < 256, 'Bluetooth characteristic cache exceeds limit')
      record.characteristics.set(key, list[0])
    }
    this.#assert(record, signal); return record.characteristics.get(key)
  }
  #value(record, payload, value, current) {
    if (!current()) return
    try {
      check(value instanceof DataView && value.byteLength <= 512, 'invalid Bluetooth characteristic value')
      const accepted = this.emit('BLECharacteristicValueChange', { deviceId: record.device.id, serviceId: bluetoothUuid(payload.serviceId), characteristicId: bluetoothUuid(payload.characteristicId), value: value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) }, current)
      if (!accepted) { this.#retire(record); throw fail('Bluetooth event backpressure retired the connection') }
    } catch (error) { this.#retire(record); throw error }
  }
  #notify(payload, call) {
    check(typeof payload.state === 'boolean', 'Bluetooth notification state must be boolean')
    check(payload.type === undefined || ['notification','indication'].includes(payload.type), 'invalid Bluetooth notification type')
    this.#grant(payload.deviceId)
    const record = this.#latest.get(payload.deviceId), key = `${bluetoothUuid(payload.serviceId)}/${bluetoothUuid(payload.characteristicId)}`
    check(record, 'Bluetooth device is disconnected')
    const exactType = target => {
      const p = target.properties
      check(p.notify || p.indicate, 'Bluetooth characteristic has no notifications', 'unsupported')
      if (payload.type) check(payload.type === 'notification' ? p.notify && !p.indicate : p.indicate && !p.notify, 'browser cannot guarantee the explicitly requested notification type', 'unsupported')
    }
    // Validate a known target before replacing its active intent. An invalid
    // reconfiguration must not orphan an existing native notification source
    // (or cancel a valid start that is already waiting on that source).
    const previousNotification = record.notifications.get(key)
    if (payload.state && previousNotification?.active) exactType(previousNotification.target)
    check(record.intents.has(key) || record.intents.size < 256, 'Bluetooth notification intent limit exceeded')
    // Install intent at invocation, before discovery or a prior native start
    // can yield. Disable cannot be lost while the previous lookup is pending.
    const intent = { active: true, signal: call.signal, listener: null, attached: false }, previousIntent = record.intents.get(key)
    if (previousIntent) {
      previousIntent.active = false
      try { this.#removeIntent(previousIntent) } catch (error) { this.#retire(record); throw error }
    }
    record.intents.set(key, intent)
    const currentIntent = () => intent.active && record.intents.get(key) === intent && !call.signal.aborted
    if (!payload.state && record.notifications.has(key)) record.notifications.get(key).active = false
    const cancel = () => { intent.active = false; this.#retire(record) }
    call.signal.addEventListener('abort', cancel, { once: true })
    intent.listener = cancel; intent.attached = true
    let keepAbortHook = false
    return this.#lane(record, async () => {
      this.#assert(record, call.signal)
      check(currentIntent(), 'Bluetooth notification intent was superseded', 'cancelled')
      let notification = record.notifications.get(key)
      if (!payload.state) {
        if (notification) await this.#stopNotification(record, notification)
        this.#assert(record, call.signal); check(currentIntent(), 'Bluetooth notification intent was superseded', 'cancelled')
        return ok(call.context.api)
      }
      if (notification?.active && notification.started) { exactType(notification.target); notification.intent = intent; return ok(call.context.api) }
      if (notification) await this.#stopNotification(record, notification)
      const target = await this.#characteristic(record, payload, call.signal)
      check(currentIntent(), 'Bluetooth notification intent was superseded', 'cancelled'); exactType(target)
      notification = { target, intent, active: true, started: false, listenerAttached: false, listener: null, stopPromise: null }
      notification.listener = event => {
        const eventIntent = notification.intent
        const current = () => this.#current(record) && notification.active && notification.started && record.notifications.get(key) === notification && eventIntent.active && record.intents.get(key) === eventIntent
        if (!current()) return
        try { this.#value(record, payload, event.target.value, current) } catch (error) { this.diagnostic(error) }
      }
      record.notifications.set(key, notification)
      try {
        target.addEventListener('characteristicvaluechanged', notification.listener); notification.listenerAttached = true
        await this.#native(record, () => target.startNotifications()); notification.started = true
        if (!currentIntent() || !notification.active || !this.#current(record)) { await this.#stopNotification(record, notification); throw fail('Bluetooth notification start was retired', 'cancelled') }
        return ok(call.context.api)
      } catch (error) {
        notification.active = false
        try { await this.#stopNotification(record, notification) } catch (cleanup) { this.#retire(record); throw new AggregateError([error,cleanup], 'Bluetooth notification cleanup failed') }
        throw error
      }
    }).then(result => { keepAbortHook = payload.state && currentIntent() && this.#current(record); return result })
      .finally(() => {
        if (!keepAbortHook) {
          intent.active = false
          try { this.#removeIntent(intent) } catch (error) { this.#retire(record); throw error }
        }
      })
  }
  #removeIntent(intent) {
    if (intent.attached) { intent.signal.removeEventListener('abort', intent.listener); intent.attached = false }
  }
  #stopNotification(record, notification) {
    notification.active = false
    if (notification.stopPromise) return notification.stopPromise
    notification.stopPromise = Promise.resolve().then(async () => {
      if (notification.started && !record.disconnected && record.device.gatt.connected) { await this.#native(record, () => notification.target.stopNotifications()); notification.started = false }
      if (notification.listenerAttached) { notification.target.removeEventListener('characteristicvaluechanged', notification.listener); notification.listenerAttached = false }
    }).catch(error => { notification.stopPromise = null; throw error })
    return notification.stopPromise
  }
  async #closeAdapter(call) { await this.suspend(); return ok(call.context.api) }
  suspend = async () => {
    this.#initialized = false
    const results = await Promise.allSettled([...this.#records].map(record => this.#release(record)))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Bluetooth exact native releases failed; retry close')
  }
  close = async () => {
    this.#closed = true
    await this.suspend()
    for (const [grant, listener] of this.#grantListeners) { grant.signal.removeEventListener('abort', listener); this.#grantListeners.delete(grant) }
  }
}
