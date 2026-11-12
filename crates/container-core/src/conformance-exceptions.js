// Native-retained, feature-only exception interval. Public compatibility error
// arrays, JSON/toJSON, prototype replacement and wx listener policy own no cells.
const __container_conformance_exceptions = (function() {
  const create = Object.create, define = Object.defineProperty;
  const stringify = JSON.stringify, own = Object.getOwnPropertyDescriptor;
  const keys = Reflect.ownKeys, apply = Reflect.apply;
  const charCodeAt = String.prototype.charCodeAt, ErrorValue = Error;
  const safeInteger = Number.isSafeInteger;
  let phase = 'idle', sequence = 0, start = 0, retained = 0;
  let events = create(null), overflow = false, token;
  function require(ok, message) { if (!ok) throw new ErrorValue(message); }
  function put(object, key, value) { define(object, key, {__proto__:null,value,enumerable:true,writable:true,configurable:true}); }
  function field(object, key) { const d = own(object, key); return d && own(d, 'value') ? d.value : undefined; }
  function fields(request, names) {
    require(request && typeof request === 'object', 'exception request absent');
    const actual = keys(request); require(actual.length === names.length, 'exception request has extra fields');
    for (let at = 0; at < names.length; at++) require(own(request, names[at]) && own(own(request, names[at]), 'value'), 'exception request field absent');
  }
  function bytes(text) {
    let result = 0;
    for (let at = 0; at < text.length; at++) {
      const code = apply(charCodeAt, text, [at]);
      if (code < 128) result++;
      else if (code < 2048) result += 2;
      else if (code >= 0xd800 && code <= 0xdbff && at + 1 < text.length) {
        const next = apply(charCodeAt, text, [at + 1]);
        if (next >= 0xdc00 && next <= 0xdfff) { result += 4; at++; } else result += 3;
      } else result += 3;
      if (result > 65536) break;
    }
    return result;
  }
  function record(message) {
    if (phase !== 'active') return;
    if (!safeInteger(sequence + 1)) { overflow = true; return; }
    const cursor = sequence++;
    if (typeof message !== 'string' || retained >= 256 || bytes(message) > 65536) { overflow = true; return; }
    const event = create(null); put(event, 'cursor', cursor); put(event, 'message', message);
    put(events, retained++, event);
  }
  function capture(request) {
    const op = field(request, 'op');
    if (op === 'begin') {
      fields(request, ['op', 'maxEvents', 'maxMessageBytes']);
      require(phase === 'idle' && field(request, 'maxEvents') === 256 && field(request, 'maxMessageBytes') === 65536,
        'exception interval is duplicate, closed or exceeds fixed bounds');
      // One interval per native realm. Rust owns session/incarnation and source.
      phase = 'active'; token = 'realm-exceptions-1'; start = sequence;
      const output = create(null); put(output, 'kind', 'begun'); put(output, 'token', token); put(output, 'startCursor', start);
      return stringify(output);
    }
    fields(request, ['op', 'token', 'startCursor']);
    require(op === 'end' && phase === 'active' && field(request, 'token') === token && field(request, 'startCursor') === start,
      'exception interval owner/cursor is stale or absent');
    phase = 'closed';
    const output = create(null), list = []; put(list, 'toJSON', undefined);
    for (let at = 0; at < retained; at++) put(list, at, events[at]);
    put(output, 'kind', 'ended'); put(output, 'token', token); put(output, 'startCursor', start);
    put(output, 'endCursor', sequence); put(output, 'events', list); put(output, 'complete', !overflow); put(output, 'overflow', overflow);
    events = create(null);
    return stringify(output);
  }
  return {record, capture, active: function() { return phase === 'active'; }, invalidate: function() { if (phase === 'active') overflow = true; }};
})();
