// Media observations in a Session have one private owner and desired state.
// Native retains capture/dispatch before any application code runs. The public
// observer table and effect queue remain standalone diagnostic compatibility.
const __container_media_queries = (function() {
  const legacy = __container_media_query_observer;
  const releaseLegacy = __container_release_observers;
  const captureOwner = __container_api_owner_for_observer;
  const runWithOwner = __container_turn_scheduler.withOwner;
  const reportError = __container_observer_report;
  const capabilityError = __container_error;
  const apply = Reflect.apply;
  const get = Reflect.get;
  const records = __host_create(null);
  const fields = ['width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight', 'orientation'];
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
    error.errMsg = 'wx.createMediaQueryObserver:fail ' + message;
    error.code = 'ERR_INVALID_REQUEST';
    error.api = 'wx.createMediaQueryObserver';
    return error;
  }
  function advance() {
    if (revision >= 18446744073709551615n) throw fail('subscription revision exhausted');
    revision += 1n;
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
    record.active = false;
    if (__receiver_value(records, record.id) === record) {
      advance();
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
  function project(record, source) {
    if (!source || typeof source !== 'object' || __host_is_array(source)) throw fail('descriptor must be an object');
    if (record.reading) throw fail('descriptor observation is reentrant');
    record.reading = true;
    const result = __host_create(null);
    try {
      for (let i = 0; i < fields.length; i += 1) {
        const key = fields[i];
        let value;
        try {
          // Documented dictionary fields use ordinary property semantics,
          // including class/prototype getters. Read exactly these seven
          // names once; never enumerate unknown keys or inspect toJSON.
          value = get(source, key);
        } catch (_) { throw fail('descriptor fields could not be read'); }
        // Optional fields explicitly set to undefined have the omitted meaning.
        if (value === undefined) continue;
        if (i === 6 ? value !== 'portrait' && value !== 'landscape'
          : typeof value !== 'number' || value !== value || value === 1/0 || value === -1/0 || value < 0) {
          throw fail(i === 6 ? 'orientation must be portrait or landscape' : key + ' must be a finite non-negative number');
        }
        put(result, key, value);
      }
    } finally { record.reading = false; }
    requireLive(record);
    return result;
  }
  function create(component) {
    if (!session) return apply(legacy, undefined, [component]);
    if (retired) throw fail('application observers are retired');
    const support = __receiver_value(__container_capabilities, 'wx.createMediaQueryObserver');
    if (!support || support === 'unsupported') throw capabilityError('wx.createMediaQueryObserver', 'unsupported');
    const contextual = component && typeof component === 'object' ? component : captureOwner();
    const pages = __host_current_pages === null ? __receiver_current_pages : __host_current_pages;
    const owner = contextual || (pages && pages.length ? pages[pages.length - 1] : null);
    const identity = owner && typeof owner === 'object' ? __receiver_get(__receiver_weak, owner) : null;
    const page = identity && __receiver_value(__receiver_pages, identity.pageId);
    if (!identity || !page) throw fail('observer owner is not a registered receiver');
    if (sequence >= 18446744073709551615n) throw fail('observer identity exhausted');
    const record = __host_create(null);
    record.id = 'media:' + __host_string(++sequence);
    record.owner = owner;
    record.identity = identity;
    record.pageIdentity = page;
    record.active = true;
    record.reading = false;
    record.subscriptions = __host_create(null);
    record.count = 0;
    requireLive(record);
    const api = {};
    put(api, 'observe', function(descriptor, callback) {
      requireLive(record);
      if (typeof callback !== 'function') throw fail('callback must be a function');
      const normalized = project(record, descriptor);
      if (subscriptionCount >= 4096 || (!record.count && recordCount >= 1024)) throw fail('subscription budget exceeded');
      if (subscriptionSequence >= 18446744073709551615n) throw fail('subscription identity exhausted');
      advance();
      const id = 'media-subscription:' + __host_string(++subscriptionSequence);
      const subscription = __host_create(null);
      subscription.descriptor = normalized;
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
    const keys = __host_keys(records);
    for (let i = 0; i < keys.length; i += 1) {
      const record = __receiver_value(records, keys[i]);
      if (record && !live(record)) revoke(record);
    }
    const result = __host_create(null);
    result.revision = __host_string(revision);
    if (__receiver_value(request, 'revision') === result.revision) {
      result.unchanged = true;
      return __receiver_snapshot_json(result);
    }
    const subscriptions = [];
    const activeKeys = __host_keys(records);
    let count = 0;
    for (let i = 0; i < activeKeys.length; i += 1) {
      const record = __receiver_value(records, activeKeys[i]);
      const ids = __host_keys(record.subscriptions);
      for (let j = 0; j < ids.length; j += 1) {
        const value = __host_create(null);
        value.observerId = record.id;
        value.subscriptionId = ids[j];
        value.pageId = record.identity.pageId;
        value.scopeId = record.identity.scopeId;
        value.ownerToken = record.identity.token;
        value.pageToken = record.pageIdentity.token;
        value.descriptor = __receiver_value(record.subscriptions, ids[j]).descriptor;
        put(subscriptions, __host_string(count++), value);
      }
    }
    result.subscriptions = subscriptions;
    return __receiver_snapshot_json(result);
  }
  function dispatch(batch) {
    if (retired || !__host_is_array(batch)) return false;
    for (let i = 0; i < batch.length; i += 1) {
      const notification = __receiver_value(batch, __host_string(i));
      const record = __receiver_value(records, __receiver_value(notification, 'observerId'));
      if (!record || !record.active) continue;
      if (!live(record)) { revoke(record); continue; }
      const subscription = __receiver_value(record.subscriptions, __receiver_value(notification, 'subscriptionId'));
      const matches = __receiver_value(__receiver_value(notification, 'value'), 'matches');
      if (!subscription || typeof matches !== 'boolean'
          || __receiver_value(notification, 'ownerToken') !== record.identity.token
          || __receiver_value(notification, 'pageToken') !== record.pageIdentity.token) continue;
      const event = {};
      put(event, 'matches', matches);
      try { runWithOwner(record.owner, function() { apply(subscription.callback, undefined, [event]); }); }
      catch (error) { try { reportError(error); } catch (_) {} }
    }
    return true;
  }
  __container_media_query_observer = create;
  put(wx, 'createMediaQueryObserver', create);
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
    dispatch: dispatch
  };
})();
