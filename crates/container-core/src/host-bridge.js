// Shared by both AppService engines. Only explicit bounded synchronous native
// services execute inside a JS turn; all asynchronous work uses the outbox.
(function() {
  const reportError = globalThis.__container_report_error;
  const bindFiniteNotifications = globalThis.__container_bind_finite_notifications;
  delete globalThis.__container_bind_finite_notifications;
  const finiteNativeCall = globalThis.__container_api_call;
  const finiteThen = Function.prototype.call.bind(Promise.prototype.then);
  const instrumentLogManager = globalThis.__container_log_manager_instrument;
  delete globalThis.__container_log_manager_instrument;
  if (typeof instrumentLogManager === "function") instrumentLogManager();
  function runtimeErrorApi(name) {
    return name === "wx.onError" || name === "wx.offError";
  }
  function retainedRuntimeApi(name) {
    return name === "wx.getLogManager" || name === "wx.onBeforeAppRoute" || name === "wx.offBeforeAppRoute"
      || name === "wx.onAppRoute" || name === "wx.offAppRoute" || name === "wx.rewriteRoute"
      || name === "wx.createBufferURL" || name === "wx.revokeBufferURL"
      || name === "wx.nextTick" || name === "wx.requestIdleCallback" || name === "wx.cancelIdleCallback";
  }
  function runtimePageNotFoundApi(name) {
    return name === "wx.onPageNotFound" || name === "wx.offPageNotFound";
  }
  function runtimeUnhandledRejectionApi(name) {
    return name === "wx.onUnhandledRejection" || name === "wx.offUnhandledRejection";
  }
  function runtimeWindowResizeApi(name) {
    return name === "wx.onWindowResize" || name === "wx.offWindowResize"
      || name === "wx.onHostLayoutChange" || name === "wx.offHostLayoutChange";
  }
  function runtimeLifecycleApi(name) {
    return name === "wx.onAppShow" || name === "wx.offAppShow"
      || name === "wx.onAppHide" || name === "wx.offAppHide"
      || name === "wx.onBeforePageUnload" || name === "wx.offBeforePageUnload"
      || name === "wx.onAfterPageUnload" || name === "wx.offAfterPageUnload";
  }
  const listeners = [];
  const nativeSubscriptions = Object.create(null);
  const installedApis = Object.create(null);
  const runtimeApis = Object.create(null);
  const objectApis = Object.create(null);
  const nativeObjects = Object.create(null);
  // Constructor state is synchronous even while the native factory is queued.
  // These are initial values, not permanent snapshots: replies/events replace them.
  const innerAudioDefaults = Object.freeze({ src: "", startTime: 0, autoplay: false,
    loop: false, volume: 1, playbackRate: 1, obeyMuteSwitch: true, paused: true,
    currentTime: 0, duration: 0, buffered: 0, referrerPolicy: "origin" });
  let nativeObjectId = 0;
  let nativeSubscriptionId = 0;
  let nativeSubscriptionCount = 0;
  const hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);
  // Native results are decoded after the final delivery claim. Guest changes
  // to convenience methods or constructors must not alter those trusted bytes.
  const nativeKeys = Object.keys;
  const nativeDefine = Object.defineProperty;
  const nativeIsArray = Array.isArray;
  const nativeIsInteger = Number.isInteger;
  const NativeArrayBuffer = ArrayBuffer;
  const NativeUint8Array = Uint8Array;
  const nativeCharCodeAt = Function.call.bind(String.prototype.charCodeAt);
  const nativeFromCharCode = String.fromCharCode;
  const nativeSetPrototype = Object.setPrototypeOf;
  const nativeCreate = Object.create;
  function syncFileTextInput(api, payload) {
    if (api !== "object:FileSystemManager.writeFileSync" && api !== "object:FileSystemManager.appendFileSync"
        && api !== "object:FileSystemManager.writeSync") return;
    const text = payload.data;
    if (typeof text !== "string") {
      if (!(text instanceof NativeArrayBuffer)) throw nativeError(api, "data must be a string or ArrayBuffer");
      return;
    }
    if (text.length > 2097152) throw nativeError(api, "file text code-unit budget exceeded");
    // JSON strings cannot preserve isolated UTF-16 surrogates at the Rust
    // boundary. Project code units before serialization; no text is repaired.
    const units = nativeSetPrototype([], null);
    for (let index = 0; index < text.length; index++) {
      units[index] = nativeCharCodeAt(text, index);
    }
    const marker = nativeCreate(null), data = nativeCreate(null);
    marker.type = "UTF16"; marker.units = units; data.__weappSyncText = marker;
    payload.data = data;
  }
  function syncFileTextResult(result) {
    if (!result || typeof result !== "object" || !hasOwn(result, "__weappSyncText")) return result;
    const marker = result.__weappSyncText;
    if (nativeKeys(result).length !== 1 || !marker || typeof marker !== "object"
        || nativeKeys(marker).length !== 2 || !hasOwn(marker, "type") || marker.type !== "UTF16"
        || !hasOwn(marker, "units") || !nativeIsArray(marker.units) || marker.units.length > 2097152) {
      throw new TypeError("invalid synchronous file text projection");
    }
    let text = "";
    for (let index = 0; index < marker.units.length; index++) {
      const unit = marker.units[index];
      if (!nativeIsInteger(unit) || unit < 0 || unit > 65535) throw new TypeError("invalid synchronous file UTF-16 code unit");
      text += nativeFromCharCode(unit);
    }
    return text;
  }
  // Virtual guest paths are runtime-owned; native roots never enter the realm.
  Object.defineProperty(wx, "env", {
    value: Object.freeze({ USER_DATA_PATH: "wxfile://user" }),
    enumerable: true, writable: false, configurable: false
  });
  function jsonValue(value) {
    const text = JSON.stringify(value, function(_, item) {
      if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint"
          || (typeof item === "number" && !Number.isFinite(item))) throw new TypeError("host payload must be a JSON value");
      return item;
    });
    if (typeof text !== "string") throw new TypeError("host payload must be a JSON value");
    if (text.length > 1048576) throw new RangeError("host payload exceeds byte limit");
    return JSON.parse(text);
  }
  function nativeError(name, message, code) {
    return { code: code || "ERR_INVALID_REQUEST", api: name, errMsg: name + ":fail " + message };
  }
  function reportNativeError(error) {
    try { reportError(error); }
    catch (_) { __container_errors.push({ name: "Error", message: "Native subscription callback failed" }); }
  }
  function invokeNative(name, options) {
    const callback = __container_options(options);
    if (!hasOwn(installedApis, name) || __container_capability(name) === "unsupported") {
      return __container_async_result(callback, null, nativeError(name, "unsupported", "ERR_UNSUPPORTED_CAPABILITY"));
    }
    try {
      const wire = encodeNative(callback);
      ["success", "fail", "complete"].forEach(function(key) { if (typeof callback[key] === "function") wire[key] = callback[key]; });
      const result = __container_api_call(name, wire);
      const pending = __container_api_pending[__container_api_id];
      const object = wire.objectId && nativeObjects[wire.objectId];
      if (pending && object && object.pageId !== undefined) {
        pending.nativePageId = object.pageId;
        pending.nativeScopeId = object.scopeId;
      }
      return result;
    } catch (error) { return __container_async_result(callback, null, nativeError(name, String(error.message || error))); }
  }
  function encodeNativeWire(value) {
    let bytes = 0;
    const result = JSON.stringify(value, function(key, item) {
      if (typeof ArrayBuffer !== "undefined" && (item instanceof ArrayBuffer || ArrayBuffer.isView && ArrayBuffer.isView(item))) {
        const data = item instanceof ArrayBuffer ? new Uint8Array(item) : new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
        bytes += data.byteLength;
        if (bytes > 1048576) throw new RangeError("native binary payload exceeds chunk budget");
        return { __weappBinary: { bytes: Array.prototype.slice.call(data), type: "ArrayBuffer" } };
      }
      if (typeof item === "bigint" || typeof item === "symbol" || typeof item === "number" && !Number.isFinite(item)) throw new TypeError("invalid native API value");
      return item;
    });
    if (result === undefined || result.length > 8388608) throw new RangeError("native API payload exceeds byte budget");
    return result;
  }
  function encodeNative(value) {
    return JSON.parse(encodeNativeWire(value));
  }
  function decodeNativeBytes(bytes, limit) {
    if (!nativeIsArray(bytes) || bytes.length > limit) throw new TypeError("invalid native binary value");
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (!nativeIsInteger(byte) || byte < 0 || byte > 255) throw new TypeError("invalid native binary value");
    }
    // Construct from an owned buffer, not an iterable array. Returning the
    // buffer directly also avoids the mutable TypedArray.prototype.buffer getter.
    const buffer = new NativeArrayBuffer(bytes.length);
    const view = new NativeUint8Array(buffer);
    for (let index = 0; index < bytes.length; index++) view[index] = bytes[index];
    return buffer;
  }
  function materializeStats(value) {
    if (!value || typeof value !== "object" || !(hasOwn(value, "__weappFsStats") && value.__weappFsStats === true)) return value;
    if (!hasOwn(value, "isDirectory") || !hasOwn(value, "isFile")) throw new TypeError("invalid native Stats value");
    const directory = value.isDirectory, file = value.isFile;
    if (typeof directory !== "boolean" || typeof file !== "boolean") throw new TypeError("invalid native Stats value");
    delete value.__weappFsStats;
    // These are owned writable data properties on the freshly decoded result.
    // Capture the metadata snapshot before it becomes mutable guest state.
    value.isDirectory = function() { return directory; };
    value.isFile = function() { return file; };
    return value;
  }
  function materializeStatResult(value) {
    if (!nativeIsArray(value)) return materializeStats(value);
    // The locked recursive shape is FileStats[]: each entry owns path + stats.
    for (let index = 0; index < value.length; index++) {
      const entry = value[index];
      if (entry && typeof entry === "object" && hasOwn(entry, "stats")) entry.stats = materializeStats(entry.stats);
    }
    return value;
  }
  function decodeNative(value, depth, httpBytes) {
    if (!value || typeof value !== "object") return value;
    if ((depth || 0) > 64) throw new RangeError("native value exceeds nesting budget");
    if (hasOwn(value, "__weappBinary")) {
      const marker = value.__weappBinary;
      if (nativeKeys(value).length !== 1 || !marker || !hasOwn(marker, "type") || marker.type !== "ArrayBuffer"
          || !hasOwn(marker, "bytes")) throw new TypeError("invalid native binary value");
      return decodeNativeBytes(marker.bytes, 1048576);
    }
    const result = nativeIsArray(value) ? [] : {};
    const keys = nativeKeys(value);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      // A response body can exceed a native-object chunk. Decode it directly
      // into its final buffer, without allocating a second large number array.
      const item = httpBytes && key === "data" ? decodeNativeBytes(value[key], 67108864)
        : decodeNative(value[key], (depth || 0) + 1);
      nativeDefine(result, key, { __proto__: null, value: item, enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  function nativeSnapshot(name) {
    if (!hasOwn(installedApis, name)) {
      throw nativeError(name, "snapshot unavailable", "ERR_UNSUPPORTED_CAPABILITY");
    }
    // The owner installs one complete snapshot at every trusted raw entry.
    // Reading a second registration cache here would bypass accepted window
    // observations and could revive a stale account during an owner rebuild.
    return __container_sync_api(name);
  }
  function onName(name, descriptor) {
    if (name === "weappContainer.identity.offChange") return "weappContainer.identity.onChange";
    if (descriptor && descriptor.counterpart && /(?:^|\.)off[A-Z]/.test(name)) return descriptor.counterpart;
    return name.replace(/(^|\.)off([A-Z])/, "$1on$2");
  }
  function isOff(name) { return /(?:^|\.)off[A-Z]/.test(name); }
  function removeNativeListeners(name, callback, objectId) {
    const descriptor = installedApis[name];
    const registration = onName(name, descriptor);
    Object.keys(nativeSubscriptions).forEach(function(id) {
      const record = nativeSubscriptions[id];
      if (record.name !== registration || record.objectId !== objectId || callback !== undefined && record.callback !== callback) return;
      // Revoke first, including events already queued before the host sees off.
      delete nativeSubscriptions[id];
      nativeSubscriptionCount--;
      const off = isOff(name) ? name : descriptor && descriptor.counterpart;
      if (off && hasOwn(installedApis, off)) {
        const payload = { subscriptionId: id, action: "unsubscribe" };
        if (objectId !== undefined) payload.objectId = objectId;
        invokeNative(off, payload).catch(reportNativeError);
      } else __container_events.push({ type: "host.unsubscribe", subscriptionId: id });
    });
  }
  function addNativeListener(name, callback, objectId) {
    if (typeof callback !== "function") throw new TypeError(name + " callback must be a function");
    if (!hasOwn(installedApis, name) || __container_capability(name) === "unsupported") {
      throw nativeError(name, "unsupported", "ERR_UNSUPPORTED_CAPABILITY");
    }
    const duplicate = Object.keys(nativeSubscriptions).some(function(id) {
      const record = nativeSubscriptions[id];
      return record.name === name && record.objectId === objectId && record.callback === callback;
    });
    if (duplicate) return;
    if (nativeSubscriptionCount >= 256) throw new RangeError("too many native subscriptions");
    const id = "native-subscription-" + (++nativeSubscriptionId);
    nativeSubscriptions[id] = { name: name, callback: callback, sequence: null, objectId: objectId };
    nativeSubscriptionCount++;
    const payload = { subscriptionId: id, action: "subscribe" };
    if (objectId !== undefined) payload.objectId = objectId;
    invokeNative(name, payload).catch(function(error) {
      if (hasOwn(nativeSubscriptions, id)) { delete nativeSubscriptions[id]; nativeSubscriptionCount--; }
      if (!error || error.code !== "ERR_CANCELLED") reportNativeError(error);
    });
  }
  function objectOptions(descriptor, args) {
    const componentFactory = /^(?:wx\.create(?:Camera|Video|LivePlayer|LivePusher|Map)Context)$/.test(descriptor.name || "");
    const componentIndex = (descriptor.parameters || []).indexOf("component");
    const component = componentFactory && componentIndex >= 0 ? args[componentIndex] : undefined;
    let componentScope;
    if (component !== undefined && component !== null) {
      componentScope = component.__container_scope_id;
      const page = componentScope == null && typeof __container_current_page_instances !== "undefined" && __container_current_page_instances.some(function(instance) { return instance === component; });
      if (typeof component !== "object" || component.__container_disposed || (!page && (typeof componentScope !== "string" || typeof __container_component_scopes === "undefined" || __container_component_scopes[componentScope] !== component))) throw nativeError(descriptor.name, "invalid component instance", "ERR_INVALID_REQUEST");
    }
    const first = componentFactory ? null : args[0];
    const options = first && typeof first === "object" && !Array.isArray(first) && !(first instanceof ArrayBuffer) && !(ArrayBuffer.isView && ArrayBuffer.isView(first)) ? Object.assign({}, first) : {};
    options.args = args.map(function(arg,index) { return typeof arg === "function" || (componentFactory && index === componentIndex) ? null : arg; });
    if (componentScope !== undefined) options.componentScopeId = componentScope;
    (descriptor.parameters || []).forEach(function(parameter, index) {
      if (args[index] !== undefined && typeof args[index] !== "function" && !/^(?:option|options|component|callback)$/.test(parameter)) options[parameter] = args[index];
    });
    return options;
  }
  function updateObject(record, result) {
    if (!result || typeof result !== "object") return;
    const properties = hasOwn(result, "properties") && result.properties || result;
    const keys = nativeKeys(properties);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      if (hasOwn(record.properties, key) && !hasOwn(record.localSnapshots, key)) {
        record.confirmed[key] = properties[key];
        if (!hasOwn(record.pendingProperties, key)) record.properties[key] = properties[key];
      }
    }
  }
  function objectSnapshot(type, key) {
    if (type === "InnerAudioContext" && hasOwn(innerAudioDefaults, key)) {
      return { value: innerAudioDefaults[key], fixed: false };
    }
    // NFC technology names are an installed-implementation enum. They must be
    // available in the factory's JS turn, before a native reader or UI exists.
    // An asynchronous factory response cannot expand the negotiated registry.
    if (type !== "NFCAdapter" || key !== "tech") return undefined;
    const tech = {};
    [["IsoDep", "isoDep", "ISO_DEP"], ["MifareClassic", "mifareClassic", "MIFARE_CLASSIC"],
      ["MifareUltralight", "mifareUltralight", "MIFARE_ULTRALIGHT"], ["Ndef", "ndef", "NDEF"],
      ["NfcA", "nfcA", "NFC_A"], ["NfcB", "nfcB", "NFC_B"], ["NfcF", "nfcF", "NFC_F"], ["NfcV", "nfcV", "NFC_V"]]
      .forEach(function(entry) {
        const api = "object:NFCAdapter.get" + entry[0];
        if (hasOwn(installedApis, api) && __container_capability(api) !== "unsupported") tech[entry[1]] = entry[2];
      });
    return { value: tech, fixed: true };
  }
  function objectAvailable(record, name) {
    if (record.error) throw record.error;
    if (record.closed) throw nativeError(name, "object retired", "ERR_CANCELLED");
  }
  function forgetObject(record) {
    record.closed = true;
    if (record.retireFiniteNotifications) record.retireFiniteNotifications();
    delete nativeObjects[record.id];
    Object.keys(nativeSubscriptions).forEach(function(id) {
      if (nativeSubscriptions[id].objectId === record.id) { delete nativeSubscriptions[id]; nativeSubscriptionCount--; }
    });
  }
  function createNativeObject(name, args, receiverId) {
    const descriptor = installedApis[name];
    if (!descriptor || __container_capability(name) === "unsupported") throw nativeError(name, "unsupported", "ERR_UNSUPPORTED_CAPABILITY");
    const id = "native-object-" + (++nativeObjectId);
    const options = objectOptions(descriptor, args);
    options.objectId = id;
    if (receiverId !== undefined) options.receiverId = receiverId;
    if (descriptor.kind === "task" && !options.cancelToken) options.cancelToken = "native-task-" + nativeObjectId;
    // This receiver owns private lifecycle hooks. An inherited setter must not
    // expose the record or intercept its retirement authority before binding.
    const record = nativeCreate(null);
    record.id = id; record.type = descriptor.objectType; record.closed = false; record.error = null;
    record.properties = nativeCreate(null); record.confirmed = nativeCreate(null);
    record.localSnapshots = nativeCreate(null); record.pendingProperties = nativeCreate(null); record.writeSequence = 0;
    const parent = receiverId && nativeObjects[receiverId];
    if (parent && parent.pageId !== undefined) { record.pageId = parent.pageId; record.scopeId = parent.scopeId; }
    else if (/^wx\.create(?:Camera|Video|LivePlayer|LivePusher|Map)Context$/.test(name)) {
      const pages = globalThis.__container_current_page_instances || [];
      const page = pages[pages.length - 1];
      if (page && page.__container_instance_id != null) record.pageId = String(page.__container_instance_id);
      record.scopeId = options.componentScopeId;
    }
    nativeObjects[id] = record;
    const promise = invokeNative(name, options);
    const object = descriptor.kind === "task" ? promise : {};
    record.value = object;
    Object.keys(objectApis).forEach(function(api) {
      const member = objectApis[api];
      if (member.receiver !== record.type) return;
      // These members are installed below by the private callback owner. Their
      // admission and lifetime cannot fall back to the generic listener map.
      if (finiteNotifications.owns(api)) return;
      const key = api.slice(api.lastIndexOf(".") + 1);
      if (member.property) {
        const available = hasOwn(installedApis, api) && __container_capability(api) !== "unsupported";
        if (available) {
          // Only negotiated properties may receive native snapshot updates.
          record.properties[key] = undefined;
          const snapshot = objectSnapshot(record.type, key);
          if (snapshot !== undefined) {
            if (snapshot.fixed) record.localSnapshots[key] = true;
            record.properties[key] = snapshot.value;
            record.confirmed[key] = snapshot.value;
          }
        }
        const property = { enumerable: true, get: function() { objectAvailable(record, api); return record.properties[key]; } };
        if (member.writable) property.set = function(value) {
          objectAvailable(record, api);
          if (!available) {
            invokeNative(api, { objectId: id, value: value, action: "set" }).catch(reportNativeError);
            return;
          }
          const revision = ++record.writeSequence;
          record.pendingProperties[key] = revision;
          record.properties[key] = value;
          invokeNative(api, { objectId: id, value: value, action: "set" }).then(function(result) {
            record.confirmed[key] = value;
            if (record.pendingProperties[key] === revision) {
              delete record.pendingProperties[key]; record.properties[key] = value;
            }
            updateObject(record, result);
          }).catch(function(error) {
            if (record.pendingProperties[key] === revision) {
              delete record.pendingProperties[key]; record.properties[key] = record.confirmed[key];
            }
            reportNativeError(error);
          });
        };
        Object.defineProperty(object, key, property);
      } else if (member.kind === "subscription") {
        object[key] = isOff(api) ? function(callback) { removeNativeListeners(api, callback, id); }
          : function(callback) { objectAvailable(record, api); addNativeListener(api, callback, id); };
      } else if (member.kind === "object" || member.kind === "task") {
        object[key] = function() { objectAvailable(record, api); return createNativeObject(api, Array.prototype.slice.call(arguments), id); };
      } else if (member.kind === "syncLocal") {
        object[key] = function() {
          objectAvailable(record, api);
          if (!hasOwn(installedApis, api) || __container_capability(api) === "unsupported" || typeof __container_host_sync_call !== "function") throw nativeError(api, "synchronous native operation is unavailable", "ERR_UNSUPPORTED_CAPABILITY");
          const payload = objectOptions(member, Array.prototype.slice.call(arguments)); payload.objectId = id;
          // Filesystem providers consume named fields. Keeping the original
          // options under args would encode each binary buffer twice and halve
          // the public one MiB chunk limit before entering the native owner.
          if (record.type === "FileSystemManager") {
            delete payload.args;
            syncFileTextInput(api, payload);
          }
          const readTarget = api === "object:FileSystemManager.readSync" ? payload.arrayBuffer : null;
          if (api === "object:FileSystemManager.readSync" && !(readTarget instanceof NativeArrayBuffer)) throw nativeError(api, "arrayBuffer must be an ArrayBuffer");
          const envelope = JSON.parse(__container_host_sync_call(api, encodeNativeWire(payload)));
          if (!envelope || envelope.ok !== true) throw envelope && envelope.error || nativeError(api, "invalid synchronous host result");
          const value = decodeApiResult(envelope.value, api);
          if (readTarget) {
            if (!value || !(value.arrayBuffer instanceof NativeArrayBuffer) || !nativeIsInteger(value.bytesRead) || value.bytesRead < 0) throw nativeError(api, "invalid native read result");
            const source = new NativeUint8Array(value.arrayBuffer), target = new NativeUint8Array(readTarget);
            if (source.length !== target.length || value.bytesRead > target.length) throw nativeError(api, "invalid native read result bounds");
            for (let index = 0; index < source.length; index++) target[index] = source[index];
            value.arrayBuffer = readTarget;
          }
          return value === null ? undefined : value;
        };
      } else {
        object[key] = function() {
          try {
            objectAvailable(record, api);
            const payload = objectOptions(member, Array.prototype.slice.call(arguments)); payload.objectId = id;
            const result = invokeNative(api, payload);
            if (key === "destroy" || key === "terminate") {
              record.closed = true;
              // InnerAudio's existing destroy facade makes this receiver
              // unusable in the calling turn, including a later host failure.
              // Revoke listeners at that same boundary and retain their real
              // creator cancellations for Session reconciliation. This is not
              // a Promise settlement hook and does not cancel the factory or
              // stop an independent shared producer.
              if (record.type === "InnerAudioContext" && record.retireFiniteNotifications) record.retireFiniteNotifications();
            }
            finiteThen(result, function(value) {
              // UDP close destroys its native socket. TCP close only closes a
              // connection and must preserve the socket object's own lifetime.
              if (key === "destroy" || key === "terminate" || api === "object:UDPSocket.close") forgetObject(record);
              updateObject(record, value);
            }, function() {});
            return result;
          } catch (error) { return Promise.reject(error); }
        };
      }
    });
    record.retireFiniteNotifications = finiteNotifications.attachObject(id, record.type, object,
      function(api) { objectAvailable(record, api); },
      function() { record.closed = true; delete nativeObjects[id]; });
    if (/^(?:RequestTask|DownloadTask|UploadTask)$/.test(record.type)) {
      let completed = false;
      object.abort = function() {
        if (completed) return;
        completed = true;
        __container_events.push({ type: "api.cancel", name: name, cancelToken: options.cancelToken });
      };
      finiteThen(promise, function() { completed = true; forgetObject(record); }, function() { completed = true; forgetObject(record); });
    }
    finiteThen(promise, function(result) { updateObject(record, result); }, function(error) { record.error = error; forgetObject(record); if (descriptor.kind !== "task") reportNativeError(error); });
    return object;
  }
  function sequence(value) {
    if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    return typeof value === "string" && /^[1-9][0-9]*$/.test(value) && value.length <= 20 ? value : null;
  }
  // Only primitive native subscription requests leave the private callback
  // owner. The one-use binder is captured/deleted before application code.
  const finiteNotifications = bindFiniteNotifications(function(name, id, failed, objectId) {
    if (!hasOwn(installedApis, name)) return false;
    const payload = { subscriptionId: id, action: "subscribe" };
    if (objectId !== undefined) payload.objectId = objectId;
    finiteThen(finiteNativeCall(name, payload), undefined, failed);
    return true;
  }, decodeNative, function(objectId, value) {
    const object = nativeObjects[objectId];
    if (object) updateObject(object, value);
  });
  globalThis.__container_receive_native_event = function(event) {
    const record = event && nativeSubscriptions[event.subscriptionId];
    const next = event && sequence(event.sequence);
    if (!record || !next || record.sequence !== null &&
      (next.length < record.sequence.length || next.length === record.sequence.length && next <= record.sequence)) return false;
    // Capture the sequence before invoking guest code, including reentrant off.
    record.sequence = next;
    const value = decodeNative(event.value);
    if (record.objectId && nativeObjects[record.objectId]) updateObject(nativeObjects[record.objectId], value);
    __container_invoke_api_callback({ event: record.callback }, "event", value);
    return true;
  };
  globalThis.__container_install_host_services = function(config) {
    if (!config || !Array.isArray(config.apis)) throw new TypeError("invalid host services configuration");
    const validated = config.apis.map(function(descriptor) {
      if (!descriptor || typeof descriptor.name !== "string" || typeof descriptor.kind !== "string") {
        throw new TypeError("invalid native API descriptor");
      }
      return jsonValue(descriptor);
    });
    (config.objectApis || []).forEach(function(descriptor) { objectApis[descriptor.name] = descriptor; });
    // Resolve runtime ownership before mutating the registry, including a
    // counterpart descriptor which appears later in this validated batch.
    validated.forEach(function(descriptor) {
      if (descriptor.owner === "runtime" && /^wx\.[A-Za-z_$][A-Za-z0-9_$]*$/.test(descriptor.name)
          && descriptor.name !== "wx.getAccountInfoSync") runtimeApis[descriptor.name] = true;
    });
    validated.forEach(function(descriptor) {
      const name = descriptor.name;
      // The error pair remains protected against stale host descriptors; the
      // generic runtime map also protects runtime descriptors from this batch.
      if (runtimeErrorApi(name) || retainedRuntimeApi(name) || runtimePageNotFoundApi(name) || runtimeUnhandledRejectionApi(name) || runtimeWindowResizeApi(name) || runtimeLifecycleApi(name)) return;
      if (hasOwn(runtimeApis, name)) return;
      if (finiteNotifications.owns(name)) {
        if (!isOff(name) && descriptor.kind === "subscription") {
          installedApis[name] = descriptor;
          finiteNotifications.activate(name);
        }
        return;
      }
      installedApis[name] = descriptor;
      if (!/^wx\.[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return;
      const key = name.slice(3);
      if (descriptor.kind === "subscription") {
        wx[key] = isOff(name) ? function(callback) { removeNativeListeners(name, callback); }
          : function(callback) { addNativeListener(name, callback); };
        if (!isOff(name) && descriptor.counterpart && !runtimeErrorApi(descriptor.counterpart)
            && !retainedRuntimeApi(descriptor.counterpart) && !runtimePageNotFoundApi(descriptor.counterpart)
            && !runtimeUnhandledRejectionApi(descriptor.counterpart)
            && !runtimeWindowResizeApi(descriptor.counterpart)
            && !runtimeLifecycleApi(descriptor.counterpart)
            && !finiteNotifications.owns(descriptor.counterpart)
            && !hasOwn(runtimeApis, descriptor.counterpart)
            && /^wx\.[A-Za-z_$][A-Za-z0-9_$]*$/.test(descriptor.counterpart)
            && !hasOwn(installedApis, descriptor.counterpart)) {
          wx[descriptor.counterpart.slice(3)] = function(callback) { removeNativeListeners(descriptor.counterpart, callback); };
        }
      } else if (descriptor.kind === "syncSnapshot") {
        wx[key] = function() { return nativeSnapshot(name); };
      } else if (descriptor.kind === "object" || descriptor.kind === "task") {
        wx[key] = function() { return createNativeObject(name, Array.prototype.slice.call(arguments)); };
      } else if (descriptor.kind === "async" && typeof wx[key] !== "function") {
        // Existing specialized facades retain their argument, callback and task
        // contracts; the runtime delegates their ordinary api.call operations.
        wx[key] = function(options) { return invokeNative(name, options); };
      }
    });
    const canIUse = typeof instrumentLogManager === "function" ? instrumentLogManager("canIUse") : wx.canIUse;
    wx.canIUse = function(name) {
      const value = String(name);
      if (hasOwn(objectApis, "object:" + value)) return __container_capability("object:" + value) !== "unsupported";
      if (hasOwn(installedApis, "component:" + value)) return __container_capability("component:" + value) !== "unsupported";
      return canIUse(value);
    };
    if (typeof instrumentLogManager === "function") instrumentLogManager();
    return true;
  };
  const identity = Object.freeze({
    getState: function() { return nativeSnapshot("weappContainer.identity.getState"); },
    onChange: function(callback) { addNativeListener("weappContainer.identity.onChange", callback); },
    offChange: function(callback) { removeNativeListeners("weappContainer.identity.offChange", callback); },
    logout: function(options) { return invokeNative("weappContainer.identity.logout", options); }
  });
  const payment = Object.freeze({
    request: function(options) { return invokeNative("weappContainer.payment.request", options); }
  });
  globalThis.weappContainer = Object.freeze({
    identity: identity,
    payment: payment,
    invoke: function(method, payload, options) {
      if (typeof method !== "string" || !method.trim() || method.length > 128) return Promise.reject(new TypeError("host method must be a nonempty string"));
      try {
        const request = { method: method, payload: jsonValue(payload === undefined ? null : payload) };
        if (options && options.timeout !== undefined) request.timeout = options.timeout;
        if (options && options.cancelToken !== undefined) request.cancelToken = options.cancelToken;
        return __container_api_call("weappContainer.invoke", request);
      } catch (error) { return Promise.reject(error); }
    },
    postMessage: function(payload) {
      __container_events.push({ type: "host.message", payload: jsonValue(payload) });
    },
    onMessage: function(listener) {
      if (typeof listener !== "function") throw new TypeError("message listener must be a function");
      if (listeners.indexOf(listener) < 0) {
        if (listeners.length >= 256) throw new RangeError("too many host message listeners");
        listeners.push(listener);
      }
    },
    offMessage: function(listener) {
      if (listener === undefined) listeners.splice(0, listeners.length);
      else { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); }
    }
  });
  globalThis.__container_receive_host_message = function(payload) {
    listeners.slice().forEach(function(listener) {
      __container_invoke_api_callback({message: listener}, "message", jsonValue(payload));
    });
    return true;
  };
  globalThis.__container_clear_host_listeners = function() {
    listeners.splice(0, listeners.length);
    Object.keys(nativeSubscriptions).forEach(function(id) { delete nativeSubscriptions[id]; });
    nativeSubscriptionCount = 0;
    Object.keys(nativeObjects).forEach(function(id) { nativeObjects[id].closed = true; delete nativeObjects[id]; });
    return true;
  };
  function retireNativeOwner(pageId, scopes) {
    const owns = function(page, scope) { return String(page) === String(pageId) && (!scopes || scopes.indexOf(scope) >= 0); };
    Object.keys(nativeObjects).forEach(function(id) {
      const record = nativeObjects[id];
      if (record.pageId !== undefined && owns(record.pageId, record.scopeId)) forgetObject(record);
    });
    Object.keys(__container_api_pending).forEach(function(id) {
      const pending = __container_api_pending[id];
      if (pending && pending.nativePageId !== undefined && owns(pending.nativePageId, pending.nativeScopeId)) delete __container_api_pending[id];
    });
  }
  // Delete continuations while the existing lifecycle call is executing;
  // neither retirement nor a later OS completion invokes retired callbacks.
  const invokePage = globalThis.__container_invoke_page_instance;
  globalThis.__container_invoke_page_instance = function(id, index, name, args) {
    try { return invokePage(id, index, name, args); }
    finally { if (name === "onUnload") retireNativeOwner(id); }
  };
  const reconcileComponents = globalThis.__container_reconcile_components;
  globalThis.__container_reconcile_components = function(batch) {
    try { return reconcileComponents(batch); }
    finally {
      if (batch && batch.phase === "dispose") {
        const scopes = (batch.remove || []).concat((batch.instances || []).map(function(instance) { return instance.scopeId; }));
        retireNativeOwner(batch.pageId, scopes);
      }
    }
  };
  // The wire uses bytes for HTTP bodies; only the wx.request facade converts
  // them to ArrayBuffer. Business-method JSON objects are never reinterpreted.
  const resolveApi = globalThis.__container_resolve_api;
  function decodeApiResult(result, name) {
    const httpBytes = name === "wx.request" && result && typeof result === "object"
      && hasOwn(result, "dataEncoding") && result.dataEncoding === "bytes";
    if (httpBytes && !hasOwn(result, "data")) throw new TypeError("invalid native HTTP body");
    result = decodeNative(result, 0, httpBytes);
    if (httpBytes) delete result.dataEncoding;
    if (name === "object:FileSystemManager.readFileSync") return syncFileTextResult(result);
    // The asynchronous managed-file owner uses the same UTF-16 projection as
    // the synchronous provider. Decode it only at the guest-facing result
    // boundary; the native host wire must retain code units so lone surrogates
    // survive the Rust/JSON hop without replacement.
    if (name === "object:FileSystemManager.readFile" && result && typeof result === "object"
        && hasOwn(result, "data")) result.data = syncFileTextResult(result.data);
    // Only the four locked filesystem producers carry Stats. Unrelated native
    // API data and extra result fields keep their ordinary JSON meaning.
    if (name === "object:FileSystemManager.statSync") return materializeStatResult(result);
    if (name === "object:FileSystemManager.fstatSync") return materializeStats(result);
    if (result && typeof result === "object" && hasOwn(result, "stats")) {
      if (name === "object:FileSystemManager.stat") result.stats = materializeStatResult(result.stats);
      else if (name === "object:FileSystemManager.fstat") result.stats = materializeStats(result.stats);
    }
    return result;
  }
  globalThis.__container_resolve_api = function(id, result, error, deliveryTicket) {
    if (deliveryTicket !== undefined) {
      // No decoding or sensitive payload enters JS before native authority
      // claims the ticket inside the base resolver's actual microtask.
      return resolveApi(id, null, null, deliveryTicket, decodeApiResult);
    }
    const pending = __container_api_pending[Number(id)];
    if (!error) {
      try { result = decodeApiResult(result, pending && pending.name); }
      catch (_) { return resolveApi(id, null, nativeError(pending && pending.name || "native API", "invalid native result", "ERR_INVALID_RESPONSE")); }
    }
    return resolveApi(id, result, error);
  };
})();
