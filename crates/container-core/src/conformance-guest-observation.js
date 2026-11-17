// Feature-only native transport, retained before application code executes.
// Page stack/route and owner deadlines belong to the Session adapter. Nothing
// here selects definitions, mutable public receiver tables or guest globals.
const __container_conformance_guest = (function() {
  const apply = Reflect.apply, stringify = JSON.stringify;
  const nativeThen = Promise.prototype.then, numberValue = Number.prototype.valueOf;
  const getOwn = Object.getOwnPropertyDescriptor, getPrototype = Object.getPrototypeOf;
  const ownKeys = Reflect.ownKeys, finite = Number.isFinite, is = Object.is;
  const weakGet = Function.prototype.call.bind(WeakMap.prototype.get);
  const indexOf = Function.prototype.call.bind(Array.prototype.indexOf);
  const invokeOwned = __container_turn_scheduler.invokeOwned;
  const TypeErrorValue = TypeError, ErrorValue = Error;
  const regexpTest=Function.prototype.call.bind(RegExp.prototype.test),dataPath=/^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const records = __host_create(null), invocations = __host_create(null);
  const maxInvocations = 1024, maxJsonUnits = 262144;
  let sequence = 0;
  function put(object, key, value) {
    __host_define(object, key, {__proto__:null,value:value,writable:true,enumerable:true,configurable:true});
  }
  function result(kind, ticket) {
    const output = __host_create(null); put(output, 'kind', kind);
    if (ticket !== undefined) put(output, 'ticket', ticket);
    return output;
  }
  function require(value, message) { if (!value) throw new ErrorValue(message); }
  function fields(request, expected) {
    require(request && typeof request === 'object', 'invalid conformance observation request');
    const actual = ownKeys(request);
    require(actual.length === expected.length, 'unreviewed conformance observation fields');
    for (let index = 0; index < actual.length; index++) {
      require(typeof actual[index] === 'string' && indexOf(expected, actual[index]) >= 0
        && getOwn(getOwn(request, actual[index]), 'value'), 'unreviewed conformance observation field');
    }
  }
  function string(value, label, limit) {
    require(typeof value === 'string' && value.length > 0 && value.length <= limit, 'invalid conformance ' + label);
    return value;
  }
  function page(binding) {
    fields(binding, ['pageId', 'token']);
    const id = string(__receiver_value(binding, 'pageId'), 'page id', 20);
    const token = string(__receiver_value(binding, 'token'), 'receiver token', 20);
    const entry = __receiver_value(__receiver_pages, id);
    return entry && !entry.retired && entry.pageId === id && entry.scopeId === null
      && entry.token === token && weakGet(__receiver_weak, entry.receiver) === entry ? entry : null;
  }
  function live(record) { return page(record.binding) === record.entry; }
  function strict(value) {
    const type = typeof value;
    if (value === undefined || type === 'function' || type === 'symbol' || type === 'bigint'
        || type === 'number' && (!finite(value) || is(value, -0))) {
      throw new TypeErrorValue('conformance result is outside the strict JSON projection');
    }
    if (value && type === 'object') {
      // JSON.stringify unboxes Number objects after its replacer. Validate
      // that otherwise-hidden numeric conversion before it can erase NaN/-0.
      let number, boxed = false;
      try { number = apply(numberValue, value, []); boxed = true; } catch (_) {}
      if (boxed && (!finite(number) || is(number, -0))) {
        throw new TypeErrorValue('boxed number is outside the strict JSON projection');
      }
    }
    return value;
  }
  function value(raw) {
    if (raw === undefined) return '{"kind":"undefined"}';
    const json = stringify(raw, function(_key, item) { return strict(item); });
    require(typeof json === 'string' && json.length <= maxJsonUnits, 'conformance result JSON budget exceeded');
    // Embed immutable JSON bytes. Parsing and stringifying them again could
    // call guest-modified Object/Array prototype toJSON a second time.
    return '{"kind":"json","value":' + json + '}';
  }
  function reason(raw) {
    if (raw === undefined) return result('undefined');
    const type = typeof raw;
    if (raw === null || type === 'boolean' || type === 'string'
        || type === 'number' && finite(raw) && !is(raw, -0)) {
      const output = result('json'); put(output, 'value', raw); return output;
    }
    // Keep the actual thrown value privately. Never inspect object/proxy
    // message/constructor/toJSON or claim full cross-provider error equality.
    const output = result('uninspectable'); put(output, 'valueType', type); return output;
  }
  function terminal(record, kind, raw) {
    if (record.phase !== 'pending' || !record.active) return;
    record.phase = 'serializing';
    if (!live(record)) {
      record.outcome = encode(result('revoked', record.ticket)); record.phase = 'terminal'; return;
    }
    let output;
    try {
      if (kind === 'fulfilled') {
        output = '{"kind":"fulfilled","ticket":' + stringify(record.ticket) + ',"value":' + value(raw) + '}';
      } else {
        record.thrown = raw;
        const thrown = result(kind, record.ticket); put(thrown, 'reason', reason(raw)); output = encode(thrown);
      }
    } catch (_) {
      const failed = result('serialization-failed', record.ticket);
      put(failed, 'code', 'ERR_CONFORMANCE_RESULT_SERIALIZATION'); output = encode(failed);
    }
    // A callback/toJSON may reenter host code and cancel/revoke delivery.
    // The first settlement reserves serialization; none may restore it.
    if (record.phase !== 'serializing' || !record.active) return;
    record.outcome = live(record) ? output : encode(result('revoked', record.ticket));
    record.phase = 'terminal';
  }
  function unsupported(record, code) {
    if (record.phase !== 'pending' || !record.active) return;
    record.phase = 'terminal';
    const output = result('unsupported', record.ticket); put(output, 'code', code); record.outcome = encode(output);
  }
  function thenDescriptor(raw) {
    let cursor = raw;
    for (let depth = 0; cursor && depth < 64; depth++) {
      const descriptor = getOwn(cursor, 'then');
      if (descriptor) return descriptor;
      cursor = getPrototype(cursor);
    }
    if (cursor) throw new TypeErrorValue('conformance then prototype budget exceeded');
    return null;
  }
  function settle(record, raw) {
    if (record.phase !== 'pending' || !record.active) return;
    if (!live(record)) { terminal(record, 'fulfilled', undefined); return; }
    if (raw && (typeof raw === 'object' || typeof raw === 'function')) {
      // Preserve the source helper's observable then lookup domain: a
      // custom/accessor then is not the captured native Promise operation.
      let descriptor;
      try { descriptor = thenDescriptor(raw); }
      catch (_) { unsupported(record, 'ERR_CONFORMANCE_THENABLE'); return; }
      if (descriptor && (!getOwn(descriptor, 'value')
          || typeof descriptor.value === 'function' && descriptor.value !== nativeThen)) {
        unsupported(record, 'ERR_CONFORMANCE_THENABLE'); return;
      }
      if (record.phase !== 'pending' || !record.active) return;
      if (!live(record)) { terminal(record, 'fulfilled', undefined); return; }
      try {
        apply(nativeThen, raw, [function(item) { terminal(record, 'fulfilled', item); },
          function(error) { terminal(record, 'rejected', error); }]);
        if (!descriptor || descriptor.value !== nativeThen) unsupported(record, 'ERR_CONFORMANCE_THENABLE');
        return;
      } catch (_) {
        // A true Promise may throw while reading constructor/species. It is
        // unsupported, never retried as a plain JSON value or invoked again.
        if (descriptor && descriptor.value === nativeThen) {
          unsupported(record, 'ERR_CONFORMANCE_THENABLE'); return;
        }
      }
    }
    terminal(record, 'fulfilled', raw);
  }
  function encode(output) {
    const json = stringify(output);
    require(typeof json === 'string' && json.length <= maxJsonUnits + 1024,
      'conformance observation JSON budget exceeded');
    return json;
  }
  function capture(request) {
    const op = __receiver_value(request, 'op');
    if (op === 'acquire') {
      fields(request, ['op', 'pageId']);
      const id = string(__receiver_value(request, 'pageId'), 'page id', 20);
      const entry = __receiver_value(__receiver_pages, id);
      require(entry && !entry.retired && entry.pageId === id && entry.scopeId === null
        && weakGet(__receiver_weak, entry.receiver) === entry, 'actual conformance page receiver unavailable');
      const output = result('acquired'), binding = __host_create(null);
      put(binding, 'pageId', id); put(binding, 'token', entry.token); put(output, 'binding', binding);
      return encode(output);
    }
    if (op === 'runtime-logs') {
      fields(request, ['op','reset']);
      const reset = __receiver_value(request,'reset');
      require(typeof reset === 'boolean','runtime log reset must be explicit');
      return __container_conformance_runtime_logs.snapshot(reset);
    }
    if (op === 'read-data') {
      fields(request,['op','binding','scopeId','path']);
      const binding=__receiver_value(request,'binding'), root=page(binding);
      require(root,'data read actual Page receiver is retired');
      const scope=__receiver_value(request,'scopeId'), path=__receiver_value(request,'path');
      require(typeof path==='string' && regexpTest(dataPath,path),'data read path is outside reviewed flat source contract');
      const entry=scope===null?root:__receiver_value(__receiver_scopes,scope);
      require(entry && !entry.retired && entry.pageId===root.pageId && (scope===null || entry.scopeId===scope && entry.pageToken===root.token)
        && weakGet(__receiver_weak,entry.receiver)===entry,'data read component receiver is retired or belongs to another Page');
      const data=getOwn(entry.receiver,'data');
      require(data && getOwn(data,'value'),'data receiver property must be actual own data');
      const selected=data.value == null ? undefined : getOwn(data.value,path);
      require(!selected || getOwn(selected,'value'),'data read accessor is outside reviewed source contract');
      const raw=selected?selected.value:undefined;
      // Existing strict value encoding retains undefined and JSON. Revalidate
      // after serialization because a guest serializer may retire its receiver.
      const encoded=value(raw);
      require(page(binding)===root && !entry.retired && weakGet(__receiver_weak,entry.receiver)===entry
        && (scope===null || __receiver_value(__receiver_scopes,scope)===entry),'data receiver changed during projection');
      return '{"kind":"data","receiverToken":'+stringify(entry.token)+',"value":'+encoded+'}';
    }
    if (op === 'begin') {
      fields(request, ['op', 'binding', 'invocationId', 'method', 'args']);
      const binding = __receiver_value(request, 'binding'), entry = page(binding);
      require(entry, 'conformance page receiver is retired or replaced');
      const invocation = string(__receiver_value(request, 'invocationId'), 'invocation owner', 128);
      const method = string(__receiver_value(request, 'method'), 'method name', 256);
      const args = __receiver_value(request, 'args');
      require(__host_is_array(args), 'conformance method arguments must be an array');
      require(__receiver_value(invocations, invocation) === undefined, 'conformance invocation owner was reused');
      require(sequence < maxInvocations, 'conformance invocation ledger exhausted');
      const ticket = __host_string(++sequence);
      const record = {__proto__:null,binding:binding,entry:entry,ticket:ticket,phase:'pending',active:true,outcome:null,thrown:undefined};
      // Reserve an irreversible owner/ticket before lookup, invocation or
      // Promise/serialization code. Every exit retains this invocation tombstone.
      put(invocations, invocation, ticket); put(records, ticket, record);
      try {
        const callback = entry.receiver[method];
        if (!live(record) || !record.active) {
          unsupported(record, 'ERR_CONFORMANCE_RECEIVER_REVOKED');
        } else if (typeof callback !== 'function') {
          unsupported(record, 'ERR_CONFORMANCE_METHOD_UNAVAILABLE');
        } else {
          const raw = invokeOwned(entry.receiver, callback, args);
          settle(record, raw);
        }
      } catch (error) { terminal(record, 'threw', error); }
      return encode(result('begun', ticket));
    }
    if (op === 'poll') {
      fields(request, ['op', 'binding', 'ticket']);
      const ticket = string(__receiver_value(request, 'ticket'), 'ticket', 20);
      const record = __receiver_value(records, ticket);
      require(record && record.active, 'conformance invocation ticket was consumed or revoked');
      const binding = __receiver_value(request, 'binding');
      fields(binding, ['pageId', 'token']);
      require(__receiver_value(binding, 'pageId') === record.binding.pageId
        && __receiver_value(binding, 'token') === record.binding.token, 'conformance invocation receiver differs');
      if (!live(record)) {
        record.active = false; record.outcome = null; record.thrown = undefined; record.phase = 'revoked';
        return encode(result('revoked', ticket));
      }
      if (record.phase === 'pending' || record.phase === 'serializing') return encode(result('pending', ticket));
      require(record.phase === 'terminal' && record.outcome, 'conformance invocation has no terminal observation');
      const output = record.outcome;
      record.active = false; record.outcome = null; record.thrown = undefined; record.phase = 'consumed';
      return output;
    }
    if (op === 'cancel') {
      fields(request, ['op', 'ticket']);
      const ticket = string(__receiver_value(request, 'ticket'), 'ticket', 20), record = __receiver_value(records, ticket);
      require(record && record.active, 'conformance invocation ticket was consumed or revoked');
      record.active = false; record.outcome = null; record.thrown = undefined; record.phase = 'cancelled';
      return encode(result('cancelled', ticket));
    }
    throw new ErrorValue('unsupported conformance observation operation');
  }
  return {capture:capture};
})();
