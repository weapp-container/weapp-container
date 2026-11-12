/** Isolated pure-observation primitive. The consumer preload must own the
 * eventual sink, archive payload bytes, and reject incomplete observations.
 * This module alone grants no generated-module admission. */
import { AsyncLocalStorage } from 'node:async_hooks'

export function createObserver({ onEvent, onFailure = () => {} }) {
  const contexts = new AsyncLocalStorage()
  const live = new Map()
  const ownerIds = new WeakMap()
  let nextOwnerId = 0
  let sequence = 0
  const emit = (kind, data) => {
    try { onEvent({ sequence: ++sequence, kind, span: contexts.getStore() ?? null, data }) }
    catch (error) { try { onFailure(error) } catch {} }
  }
  const record = (kind, data) => { emit(kind, data) }
  // Object identity comes from the captured compiler context itself. Neither a
  // path nor equal serialized configuration can acquire another owner's ID.
  const identity = owner => {
    if (!owner || !['object', 'function'].includes(typeof owner)) {
      try { onFailure(new Error('Compiler source-transform owner is not an actual object')) } catch {}
      return null
    }
    if (!ownerIds.has(owner)) ownerIds.set(owner, ++nextOwnerId)
    return ownerIds.get(owner)
  }
  const value = (kind, result, fields, metadata) => {
    try {
      const data = fields ? Object.fromEntries(fields.map(key => [key, result?.[key]])) : result
      emit(kind, metadata ? { ...data, ...metadata } : data)
    } catch (error) { try { onFailure(error) } catch {} }
    return result
  }
  const span = async (kind, input, operation) => {
    const parent = contexts.getStore() ?? null
    const context = Object.freeze({ id: ++sequence, parentId: parent?.id ?? null, kind })
    live.set(context.id, context)
    return contexts.run(context, async () => {
      emit('span-start', { kind, input })
      try {
        const result = await operation()
        emit('span-end', { kind, outcome: 'returned' })
        return result
      } catch (error) {
        emit('span-end', { kind, outcome: 'threw', errorType: typeof error })
        throw error
      } finally { live.delete(context.id) }
    })
  }
  const spanSync = (kind, input, operation) => {
    const parent = contexts.getStore() ?? null
    const context = Object.freeze({ id: ++sequence, parentId: parent?.id ?? null, kind })
    live.set(context.id, context)
    return contexts.run(context, () => {
      emit('span-start', { kind, input })
      try {
        const result = operation()
        emit('span-end', { kind, outcome: 'returned' })
        return result
      } catch (error) {
        emit('span-end', { kind, outcome: 'threw', errorType: typeof error })
        throw error
      } finally { live.delete(context.id) }
    })
  }
  const at = (context, operation) => {
    if (!context || live.get(context.id) !== context) {
      try { onFailure(new Error('Compiler observer context is not an active captured span')) } catch {}
      return
    }
    return contexts.run(context, operation)
  }
  const recordAt = (context, kind, data) => { at(context, () => record(kind, data)) }
  const valueAt = (context, kind, result, fields, metadata) => { at(context, () => value(kind, result, fields, metadata)); return result }
  return Object.freeze({ record, value, span, spanSync, recordAt, valueAt, identity, context: () => contexts.getStore() ?? null })
}

let installed
export function installObserverSink(onEvent, onFailure, { active = true } = {}) {
  if (installed) throw new Error('Compiler observer sink is already installed')
  if (typeof onEvent !== 'function' || typeof onFailure !== 'function') throw new Error('Compiler observer requires event and irreversible failure sinks')
  if (typeof active !== 'boolean') throw new Error('Compiler observer activity must be explicit')
  installed = { onEvent, onFailure, active }
}
// Synchronous initialization is required before any patched compiler member is
// imported. An absent sink is an instrumentation setup error, never success.
const singleton = createObserver({
  onEvent(event) {
    if (!installed) throw new Error('Compiler observer sink was not installed')
    installed.onEvent(event)
  },
  onFailure(error) {
    if (!installed) throw error
    installed.onFailure(error)
  },
})
export const observer = Object.freeze(Object.fromEntries(Object.entries(singleton).map(([key, method]) => [key, (...args) => {
  if (!installed) throw new Error('Compiler observer sink was not installed')
  // The inherited loader still witnesses every module in workers, bridges and
  // dev companions. Their compiler calls are outside this static observation
  // operation: keep the original call/result and create no causal context.
  if (!installed.active) {
    if (key === 'span' || key === 'spanSync') {
      // These are the fixed manifest's two actual module-execution spans:
      // bundled ESM/default require, and the custom CJS _compile callback.
      // The latter bypasses Node's load hook. Outside the static operation
      // neither has an admission proof; preserve execution and fail closed.
      if (['loadFromBundledFile', 'cjs-compile-loader'].includes(args[0])) {
        try { installed.onFailure(new Error(`Compiler generated-code boundary ${args[0]} is outside the static observation operation`)) } catch {}
      }
      return args[2]()
    }
    if (key === 'value') return args[1]
    if (key === 'valueAt') return args[2]
    if (key === 'context') return null
    return undefined
  }
  return method(...args)
}])))
export const currentObserverContext = () => installed?.active === false ? null : singleton.context()
