/** Optional passive exception interval over a real MiniProgram listener.
 * Provider return values, receiver, callback arguments and errors are preserved.
 * Observation failures surface at checkpoint/flush, never as an empty result. */
import { createOrderedStepsCollector } from './ordered-steps-collector-core.mjs'

const ensure = (ok, message) => { if (!ok) throw new Error(message) }
export const exceptionIdentity = descriptor => {
  const spec = descriptor.exceptionCapture
  ensure(spec?.event === 'exception' && spec.messageField === 'message' && /^[a-f0-9]{64}$/.test(spec.helperSha256)
    && ['subscribeCallsite', 'assertCallsite', 'closeCallsite'].every(key => typeof spec[key] === 'string' && spec[key].length > 0 && spec[key].length <= 256)
    && spec.interval === 'successful source on registration through successful source close'
    && spec.maxEvents === 256 && spec.maxMessageBytes === 65536, 'Source exception interval descriptor is unsupported')
  return { sourceSha256: descriptor.sourceSha256, event: spec.event, messageField: spec.messageField,
    subscribeCallsite: spec.subscribeCallsite, assertCallsite: spec.assertCallsite,
    closeCallsite: spec.closeCallsite, helperSha256: spec.helperSha256 }
}

export function createSourceExceptionCollector({ descriptor, emit, context }) {
  const identity = exceptionIdentity(descriptor), core = createOrderedStepsCollector({ descriptor, emit, context })
  const restores = [], navigationRestores = [], messages = [], auxiliaryJournal = []
  const auxiliarySpec = descriptor.exceptionCapture.auxiliaryListener
  ensure(auxiliarySpec && Object.keys(auxiliarySpec).sort().join(',') === 'helperSha256,registerCallsite,removeCallsite'
    && auxiliarySpec.helperSha256 === descriptor.sourceGuards?.['e2e/utils/automator.ts']
    && auxiliarySpec.registerCallsite === 'e2e/utils/automator.ts:548' && auxiliarySpec.removeCallsite === 'e2e/utils/automator.ts:558',
  'Source exception auxiliary listener lacks its fixed helper source identity')
  const requireAuxiliary = context !== undefined
  let owner, listener, wrappedListener, auxiliary, auxiliaryState, auxiliaryScope
  let registered = false, closing = false, ended = false, flushed = false, failure
  const caught = invoke => { try { return invoke() } catch (error) { failure ??= error } }
  const require = (ok, message) => ensure(ok, `${descriptor.caseId}: ${message}`)
  const healthy = () => { if (failure) throw failure }
  const installed = () => {
    require(owner && registered && typeof owner.rawListeners === 'function', 'actual exception subscription is absent')
    const actual = owner.rawListeners(identity.event)
    const expected = auxiliaryState === 'registered' ? [auxiliary, wrappedListener] : [wrappedListener]
    require(Array.isArray(actual) && actual.length === expected.length && actual.every((value, at) => value === expected[at]),
      'actual exception listener was removed, replaced or supplemented')
  }
  const wrap = (target, key, factory) => {
    const own = Object.getOwnPropertyDescriptor(target, key), original = target[key], wrapped = factory(original)
    Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapped })
    const restore = () => { if (target[key] === wrapped) { if (own) Object.defineProperty(target, key, own); else delete target[key] } }
    restores.push(restore)
    return restore
  }
  return {
    exceptionAuxiliary(observation, invoke) {
      let valid = false
      caught(() => {
        healthy()
        require(auxiliarySpec && typeof invoke === 'function' && !auxiliaryScope && !flushed && !ended
          && observation?.program === owner && observation.event === identity.event
          && typeof observation.listener === 'function' && observation.helperSha256 === auxiliarySpec.helperSha256,
        'auxiliary exception operation lacks its actual fixed helper/owner identity')
        const register = observation.phase === 'register'
        require(register ? !registered && auxiliaryState === undefined && !closing
          && observation.sourceCallsite === auxiliarySpec.registerCallsite
          : observation.phase === 'remove' && registered && closing && auxiliaryState === 'registered'
          && observation.listener === auxiliary && observation.sourceCallsite === auxiliarySpec.removeCallsite,
        'auxiliary exception operation crossed its fixed source lifecycle')
        valid = true
      })
      const scope = { observation, calls: 0, valid }
      auxiliaryScope = scope
      try {
        const result = invoke()
        caught(() => {
          require(valid && scope.calls === 1 && result === owner, 'auxiliary exception operation has no single successful actual mutation')
          auxiliaryJournal.push({ seq: auxiliaryJournal.length, phase: observation.phase, sourceCallsite: observation.sourceCallsite,
            helperSha256: observation.helperSha256, actualReceiver: true, actualCallbackIdentity: true, actualCalls: scope.calls,
            returnedOwner: true, state: auxiliaryState })
        })
        return result
      } finally { auxiliaryScope = undefined }
    },
    attach(program) {
      require(!flushed && (!owner || program === owner), 'exception interval changed actual MiniProgram owners')
      if (owner) return registered ? core.attach(program) : undefined
      require(['on', 'close', 'rawListeners'].every(key => typeof program?.[key] === 'function'), 'actual exception channel requires on, rawListeners and close')
      require(program.rawListeners(identity.event).length === 0, 'exception interval has unreviewed earlier listeners')
      owner = program
      wrap(program, 'on', original => function (...args) {
        if (args[0] !== identity.event) return Reflect.apply(original, this, args)
        const valid = this === owner && args.length === 2 && typeof args[1] === 'function' && !registered && !closing && !flushed
        caught(() => require(valid, 'exception listener registration is duplicate, stale or malformed'))
        if (!valid) return Reflect.apply(original, this, args)
        caught(() => {
          healthy()
          require(!requireAuxiliary || auxiliaryState === 'registered', 'official source exception subscription lacks its fixed helper auxiliary registration')
          const actual = owner.rawListeners(identity.event), expected = auxiliaryState === 'registered' ? [auxiliary] : []
          require(actual.length === expected.length && actual.every((value, at) => value === expected[at]),
            'source exception subscription has an unreviewed auxiliary baseline')
        })
        listener = args[1]
        wrappedListener = function (...events) {
          caught(() => {
            healthy(); installed()
            require(this === owner && !ended && !flushed && events.length === 1, 'exception callback crossed its actual owner interval')
            const field = events[0] && Object.getOwnPropertyDescriptor(events[0], identity.messageField)
            require(field && Object.hasOwn(field, 'value') && typeof field.value === 'string'
              && Buffer.byteLength(field.value) <= descriptor.exceptionCapture.maxMessageBytes
              && messages.length < descriptor.exceptionCapture.maxEvents, 'actual exception message is absent, accessor-based or exceeds bounds')
            const message = { seq: messages.length, message: field.value }
            messages.push(message)
            emit({ kind: 'event', op: 'exceptions.message', payload: { ...identity, ...message } })
          })
          return Reflect.apply(listener, this, events)
        }
        const result = Reflect.apply(original, this, [identity.event, wrappedListener])
        caught(() => {
          healthy()
          require(result === owner, 'actual exception registration returned another owner')
          registered = true; installed()
          // The helper finishes wrapping close/navigation and warming the
          // runtime before returning the owner to the unchanged source test.
          // Only that source registration begins the observed source plan.
          core.attach(program)
          for (const key of ['reLaunch', 'currentPage']) if (typeof program[key] === 'function') navigationRestores.push(wrap(program, key, original => function (...args) {
            caught(() => { healthy(); installed(); require(this === owner && !closing && !ended, 'navigation crossed the exception interval') })
            return Reflect.apply(original, this, args)
          }))
          wrap(program, 'close', original => async function (...args) {
            caught(() => { healthy(); installed(); require(this === owner && !closing && !ended && args.length === 0, 'source close is duplicate or belongs to another owner') })
            closing = true
            const result = await Reflect.apply(original, this, args)
            caught(() => {
              healthy(); installed()
              require(!requireAuxiliary || auxiliaryState === 'removed', 'official source close did not remove its actual helper auxiliary listener')
              for (const restore of navigationRestores) restore()
              core.flush()
              ended = true
              emit({ kind: 'lifecycle', op: 'exceptions.end', payload: { ...identity, count: messages.length } })
              require(messages.length === 0, 'original errors assertion observed actual exception messages')
            })
            return result
          })
          emit({ kind: 'lifecycle', op: 'exceptions.begin', payload: identity })
        })
        return result
      })
      for (const key of ['addListener', 'once', 'prependListener', 'prependOnceListener', 'off', 'removeListener', 'removeAllListeners']) {
        if (typeof program[key] !== 'function') continue
        wrap(program, key, original => function (...args) {
          if (args[0] === identity.event || key === 'removeAllListeners' && args.length === 0) {
            const scope = auxiliaryScope, register = scope?.observation?.phase === 'register'
            const expectedKey = register ? 'addListener' : 'removeListener'
            const allowed = scope?.valid && scope.calls === 0 && this === owner && key === expectedKey
              && args.length === 2 && args[1] === scope.observation.listener
            caught(() => require(allowed, 'actual exception subscription was changed during its source interval'))
            if (allowed) {
              scope.calls++
              const result = Reflect.apply(original, this, args)
              caught(() => {
                require(result === owner, 'actual auxiliary subscription returned another owner')
                if (register) { auxiliary = args[1]; auxiliaryState = 'registered' }
                else auxiliaryState = 'removed'
                const actual = owner.rawListeners(identity.event), expected = registered
                  ? (auxiliaryState === 'registered' ? [auxiliary, wrappedListener] : [wrappedListener]) : [auxiliary]
                require(actual.length === expected.length && actual.every((value, at) => value === expected[at]),
                  'actual auxiliary subscription result changed the fixed source baseline')
              })
              return result
            }
            // Preserve EventEmitter removal of the source callback after wrapping.
            if (['off', 'removeListener'].includes(key) && args[1] === listener) args[1] = wrappedListener
          }
          return Reflect.apply(original, this, args)
        })
      }
    },
    checkpoint(observation, checkpointContext) {
      healthy(); installed(); require(!closing && !ended && !flushed, 'checkpoint crossed its actual exception interval')
      return core.checkpoint(observation, checkpointContext)
    },
    diagnostics: () => ({ ...core.diagnostics(), exceptionCapture: { identity, registered, ended, messages: structuredClone(messages),
      auxiliaryJournal: structuredClone(auxiliaryJournal), auxiliaryState: auxiliaryState ?? 'absent', requireAuxiliary,
      failure: failure?.message ?? null } }),
    flush() {
      if (flushed) { healthy(); return }
      flushed = true
      caught(() => { healthy(); installed(); require(registered && ended, 'actual exception interval has no successful source registration and close') })
      for (const restore of navigationRestores) caught(restore)
      caught(() => core.flush())
      for (const restore of restores.reverse()) caught(restore)
      healthy()
    },
  }
}
