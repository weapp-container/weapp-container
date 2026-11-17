// Private Session intersection state. Native retains capture/dispatch before
// guest code; public compatibility tables and effect queues carry no authority.
const __container_intersections = (function() {
  const legacy = __container_intersection_observer;
  const releaseLegacy = __container_release_observers;
  const captureOwner = __container_api_owner_for_observer;
  const runWithOwner = __container_turn_scheduler.withOwner;
  const reportError = __container_observer_report;
  const capabilityError = __container_error;
  const apply = Reflect.apply;
  const then = Function.call.bind(Promise.prototype.then);
  const parse = JSON.parse;
  const records = __host_create(null);
  const marginFields = ['top', 'right', 'bottom', 'left'];
  const optionFields = ['initialRatio', 'observeAll', 'nativeMode'];
  const maximum = 18446744073709551615n;
  let session = false, retired = false;
  let sequence = 0n, subscriptionSequence = 0n, revision = 0n;
  let recordCount = 0, subscriptionCount = 0;
  function put(object, key, value) {
    const descriptor = __host_create(null);
    descriptor.value = value;
    descriptor.writable = descriptor.enumerable = descriptor.configurable = true;
    __host_define(object, key, descriptor);
  }
  function fail(message) {
    const error = __host_create(null);
    error.errMsg = 'wx.createIntersectionObserver:fail ' + message;
    error.code = 'ERR_INVALID_REQUEST';
    error.api = 'wx.createIntersectionObserver';
    return error;
  }
  function field(object, key) {
    if (!object || typeof object !== 'object') throw fail('options must be an object');
    const descriptor = __host_get_own(object, key);
    if (!descriptor) return undefined;
    if (!__host_get_own(descriptor, 'value')) throw fail('option accessors are unsupported');
    return descriptor.value;
  }
  function finite(value) { return typeof value === 'number' && value === value && value !== 1/0 && value !== -1/0; }
  function advance() {
    if (revision >= maximum) throw fail('subscription revision exhausted');
    revision += 1n;
  }
  function invalidate() {
    if (revision < maximum) revision += 1n;
    else retired = true;
  }
  function live(record) {
    const identity = record.identity, page = record.pageIdentity;
    return !retired && !identity.retired && !page.retired
      && __receiver_get(__receiver_weak, record.owner) === identity
      && __receiver_value(__receiver_pages, identity.pageId) === page
      && (identity.scopeId === null ? identity === page
        : identity.pageToken === page.token && __receiver_value(__receiver_scopes, identity.scopeId) === identity);
  }
  function revoke(record) {
    if (!record.active) return;
    // Revoke first. No property read, JSON conversion, bridge call, Promise or
    // application hook can occur before local delivery is permanently disabled.
    record.active = false;
    if (__receiver_value(records, record.id) === record) {
      // Cleanup cannot fail on a revision overflow. Exhaustion permanently
      // retires admission, and a saturated revision still invalidates via a
      // complete snapshot on native's next capture.
      invalidate();
      delete records[record.id];
      recordCount -= 1;
      subscriptionCount -= record.count;
    }
    record.subscriptions = __host_create(null);
    record.count = 0;
  }
  function requireLive(record) {
    if (!record.active) throw fail('observer has been disconnected');
    if (!live(record)) { revoke(record); throw fail('observer owner has been disposed'); }
  }
  function margins(source) {
    const result = __host_create(null);
    if (source == null) return result;
    if (typeof source !== 'object' || __host_is_array(source)) throw fail('margins must be an object');
    for (let i = 0; i < marginFields.length; i += 1) {
      const key = marginFields[i];
      const value = field(source, key);
      if (value !== undefined) {
        if (!finite(value)) throw fail('margin must be a finite number');
        put(result, key, value);
      }
    }
    return result;
  }
  function options(source) {
    if (source === undefined) source = __host_create(null);
    if (!source || typeof source !== 'object' || __host_is_array(source)) throw fail('options must be an object');
    const result = __host_create(null);
    for (let i = 0; i < optionFields.length; i += 1) {
      const key = optionFields[i];
      const value = field(source, key);
      if (value === undefined) continue;
      if (key === 'initialRatio' ? !finite(value) || value < 0 || value > 1 : typeof value !== 'boolean') throw fail('invalid observer option');
      put(result, key, value);
    }
    const thresholds = field(source, 'thresholds');
    if (thresholds !== undefined) {
      if (!__host_is_array(thresholds) || !thresholds.length || thresholds.length > 1024) throw fail('invalid thresholds');
      const values = [];
      for (let i = 0; i < thresholds.length; i += 1) {
        const value = field(thresholds, __host_string(i));
        if (!finite(value) || value < 0 || value > 1) throw fail('invalid threshold');
        put(values, __host_string(i), value);
      }
      put(result, 'thresholds', values);
    }
    put(result, 'relativeRoots', []);
    return result;
  }
  function standalone(args) {
    // Standalone JsEngine diagnostics retain their existing geometry provider.
    // Normalize just the locked cleanup return and own its rejection handler.
    const api = apply(legacy, undefined, args);
    const disconnect = field(api, 'disconnect');
    put(api, 'disconnect', function() {
      try { then(apply(disconnect, api, []), undefined, reportError); }
      catch (error) { try { reportError(error); } catch (_) {} }
    });
    return api;
  }
  function create(componentOrOptions, maybeOptions) {
    if (!session) return standalone([componentOrOptions, maybeOptions]);
    if (retired) throw fail('application observers are retired');
    const support = __receiver_value(__container_capabilities, 'wx.createIntersectionObserver');
    if (!support || support === 'unsupported') throw capabilityError('wx.createIntersectionObserver', 'unsupported');
    const explicit = maybeOptions !== undefined || !!(componentOrOptions && typeof componentOrOptions === 'object'
      && __receiver_get(__receiver_weak, componentOrOptions));
    const component = explicit ? componentOrOptions : null;
    const contextual = component || captureOwner();
    const pages = __host_current_pages === null ? __receiver_current_pages : __host_current_pages;
    const owner = contextual || (pages && pages.length ? pages[pages.length - 1] : null);
    const identity = owner && typeof owner === 'object' ? __receiver_get(__receiver_weak, owner) : null;
    const page = identity && __receiver_value(__receiver_pages, identity.pageId);
    if (!identity || !page) throw fail('observer owner is not a registered receiver');
    const config = options(explicit ? maybeOptions : componentOrOptions);
    if (sequence >= maximum) throw fail('observer identity exhausted');
    const record = __host_create(null);
    record.id = 'intersection:' + __host_string(++sequence);
    record.owner = owner;
    record.identity = identity;
    record.pageIdentity = page;
    record.scopeId = component ? identity.scopeId : null;
    record.active = true;
    record.readingRoots = false;
    record.subscriptions = __host_create(null);
    record.count = 0;
    requireLive(record);
    const api = {};
    function addRoot(selector, source) {
      requireLive(record);
      if (config.relativeRoots.length >= 1024) throw fail('relative root budget exceeded');
      if (config.nativeMode === true && config.relativeRoots.length) throw fail('nativeMode permits only one relative root');
      if (record.readingRoots) throw fail('relative root projection is reentrant');
      record.readingRoots = true;
      let projected;
      try { projected = margins(source); }
      finally { record.readingRoots = false; }
      requireLive(record);
      const root = __host_create(null);
      put(root, 'kind', selector === null ? 'viewport' : 'node');
      if (selector !== null) put(root, 'selector', selector);
      put(root, 'margins', projected);
      put(config.relativeRoots, __host_string(config.relativeRoots.length), root);
      return api;
    }
    put(api, 'relativeTo', function(selector, source) {
      if (typeof selector !== 'string' || !selector.length) throw fail('relative selector is required');
      return addRoot(selector, source);
    });
    put(api, 'relativeToViewport', function(source) { return addRoot(null, source); });
    put(api, 'observe', function(selector, callback) {
      requireLive(record);
      if (typeof selector !== 'string' || !selector.length) throw fail('selector is required');
      if (typeof callback !== 'function') throw fail('callback must be a function');
      if (subscriptionCount >= 4096 || (!record.count && recordCount >= 1024)) throw fail('subscription budget exceeded');
      if (subscriptionSequence >= maximum) throw fail('subscription identity exhausted');
      // Snapshot private primitive-only options, never guest toJSON/getters.
      const normalized = parse(__receiver_snapshot_json(config));
      advance();
      const id = 'intersection-subscription:' + __host_string(++subscriptionSequence);
      const subscription = __host_create(null);
      subscription.selector = selector;
      subscription.options = normalized;
      subscription.callback = callback;
      put(record.subscriptions, id, subscription);
      if (!record.count) { put(records, record.id, record); recordCount += 1; }
      record.count += 1;
      subscriptionCount += 1;
    });
    put(api, 'disconnect', function() { revoke(record); });
    return api;
  }
  function release(owner) {
    const identity = owner && typeof owner === 'object' ? __receiver_get(__receiver_weak, owner) : null;
    if (!identity) return;
    const keys = __host_keys(records);
    for (let i = 0; i < keys.length; i += 1) {
      const record = __receiver_value(records, keys[i]);
      if (record && (record.identity === identity || (identity.scopeId === null && record.pageIdentity === identity))) revoke(record);
    }
  }
  function capture(request) {
    const support = __receiver_value(__container_capabilities, 'wx.createIntersectionObserver');
    const keys = __host_keys(records);
    for (let i = 0; i < keys.length; i += 1) {
      const record = __receiver_value(records, keys[i]);
      if (record && (!live(record) || !support || support === 'unsupported')) revoke(record);
    }
    const result = __host_create(null);
    result.revision = __host_string(revision);
    if (!retired && __receiver_value(request, 'revision') === result.revision) {
      result.unchanged = true;
      return __receiver_snapshot_json(result);
    }
    const subscriptions = [];
    const active = __host_keys(records);
    for (let i = 0; i < active.length; i += 1) {
      const record = __receiver_value(records, active[i]);
      const ids = __host_keys(record.subscriptions);
      for (let j = 0; j < ids.length; j += 1) {
        const source = __receiver_value(record.subscriptions, ids[j]);
        const value = __host_create(null);
        value.observerId = record.id;
        value.subscriptionId = ids[j];
        value.pageId = record.identity.pageId;
        value.scopeId = record.scopeId;
        value.ownerScopeId = record.identity.scopeId;
        value.ownerToken = record.identity.token;
        value.pageToken = record.pageIdentity.token;
        value.selector = source.selector;
        value.options = source.options;
        put(subscriptions, __host_string(subscriptions.length), value);
      }
    }
    result.subscriptions = subscriptions;
    return __receiver_snapshot_json(result);
  }
  function reject(batch) {
    if (retired || !__host_is_array(batch)) return false;
    let consumed = false;
    for (let i = 0; i < batch.length; i += 1) {
      const entry = __receiver_value(batch, __host_string(i));
      const record = __receiver_value(records, __receiver_value(entry, 'observerId'));
      if (!record || !record.active) continue;
      if (!live(record)) { revoke(record); continue; }
      const id = __receiver_value(entry, 'subscriptionId');
      const subscription = __receiver_value(record.subscriptions, id);
      if (!subscription || __receiver_value(entry, 'ownerToken') !== record.identity.token
          || __receiver_value(entry, 'pageToken') !== record.pageIdentity.token) continue;
      // Native admission rejected this exact private subscription. Consume it
      // before returning the error, so an unreachable invalid observation can
      // never block later valid subscriptions or unrelated host effects.
      delete record.subscriptions[id];
      record.count -= 1;
      subscriptionCount -= 1;
      invalidate();
      if (!record.count) { delete records[record.id]; recordCount -= 1; }
      consumed = true;
    }
    return consumed;
  }
  function dispatch(batch) {
    if (retired || !__host_is_array(batch)) return false;
    for (let i = 0; i < batch.length; i += 1) {
      const notification = __receiver_value(batch, __host_string(i));
      const record = __receiver_value(records, __receiver_value(notification, 'observerId'));
      if (!record || !record.active) continue;
      if (!live(record)) { revoke(record); continue; }
      const subscription = __receiver_value(record.subscriptions, __receiver_value(notification, 'subscriptionId'));
      if (!subscription || __receiver_value(notification, 'ownerToken') !== record.identity.token
          || __receiver_value(notification, 'pageToken') !== record.pageIdentity.token) continue;
      const value = parse(__receiver_snapshot_json(__receiver_value(notification, 'value')));
      try { runWithOwner(record.owner, function() { apply(subscription.callback, undefined, [value]); }); }
      catch (error) { try { reportError(error); } catch (_) {} }
    }
    return true;
  }
  __container_intersection_observer = create;
  put(wx, 'createIntersectionObserver', create);
  __container_release_observers = function(owner, filter) {
    release(owner);
    return apply(releaseLegacy, undefined, [owner, filter]);
  };
  return {
    session: function() { session = true; },
    retire: function() {
      retired = true;
      const keys = __host_keys(records);
      for (let i = 0; i < keys.length; i += 1) revoke(__receiver_value(records, keys[i]));
    },
    capture: capture,
    reject: reject,
    dispatch: dispatch
  };
})();
