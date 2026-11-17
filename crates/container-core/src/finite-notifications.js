// Callback ownership is independent of the optional native event producer.
// Neither host descriptors nor public compatibility transports own this list.
const __container_finite_notifications = (function() {
  const create = Object.create, define = Object.defineProperty, descriptor = Object.getOwnPropertyDescriptor;
  const apply = Reflect.apply, string = String, TypeFailure = TypeError, Failure = Error;
  const charCode = Function.prototype.call.bind(String.prototype.charCodeAt);
  const slice = Function.prototype.call.bind(String.prototype.slice);
  const report = __container_report_error, root = globalThis;
  const partialProducerEvents = ['AfterPageLoad', 'AppRouteDone', 'BeforePageLoad', 'CopyUrl',
    'EmbeddedMiniProgramHeightChange', 'LazyLoadError', 'MenuButtonBoundingClientRectWeightChange',
    'ParallelStateChange', 'UserOffTranslation', 'UserTriggerTranslation'];
  const ordinaryProducerEvents = ['ApiCategoryChange', 'AudioInterruptionBegin', 'AudioInterruptionEnd',
    'KeyboardHeightChange', 'LocalServiceDiscoveryStop', 'LocalServiceFound', 'LocalServiceLost',
    'LocalServiceResolveFail', 'MemoryWarning', 'ScreenRecordingStateChanged', 'ThemeChange',
    'VoIPChatInterrupted', 'VoIPChatMembersChanged', 'VoIPChatSpeakersChanged',
    'VoIPChatStateChanged', 'VoIPVideoMembersChanged', 'BatteryInfoChange',
    'BLEPeripheralConnectionStateChanged', 'DeviceMotionChange', 'NetworkWeakChange'];
  const events = partialProducerEvents.concat(ordinaryProducerEvents);
  const objectEvents = [['TCPSocket', ['BindWifi', 'Close', 'Connect', 'Error', 'Message']],
    ['UDPSocket', ['Close', 'Error', 'Listening', 'Message']],
    ['InnerAudioContext', ['Canplay', 'Ended', 'Error', 'Pause', 'Play', 'Seeked', 'Seeking', 'Stop', 'TimeUpdate', 'Waiting']]];
  const partialProducers = create(null), states = create(null), records = create(null);
  const objectPolicies = create(null), objectOwners = create(null);
  let objectHead = null, objectTail = null;
  let bridge = null, retired = false, sequence = 0n, count = 0;
  let cancelHead = null, cancelTail = null;
  const maximum = 4096;
  function put(target, key, value) {
    const property = create(null); property.value = value;
    property.writable = property.enumerable = property.configurable = true;
    define(target, key, property);
  }
  function own(target, key) {
    if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return undefined;
    const property = descriptor(target, key);
    return property && descriptor(property, 'value') ? property.value : undefined;
  }
  function enabled(value) { return value === 'full' || value === 'partial'; }
  function require(name, enabled) {
    if (enabled) return;
    const error = create(null); put(error, 'api', name); put(error, 'code', 'ERR_UNSUPPORTED_CAPABILITY');
    put(error, 'errMsg', name + ':fail unsupported'); throw error;
  }
  function removeRecord(state, record) {
    if (!record.active) return;
    record.active = false; delete records[record.id];
    record.callback = null;
    if (record.previous) record.previous.next = record.next;
    else state.head = record.next;
    if (record.next) record.next.previous = record.previous;
    else state.tail = record.previous;
    record.next = record.previous = null;
    // Reserve cancellation storage with the registration. Public removal does
    // not allocate or depend on a mutable diagnostic array/Promise/provider.
    if (record.bound) {
      if (cancelTail) cancelTail.cancelNext = record;
      else cancelHead = record;
      cancelTail = record;
    } else count--;
  }
  function clear(state) {
    let record = state.head;
    while (record) { const next = record.next; removeRecord(state, record); record = next; }
  }
  function failed(state, record, error) {
    if (!record.active || records[record.id] !== record) return;
    removeRecord(state, record);
    if (own(error, 'code') !== 'ERR_CANCELLED') { try { report(error); } catch (_) {} }
  }
  function connect(state, record) {
    const policy = state.policy || state;
    if (!bridge || !policy.available || !record.active || record.bound || retired) return;
    record.bound = true;
    try {
      if (!bridge.subscribe(state.onName, record.id, function(error) { failed(state, record, error); }, state.objectId)) record.bound = false;
    } catch (error) { failed(state, record, error); }
  }
  function add(state, callback) {
    const policy = state.policy || state;
    // Preserve the original ten's admission order and delayed activation.
    if (state.partialProducer) require(state.onName, policy.on);
    if (typeof callback !== 'function') throw new TypeFailure('listener must be a function');
    // Ordinary producers keep the generic bridge's type validation followed
    // by installed-descriptor admission, before allocating callback state.
    if (!state.partialProducer) require(state.onName, policy.on && policy.available);
    if (retired) throw new Failure('finite event notifications are retired');
    for (let record = state.head; record; record = record.next) if (record.callback === callback) return;
    // Count includes unacknowledged cancellations. Off itself never fails for
    // lack of cancellation space, including repeated register/remove turns.
    if (count >= maximum || sequence >= 18446744073709551615n) throw new Failure('finite event registration budget exceeded');
    const record = create(null);
    record.id = 'finite-subscription-' + string(++sequence); record.callback = callback;
    record.state = state; record.active = true; record.bound = false; record.sequence = null;
    record.previous = state.tail; record.next = null; record.cancelNext = null;
    if (state.tail) state.tail.next = record;
    else state.head = record;
    state.tail = record; put(records, record.id, record); count++;
    connect(state, record);
  }
  function remove(state, callback) {
    require(state.offName, (state.policy || state).off);
    if (callback === undefined) { clear(state); return; }
    if (typeof callback !== 'function') throw new TypeFailure('listener must be a function');
    for (let record = state.head; record; record = record.next) {
      if (record.callback === callback) { removeRecord(state, record); return; }
    }
  }
  function install(policy) {
    for (let index = 0; index < events.length; index++) {
      const state = states['wx.on' + events[index]];
      const on = own(policy, state.onName), off = own(policy, state.offName);
      state.on = enabled(on); state.off = enabled(off);
      if (!state.on) clear(state);
      // Callback ownership does not weaken a separately negotiated producer.
      put(policy, state.onName, state.on ? (state.partialProducer ? 'partial' : on) : 'unsupported');
      put(policy, state.offName, state.off ? off : 'unsupported');
    }
    for (let index = 0; index < objectEvents.length; index++) {
      const type = objectEvents[index][0], names = objectEvents[index][1];
      for (let eventIndex = 0; eventIndex < names.length; eventIndex++) {
        const state = objectPolicies['object:' + type + '.on' + names[eventIndex]];
        const on = own(policy, state.onName), off = own(policy, state.offName);
        state.on = enabled(on); state.off = enabled(off);
        put(policy, state.onName, state.on ? on : 'unsupported');
        put(policy, state.offName, state.off ? off : 'unsupported');
      }
    }
    for (let owner = objectHead; owner; owner = owner.next) {
      for (let index = 0; index < owner.states.length; index++) {
        const state = owner.states[index]; if (!state.policy.on) clear(state);
      }
    }
  }
  function activate(name) {
    const state = own(states, name) || own(objectPolicies, name);
    if (!state || retired) return false;
    state.available = true;
    let record = state.head;
    while (record) { const next = record.next; connect(state, record); record = next; }
    for (let owner = objectHead; owner; owner = owner.next) {
      for (let index = 0; index < owner.states.length; index++) {
        const member = owner.states[index];
        if (member.policy !== state) continue;
        let record = member.head;
        while (record) { const next = record.next; connect(member, record); record = next; }
      }
    }
    return true;
  }
  function validSequence(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 20 || value[0] === '0') return false;
    for (let index = 0; index < value.length; index++) {
      const code = charCode(value, index); if (code < 48 || code > 57) return false;
    }
    return value.length !== 20 || value <= '18446744073709551615';
  }
  function receive(name, event) {
    const id = own(event, 'subscriptionId');
    const record = typeof id === 'string' ? own(records, id) : undefined;
    const state = record && record.state, policy = state && (state.policy || state);
    const next = own(event, 'sequence'), object = own(event, 'objectId'), kind = own(event, 'event');
    if (retired || !state || state.onName !== name || !policy.on || !record.active || !record.bound
        || (state.objectId === undefined ? object !== undefined && object !== null : object !== state.objectId)
        || kind !== undefined && kind !== null && kind !== state.event
        || !validSequence(next) || record.sequence !== null &&
        (next.length < record.sequence.length || next.length === record.sequence.length && next <= record.sequence)) return false;
    // Claim before callbacks. Off/re-add gets a new identity; an old completion
    // or already queued event cannot attach itself to the replacement listener.
    record.sequence = next;
    const value = bridge.decode(own(event, 'value'));
    // Property mirrors share the same admission claim as their callback. A
    // stale/off/retired notification cannot update an object's visible state,
    // and the listener observes accepted native values in its own turn.
    if (state.objectId !== undefined) bridge.update(state.objectId, value);
    try {
      __container_turn_scheduler.withCapturedOwner(null, function() { apply(record.callback, root, [value]); });
    } catch (error) { try { report(error); } catch (_) {} }
    return true;
  }
  function snapshot() {
    // IDs contain only this private ASCII prefix and a decimal u64. Encoding
    // runs no guest getter/toJSON and does not consume the retained queue.
    let result = '{"active":[', first = true;
    for (let index = 0; index < events.length; index++) {
      const state = states['wx.on' + events[index]];
      for (let record = state.head; record; record = record.next) {
        if (!record.bound) continue;
        result += (first ? '' : ',') + '{"id":"' + record.id + '","api":"' + state.onName + '"}';
        first = false;
      }
    }
    for (let owner = objectHead; owner; owner = owner.next) {
      for (let index = 0; index < owner.states.length; index++) {
        const state = owner.states[index];
        for (let record = state.head; record; record = record.next) {
          if (!record.bound) continue;
          result += (first ? '' : ',') + '{"id":"' + record.id + '","api":"' + state.onName
            + '","objectId":"' + state.objectId + '"}';
          first = false;
        }
      }
    }
    result += '],"cancellations":[';
    let record = cancelHead; first = true;
    while (record) { result += (first ? '' : ',') + '"' + record.id + '"'; first = false; record = record.cancelNext; }
    return result + ']}';
  }
  function acknowledge(id) {
    let through = cancelHead;
    while (through && through.id !== id) through = through.cancelNext;
    if (!through) return false;
    const next = through.cancelNext;
    while (cancelHead !== next) { const record = cancelHead; cancelHead = record.cancelNext; record.cancelNext = null; count--; }
    if (!cancelHead) cancelTail = null;
    return true;
  }
  function retire() {
    if (retired) return;
    retired = true;
    for (let index = 0; index < events.length; index++) clear(states['wx.on' + events[index]]);
    while (objectHead) retireObject(objectHead);
  }
  function retireObject(owner) {
    if (owner.retired) return;
    owner.retired = true;
    delete objectOwners[owner.id];
    for (let index = 0; index < owner.states.length; index++) clear(owner.states[index]);
    if (owner.previous) owner.previous.next = owner.next; else objectHead = owner.next;
    if (owner.next) owner.next.previous = owner.previous; else objectTail = owner.previous;
    owner.previous = owner.next = null;
    owner.onRetire();
  }
  function retireObjectId(id) {
    const owner = typeof id === 'string' ? own(objectOwners, id) : undefined;
    if (!owner) return false;
    retireObject(owner); return true;
  }
  function validObjectId(id) {
    return typeof id === 'string' && slice(id, 0, 14) === 'native-object-' && validSequence(slice(id, 14));
  }
  function attachObject(id, type, target, available, onRetire) {
    let names;
    for (let index = 0; index < objectEvents.length; index++) {
      if (objectEvents[index][0] === type) names = objectEvents[index][1];
    }
    if (!names) return undefined;
    // The factory bridge supplies this private identity. Restrict its bytes so
    // the retained snapshot never invokes guest JSON/string conversion hooks.
    if (!validObjectId(id) || typeof available !== 'function' || typeof onRetire !== 'function') throw new Failure('invalid finite object identity');
    const owner = create(null); owner.id = id; owner.states = create(null); owner.states.length = names.length; owner.retired = false;
    owner.onRetire = onRetire;
    put(objectOwners, id, owner);
    owner.previous = objectTail; owner.next = null;
    if (objectTail) objectTail.next = owner; else objectHead = owner;
    objectTail = owner;
    for (let index = 0; index < names.length; index++) {
      const event = names[index], state = create(null), policy = objectPolicies['object:' + type + '.on' + event];
      state.policy = policy; state.onName = policy.onName; state.offName = policy.offName;
      state.objectId = id; state.event = event; state.head = state.tail = null;
      owner.states[index] = state;
      function assertLive(name) {
        available(name);
        if (owner.retired) {
          const error = create(null); put(error, 'api', name); put(error, 'code', 'ERR_CANCELLED');
          put(error, 'errMsg', name + ':fail object retired'); throw error;
        }
      }
      put(target, 'on' + event, function(callback) { assertLive(state.onName); add(state, callback); });
      // Removal is independently admitted and remains idempotent after object
      // retirement. It never calls a receiver operation or revives the owner.
      put(target, 'off' + event, function(callback) { remove(state, callback); });
    }
    return function() { retireObject(owner); };
  }
  function bind(subscribe, decode, update) {
    if (bridge || typeof subscribe !== 'function' || typeof decode !== 'function'
        || typeof update !== 'function') throw new Failure('finite event transport is already bound or invalid');
    bridge = create(null); bridge.subscribe = subscribe; bridge.decode = decode; bridge.update = update;
    return { owns: function(name) {
      for (let index = 0; index < events.length; index++) {
        const event = events[index]; if (name === 'wx.on' + event || name === 'wx.off' + event) return true;
      }
      for (let index = 0; index < objectEvents.length; index++) {
        const type = objectEvents[index][0], names = objectEvents[index][1];
        for (let eventIndex = 0; eventIndex < names.length; eventIndex++) {
          const prefix = 'object:' + type + '.';
          if (name === prefix + 'on' + names[eventIndex] || name === prefix + 'off' + names[eventIndex]) return true;
        }
      }
      return false;
    }, activate: activate, attachObject: attachObject };
  }
  for (let index = 0; index < partialProducerEvents.length; index++) {
    put(partialProducers, 'wx.on' + partialProducerEvents[index], true);
  }
  for (let index = 0; index < events.length; index++) {
    const event = events[index], state = create(null);
    state.event = event; state.onName = 'wx.on' + event; state.offName = 'wx.off' + event;
    state.partialProducer = own(partialProducers, state.onName) === true;
    state.head = state.tail = null; state.on = state.off = state.available = false;
    put(states, state.onName, state);
    put(wx, 'on' + event, function(callback) { add(state, callback); });
    // The locked offCopyUrl() contract has no argument. Any supplied argument
    // is ignored, rather than accidentally changing it into identity removal.
    put(wx, 'off' + event, event === 'CopyUrl'
      ? function() { remove(state, undefined); }
      : function(callback) { remove(state, callback); });
  }
  for (let index = 0; index < objectEvents.length; index++) {
    const type = objectEvents[index][0], names = objectEvents[index][1];
    for (let eventIndex = 0; eventIndex < names.length; eventIndex++) {
      const state = create(null), prefix = 'object:' + type + '.';
      state.onName = prefix + 'on' + names[eventIndex]; state.offName = prefix + 'off' + names[eventIndex];
      state.on = state.off = state.available = false; state.head = null;
      put(objectPolicies, state.onName, state);
    }
  }
  put(root, '__container_bind_finite_notifications', bind);
  install(__container_capabilities);
  return { install: install, receive: receive, snapshot: snapshot, acknowledge: acknowledge, retire: retire, retireObject: retireObjectId, validObjectId: validObjectId };
})();
