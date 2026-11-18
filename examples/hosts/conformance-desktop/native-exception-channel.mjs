/** Optional native protocol: startup must advertise the compiled channel.
 * A complete bounded channel proof is mandatory even when no errors occurred. */
import { EventEmitter } from 'node:events'
import { isDeepStrictEqual } from 'node:util'
import { exceptionIdentity } from '../../../conformance/recipes/source-exception-capture.mjs'
const require = (ok, message) => { if (!ok) throw new Error(message) }
const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : ''
const canonical = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !value.includes('\0')
const cursor = value => Number.isSafeInteger(value) && value >= 0

export function withNativeExceptionChannel(program, { request, descriptor, startup, signal }) {
  const identity = exceptionIdentity(descriptor)
  require(['quickjs', 'v8'].includes(startup?.engine) && canonical(startup?.sessionId) && canonical(startup?.exceptionIncarnation)
    && Array.isArray(startup.capabilities) && startup.capabilities.includes('bounded-session-exceptions-v1'),
  'Native1182 exception capture unavailable: startup lacks bounded-session-exceptions-v1; no empty errors result is admissible')
  const owner = { engine: startup.engine, sessionId: startup.sessionId, incarnation: startup.exceptionIncarnation, source: identity }
  EventEmitter.call(program)
  const facts = []
  let begin, ended = false, pending = false
  const send = async (op, payload) => {
    if (signal?.aborted) throw signal.reason ?? new Error('Native exception capture aborted')
    const result = await request(op, payload)
    if (signal?.aborted) throw signal.reason ?? new Error('Native exception capture aborted')
    return result
  }
  for (const name of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener', 'off', 'removeListener', 'removeAllListeners', 'rawListeners']) {
    Object.defineProperty(program, name, { configurable: true, writable: true, value: EventEmitter.prototype[name] })
  }
  program.beginExceptions = async () => {
    require(!pending && !begin && !ended, 'Native exception channel begin is duplicate')
    pending = true
    try {
      const value = await send('exceptions.begin', { owner, maxEvents: descriptor.exceptionCapture.maxEvents, maxMessageBytes: descriptor.exceptionCapture.maxMessageBytes })
      require(keys(value) === 'kind,owner,startCursor,token' && value.kind === 'native-exception-channel-begin-v1'
        && isDeepStrictEqual(value.owner, owner) && canonical(value.token) && cursor(value.startCursor),
      'Native exception channel has no actual same-source/session begin cursor')
      begin = structuredClone(value); facts.push(structuredClone(value))
      return value
    } finally { pending = false }
  }
  program.close = async () => {
    require(begin && !pending && !ended, 'Native exception channel end is missing or duplicate')
    pending = true
    try {
      const value = await send('exceptions.end', { owner, token: begin.token, startCursor: begin.startCursor })
      require(keys(value) === 'complete,endCursor,events,kind,overflow,owner,startCursor,token'
        && value.kind === 'native-exception-channel-end-v1' && isDeepStrictEqual(value.owner, owner) && value.token === begin.token
        && value.startCursor === begin.startCursor && cursor(value.endCursor) && value.complete === true && value.overflow === false
        && Array.isArray(value.events) && value.events.length <= descriptor.exceptionCapture.maxEvents
        && value.endCursor === value.startCursor + value.events.length,
      'Native exception channel lacks a complete same-owner bounded end watermark')
      for (const [at, event] of value.events.entries()) require(keys(event) === 'cursor,message'
        && event.cursor === begin.startCursor + at && typeof event.message === 'string'
        && Buffer.byteLength(event.message) <= descriptor.exceptionCapture.maxMessageBytes,
      'Native exception events are missing, reordered, duplicated or outside message bounds')
      facts.push(structuredClone(value))
      for (const event of value.events) Reflect.apply(EventEmitter.prototype.emit, program, ['exception', { message: event.message }])
      ended = true
    } finally { pending = false }
  }
  program.exceptionFacts = () => structuredClone(facts)
  return program
}
