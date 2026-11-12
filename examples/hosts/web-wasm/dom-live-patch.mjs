/** Opt-in v2 live DOM coordination. This module grants no runtime editing or
 * application authority. Plans come from prepareDomDocument; the caller owns
 * negotiation, exact permits/finals, resource readiness, and geometry epochs.
 */
import { DomViewError, validateDomPresentationKey, validateDomViewDocument } from './dom-presenter.mjs'

export const DOM_LIVE_PATCH_CONTRACT = Object.freeze({ version: '2.0', stableDocument: true,
  typedPatch: true, runtimeContinuity: true, exactPermit: true, finalAck: true })
const entries = new WeakMap(), surfaces = new WeakMap()
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const attr = (node, name) => Object.hasOwn(node.typedAttrs ?? {}, name) ? node.typedAttrs[name] : node.attrs?.[name]
const truth = value => value !== undefined && value !== null && value !== false && value !== 0 && value !== 'false'
const scalar = value => value == null ? '' : String(value)
const failure = (code, message) => new DomViewError(code, message)
const invalid = message => { throw failure('ERR_PROTOCOL_VERSION', message) }
const cancelled = message => { throw failure('ERR_CANCELLED', message) }
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }
const copy = value => JSON.parse(JSON.stringify(value))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const byteLength = value => new TextEncoder().encode(value).byteLength
const connected = node => node?.isConnected === true

function exactContract(contract) {
  const keys = Object.keys(DOM_LIVE_PATCH_CONTRACT)
  if (!record(contract) || Object.keys(contract).length !== keys.length
    || keys.some(key => contract[key] !== DOM_LIVE_PATCH_CONTRACT[key])) invalid('live DOM requires the explicit complete v2 contract')
}
function limit(value, fallback, maximum, name) {
  value ??= fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid(`invalid live DOM ${name} budget`)
  return value
}
function synchronous(predicate, context, name) {
  const result = predicate(context)
  if (result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {})
    invalid(`${name} must return a synchronous boolean`)
  }
  if (typeof result !== 'boolean') invalid(`${name} must return a synchronous boolean`)
  return result
}
function desiredAttributes(node) {
  const output = { 'data-wc-id': node.occurrenceId, 'data-wc-tag': node.tag, 'data-wc-owner': node.scopeToken }
  for (const name of ['id', 'class', 'role', 'tabindex', 'aria-label']) if (attr(node, name) != null) output[name] = scalar(attr(node, name))
  for (const name of Object.keys({ ...node.attrs, ...node.typedAttrs })) if (/^(?:data-|aria-)/.test(name)) {
    const value = attr(node, name)
    if (value != null) output[name] = typeof value === 'object' ? JSON.stringify(value) : scalar(value)
  }
  // Native value/defaultValue writes can mutate editing even without a .value
  // setter. Controls are projected through explicit property operations only.
  if (!node.textControl) Object.assign(output, node.domAttributes)
  if (truth(attr(node, 'hidden'))) output.hidden = ''
  if (node.tag === 'image') { output.alt = scalar(attr(node, 'alt')); if (node.imageUrl) output.src = node.imageUrl }
  if (node.textControl) output['aria-disabled'] = String(node.textControl.disabled)
  if (node.button) {
    if (attr(node, 'type') != null) output['data-wc-button-source-type'] = scalar(attr(node, 'type'))
    for (const name of ['type', 'size', 'plain', 'loading']) output[`data-wc-button-${name}`] = String(node.button[name])
    output['aria-disabled'] = String(node.button.disabled); output['aria-busy'] = String(node.button.loading)
  }
  return output
}
function desiredStyle(node) {
  let css = node.inlineStyle
  const append = (name, value) => { css += `${css && !css.endsWith(';') ? ';' : ''}${name}:${value};` }
  if (node.tag === 'text') append('user-select', truth(attr(node, 'selectable')) ? 'text' : 'none')
  if (node.tag === 'image') append('object-fit', { scaleToFill: 'fill', aspectFit: 'contain', aspectFill: 'cover' }[node.imageMode])
  if (node.tag === 'scroll-view') { append('overflow-x', truth(attr(node, 'scroll-x')) ? 'auto' : 'hidden'); append('overflow-y', truth(attr(node, 'scroll-y')) ? 'auto' : 'hidden') }
  return css
}
function stage(plan, runtimeIdentities, budget) {
  if (!record(plan) || !record(plan.document) || !Array.isArray(plan.nodes) || typeof plan.css !== 'string'
    || typeof plan.dispose !== 'function' || !record(plan.viewport)) invalid('live DOM needs a prepared DOM plan')
  validateDomViewDocument(plan.document)
  if (!(runtimeIdentities instanceof Map)) invalid('live DOM requires runtime identities for every occurrence')
  const records = new Map(), order = [], roots = [], stack = [...plan.nodes].reverse().map(node => [node, null])
  let bytes = byteLength(plan.css), operationCount = 2
  while (stack.length) {
    const [node, parent] = stack.pop(), id = node.occurrenceId, runtimeIdentity = runtimeIdentities.get(id)
    if (records.has(id) || typeof runtimeIdentity !== 'string' || !runtimeIdentity || runtimeIdentity.length > 4096) invalid('missing, duplicate or invalid runtime continuity identity')
    if (records.size >= budget.maxNodes) invalid('live DOM node count budget exceeded')
    let projected
    if (node.kind === 'text') projected = { id, parent, kind: 'text', value: node.value, children: [], runtimeIdentity, ownership: copy(node.ownership) }
    else {
      if (typeof node.domTag !== 'string' || typeof node.inlineStyle !== 'string' || typeof node.scopeToken !== 'string'
        || !record(node.domAttributes) || !Array.isArray(node.children)) invalid('live DOM requires projected prepared nodes')
      projected = { id, parent, kind: 'element', tag: node.tag, domTag: node.domTag, runtimeIdentity,
        attributes: desiredAttributes(node), style: desiredStyle(node), control: node.textControl ? copy(node.textControl) : null,
        button: node.button ? copy(node.button) : null, children: node.children.map(child => child.occurrenceId),
        ownership: copy(node.ownership), key: node.key ?? null,
        scroll: node.tag === 'scroll-view' ? Object.fromEntries(['scroll-top', 'scroll-left'].map(name => [name, attr(node, name) == null ? null : Number(attr(node, name))])) : null }
      if (projected.scroll && Object.values(projected.scroll).some(value => value !== null && !Number.isFinite(value))) invalid('invalid live DOM scroll offset')
      stack.push(...[...node.children].reverse().map(child => [child, id]))
    }
    projected.identity = JSON.stringify([projected.kind, projected.domTag ?? null, projected.tag ?? null,
      runtimeIdentity, projected.key ?? null, projected.ownership.documentId, projected.ownership.eventOwner ?? null,
      projected.ownership.componentScope ?? null, projected.ownership.slotOwner ?? null, projected.control?.identity ?? null])
    bytes += byteLength(JSON.stringify(projected))
    operationCount += 4 + projected.children.length + Object.keys(projected.attributes ?? {}).length + (projected.control ? 8 : 0)
    if (bytes > budget.maxPatchBytes || operationCount > budget.maxOperations) invalid('live DOM patch byte/operation budget exceeded')
    records.set(id, freeze(projected)); order.push(id); if (parent === null) roots.push(id)
  }
  const validated = validateDomViewDocument(plan.document)
  if (records.size !== validated.nodes.size || runtimeIdentities.size !== records.size
    || [...validated.nodes.keys()].some(id => !records.has(id))) invalid('prepared projection does not match its complete document graph')
  if (!['width', 'height'].every(name => Number.isFinite(plan.viewport[name]) && plan.viewport[name] > 0 && plan.viewport[name] <= 4096)) invalid('invalid live DOM viewport')
  return { records, order, roots, css: plan.css, viewport: freeze(copy(plan.viewport)), bytes, operationCount }
}
function journalMutation(entry, undo, apply, bytes = 64) {
  if (entry.journal.length >= entry.limits.maxOperations || bytes > entry.limits.maxPatchBytes - entry.journalBytes) invalid('live DOM rollback journal byte/operation budget exceeded')
  entry.journalBytes += bytes
  entry.journal.push(undo) // Also undo setters that mutate before throwing.
  apply()
}
function setAttribute(entry, node, name, value) {
  const old = node.getAttribute(name)
  if (old === value) return
  journalMutation(entry, () => old === null ? node.removeAttribute(name) : node.setAttribute(name, old),
    () => value === null ? node.removeAttribute(name) : node.setAttribute(name, value), 64 + byteLength(name) + (old === null ? 0 : byteLength(old)))
}
function setProperty(entry, node, name, value) {
  const old = node[name]
  if (old === value) return
  journalMutation(entry, () => { node[name] = old }, () => { node[name] = value }, 64 + (typeof old === 'string' ? byteLength(old) : 0))
}
function move(entry, node, parent, before = null) {
  if (node.parentNode === parent && node.nextSibling === before) return
  const oldParent = node.parentNode, oldNext = node.nextSibling
  journalMutation(entry, () => {
    if (oldParent) oldParent.insertBefore(node, oldNext?.parentNode === oldParent ? oldNext : null)
    else node.parentNode?.removeChild(node)
  }, () => parent.insertBefore(node, before))
}
function remove(entry, node) {
  const parent = node.parentNode, next = node.nextSibling
  if (!parent) return
  journalMutation(entry, () => parent.insertBefore(node, next?.parentNode === parent ? next : null), () => parent.removeChild(node))
}
function terminateEditing(entry, reason) {
  if (!entry.editing || entry.continuity !== 'preserved') return
  entry.continuity = 'ended'; entry.continuityReason = reason
  const result = entry.editing.terminate(reason)
  if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); invalid('editing termination must be synchronous') }
}
function editingProtection(entry, surface) {
  const protectedIds = new Set(), editing = entry.editing
  if (!editing) return protectedIds
  if (entry.base?.surfaceIdentity !== entry.surfaceIdentity) {
    terminateEditing(entry, 'editing-surface-changed'); return protectedIds
  }
  const previous = entry.base?.staged.records, target = previous?.get(editing.occurrenceId), node = surface.nodes.get(editing.occurrenceId)
  if (!target || target.runtimeIdentity !== editing.runtimeIdentity || !target.control
    || surface.document.activeElement !== node || !connected(node)
    || !synchronous(editing.isCurrent, undefined, 'editing fence')) {
    terminateEditing(entry, 'editing-receiver-unavailable'); return protectedIds
  }
  let old = target
  while (old) {
    const next = entry.staged.records.get(old.id)
    if (!next || next.identity !== old.identity || next.parent !== old.parent || Object.hasOwn(next.attributes ?? {}, 'hidden')) {
      terminateEditing(entry, 'editing-ancestry-changed'); return new Set()
    }
    protectedIds.add(old.id); old = old.parent === null ? null : previous.get(old.parent)
  }
  const next = entry.staged.records.get(target.id), control = next.control
  if (control.disabled || (control.value !== target.control.value && node.value !== control.value)
    || !same(control.selection, target.control.selection)) {
    terminateEditing(entry, 'controlled-editing-state-changed'); return new Set()
  }
  return protectedIds
}
function updateNode(entry, element, node, previous) {
  if (node.kind === 'text') { setProperty(entry, element, 'data', node.value); return }
  const attributes = new Set([...Object.keys(previous?.attributes ?? {}), ...Object.keys(node.attributes)])
  for (const name of attributes) setAttribute(entry, element, name, Object.hasOwn(node.attributes, name) ? node.attributes[name] : null)
  const oldCss = element.style.cssText
  if (!previous || previous.style !== node.style) journalMutation(entry, () => { element.style.cssText = oldCss }, () => { element.style.cssText = node.style }, 64 + byteLength(oldCss))
  if (node.control) {
    const control = node.control
    if (node.tag === 'input') setProperty(entry, element, 'type', control.type)
    if (!previous?.control || previous.control.value !== control.value) setProperty(entry, element, 'value', control.value)
    setProperty(entry, element, 'placeholder', control.placeholder); setProperty(entry, element, 'disabled', control.disabled)
    if (control.maximum != null && control.maximum >= 0) setProperty(entry, element, 'maxLength', control.maximum)
    else setAttribute(entry, element, 'maxlength', null)
    if (control.selection && (!previous?.control || !same(previous.control.selection, control.selection))) {
      const range = { start: Math.min(control.selection.start, element.value.length), end: Math.min(control.selection.end, element.value.length), direction: control.selection.direction }
      if (element.selectionStart !== range.start || element.selectionEnd !== range.end || element.selectionDirection !== range.direction) {
        const old = [element.selectionStart, element.selectionEnd, element.selectionDirection]
        journalMutation(entry, () => element.setSelectionRange(...old), () => element.setSelectionRange(range.start, range.end, range.direction))
      }
    }
  }
  if (node.button) { setProperty(entry, element, 'type', 'button'); setProperty(entry, element, 'disabled', node.button.disabled) }
  if (node.scroll) for (const [name, property] of [['scroll-top', 'scrollTop'], ['scroll-left', 'scrollLeft']]) {
    if (node.scroll[name] !== null && (!previous || previous.scroll?.[name] !== node.scroll[name])) setProperty(entry, element, property, node.scroll[name])
  }
}
function undo(entry, surface) {
  const errors = []
  for (const reverse of entry.journal.splice(0).reverse()) try { reverse() } catch (error) { errors.push(error) }
  surface.nodes = entry.baseNodes
  if (surface.pending === entry) surface.pending = null
  entry.state = errors.length ? 'rollback-failed' : 'rolled-back'
  entry.rollbackOutcome = Object.freeze({ status: entry.state, continuity: entry.continuity,
    continuityReason: entry.continuityReason, cleanupPending: false })
  if (errors.length) {
    const error = failure('ERR_RENDER', 'live DOM rollback failed'); error.cleanupErrors = errors; error.outcome = entry.rollbackOutcome
    entry.rollbackFailure = error; surface.fault = error; throw error
  }
  return entry.rollbackOutcome
}
function release(entry, surface) {
  if (entry.releasePromise) return entry.releasePromise
  entry.releasePromise = Promise.resolve().then(async () => {
    await Promise.allSettled([...entry.lastUses])
    const errors = [...entry.lastUseFailures]
    try {
      const result = typeof entry.plan.disposeAsync === 'function' ? await entry.plan.disposeAsync() : await entry.plan.dispose()
      if (result != null && !Array.isArray(result)) invalid('live DOM plan cleanup must return errors or nothing')
      errors.push(...(result ?? []))
    } catch (error) { errors.push(error) }
    if (errors.length) {
      const error = failure('ERR_RENDER', `live DOM plan cleanup failed: ${errors.map(value => value instanceof Error ? value.message : String(value)).join('; ')}`)
      error.cleanupErrors = errors; throw error
    }
    entry.released = true; surface.retained.delete(entry)
    return Object.freeze({ status: 'released', cleanupPending: false })
  }).catch(error => { entry.cleanupFailure = error; surface.cleanupErrors.push(error); throw error })
  entry.releasePromise.catch(() => {}); surface.drains.add(entry.releasePromise)
  entry.releasePromise.then(() => surface.drains.delete(entry.releasePromise), () => surface.drains.delete(entry.releasePromise))
  return entry.releasePromise
}

export class DomLiveSurface {
  constructor({ document, mount = document?.body, contract, authorizePermit, authorizeAck, baseCss = '',
    maxNodes, maxOperations, maxPatchBytes, maxRetainedRevisions } = {}) {
    exactContract(contract)
    if (!document?.createElement || !document?.createTextNode || !document?.head || mount?.ownerDocument !== document
      || typeof mount.insertBefore !== 'function' || typeof authorizePermit !== 'function' || typeof authorizeAck !== 'function'
      || typeof baseCss !== 'string') invalid('live DOM requires an owned document, mount and explicit authority predicates')
    const budget = { maxNodes: limit(maxNodes, 100000, 100000, 'node'), maxOperations: limit(maxOperations, 500000, 1000000, 'operation'),
      maxPatchBytes: limit(maxPatchBytes, 16 * 1024 * 1024, 64 * 1024 * 1024, 'byte'),
      maxRetainedRevisions: limit(maxRetainedRevisions, 4, 32, 'revision') }
    if (byteLength(baseCss) > budget.maxPatchBytes) invalid('base stylesheet exceeds live DOM byte budget')
    // Detached construction is deliberate: no live surface starts in prepare.
    const root = document.createElement('wx-page'), style = document.createElement('style')
    root.setAttribute('data-wc-owner', 'p'); root.setAttribute('data-wc-tag', 'page')
    surfaces.set(this, { document, mount, root, style, baseCss, authorizePermit, authorizeAck, budget,
      nodes: new Map(), nativeNodes: new WeakMap(), ownedPlans: new WeakSet(), current: null, pending: null,
      retained: new Set(), drains: new Set(), cleanupErrors: [], sequence: 0, closed: false, fault: null, shutdown: null })
  }
  get contract() { return DOM_LIVE_PATCH_CONTRACT }
  get document() { return surfaces.get(this).document }
  get root() { return surfaces.get(this).root }
  get current() { return surfaces.get(this).current?.candidate ?? null }
  get pending() { return surfaces.get(this).pending?.candidate ?? null }
  get cleanupErrors() { return [...surfaces.get(this).cleanupErrors] }
  node(occurrenceId) { return surfaces.get(this).nodes.get(occurrenceId) ?? null }
  occurrenceForNode(node) { const surface = surfaces.get(this), id = surface.nativeNodes.get(node); return surface.nodes.get(id) === node ? id : null }
  prepare(plan, { presentationKey, runtimeIdentities, editing = null } = {}) {
    const surface = surfaces.get(this)
    if (surface.closed || surface.fault) cancelled('live DOM surface is retired or faulted')
    if (surface.pending) invalid('live DOM already owns an unfinished revision')
    if (surface.ownedPlans.has(plan)) invalid('a prepared resource plan has exactly one live DOM owner')
    for (const entry of [...surface.retained]) if (entry.released) surface.retained.delete(entry)
    if (surface.retained.size >= surface.budget.maxRetainedRevisions) invalid('live DOM retained revision budget exceeded')
    validateDomPresentationKey(presentationKey, plan?.document)
    if (editing !== null && (!record(editing) || typeof editing.occurrenceId !== 'string' || typeof editing.runtimeIdentity !== 'string'
      || typeof editing.isCurrent !== 'function' || typeof editing.terminate !== 'function')) invalid('invalid caller-owned editing fence')
    const staged = stage(plan, runtimeIdentities, surface.budget), base = surface.current
    staged.operationCount += base ? base.staged.records.size * 2 : 0
    staged.bytes += byteLength(surface.baseCss) + byteLength(JSON.stringify(presentationKey))
    if (staged.bytes > surface.budget.maxPatchBytes || staged.operationCount > surface.budget.maxOperations) invalid('live DOM aggregate patch byte/operation budget exceeded')
    const entry = { plan, staged, base, baseKey: base?.key ?? null, baseNodes: surface.nodes, key: freeze(copy(presentationKey)), editing: editing ? { ...editing } : null,
      surfaceIdentity: JSON.stringify([presentationKey.sessionId, presentationKey.pageId, presentationKey.surfaceGeneration, presentationKey.profile, plan.document.routePath]),
      continuity: editing ? 'preserved' : 'not-requested', continuityReason: null, state: 'prepared', journal: [], journalBytes: 0, limits: surface.budget,
      sequence: ++surface.sequence, candidate: null, permit: null, receipt: null, lastUses: new Set(), lastUseFailures: [], lastUseCount: 0 }
    const candidate = new DomLiveRevision(this, entry); entry.candidate = candidate
    surface.pending = entry; surface.retained.add(entry); surface.ownedPlans.add(plan)
    return candidate
  }
  disposeAsync() {
    const surface = surfaces.get(this)
    if (surface.shutdown) return surface.shutdown
    surface.closed = true
    surface.shutdown = Promise.resolve().then(async () => {
      if (surface.fault && !surface.cleanupErrors.includes(surface.fault)) surface.cleanupErrors.push(surface.fault)
      const pending = surface.pending
      if (pending?.state === 'applied') try { undo(pending, surface) } catch (error) { surface.cleanupErrors.push(error) }
      for (const entry of surface.retained) { entry.state = 'retired'; release(entry, surface) }
      surface.pending = null; surface.current = null; surface.nodes = new Map()
      // Only nodes created by this owner; never remove the borrowed Document,
      // iframe, mount or an unrelated sibling from another task/presenter.
      for (const node of [surface.root, surface.style]) try { node.parentNode?.removeChild(node) } catch (error) { surface.cleanupErrors.push(error) }
      await Promise.allSettled([...surface.drains])
      if (surface.cleanupErrors.length) { const error = failure('ERR_RENDER', 'live DOM shutdown cleanup failed'); error.cleanupErrors = [...surface.cleanupErrors]; throw error }
      return Object.freeze({ status: 'disposed', cleanupPending: false })
    })
    surface.shutdown.catch(() => {}); return surface.shutdown
  }
}

class DomLiveRevision {
  constructor(owner, entry) { entries.set(this, { owner, entry }); Object.freeze(this) }
  get state() { return entries.get(this).entry.state }
  get key() { return entries.get(this).entry.key }
  get baseKey() { return entries.get(this).entry.baseKey }
  get receipt() { return entries.get(this).entry.receipt }
  get budget() { const staged = entries.get(this).entry.staged; return Object.freeze({ nodes: staged.records.size, operations: staged.operationCount, bytes: staged.bytes }) }
  apply(permit) {
    const { owner, entry } = entries.get(this), surface = surfaces.get(owner)
    if (entry.applyFailure) throw entry.applyFailure
    if (entry.state === 'applied' || entry.state === 'acknowledged') {
      if (entry.permit !== permit) invalid('live DOM apply requires the exact original permit')
      return entry.receipt
    }
    if (surface.closed || surface.fault || surface.pending !== entry || entry.state !== 'prepared') cancelled('live DOM revision is no longer applicable')
    const context = Object.freeze({ candidate: this, key: entry.key, baseKey: this.baseKey, permit })
    entry.state = 'authorizing'
    try {
      if (!synchronous(surface.authorizePermit, context, 'permit predicate')) cancelled('live DOM permit was not authorized')
      if (entry.disposeRequested || surface.closed) cancelled('live DOM revision retired during permit verification')
    } catch (error) { entry.state = 'prepared'; throw error }
    entry.state = 'applying'; entry.permit = permit
    try {
      const protectedIds = editingProtection(entry, surface)
      if (entry.disposeRequested || surface.closed || !synchronous(surface.authorizePermit, context, 'permit predicate')) cancelled('live DOM permit retired before apply')
      const nextNodes = new Map()
      for (const id of entry.staged.order) {
        const node = entry.staged.records.get(id), previous = entry.base?.staged.records.get(id)
        const reused = entry.base?.surfaceIdentity === entry.surfaceIdentity && previous?.identity === node.identity
        const element = reused ? surface.nodes.get(id) : node.kind === 'text' ? surface.document.createTextNode(node.value) : surface.document.createElement(node.domTag)
        nextNodes.set(id, element)
        if (node.kind === 'element') surface.nativeNodes.set(element, id)
        updateNode(entry, element, node, reused ? previous : null)
      }
      for (const [id, node] of surface.nodes) if (nextNodes.get(id) !== node) remove(entry, node)
      const reconcile = (parent, ids) => {
        let before = null
        for (const id of [...ids].reverse()) {
          const child = nextNodes.get(id)
          // Keep the active editing ancestry anchored; rearrange its siblings
          // around it instead of unnecessarily moving the focused branch.
          if (!protectedIds.has(id)) move(entry, child, parent, before)
          before = child
        }
      }
      reconcile(surface.root, entry.staged.roots)
      for (const id of entry.staged.order) { const node = entry.staged.records.get(id); if (node.kind === 'element') reconcile(nextNodes.get(id), node.children) }
      setProperty(entry, surface.style, 'textContent', surface.baseCss + entry.staged.css)
      if (surface.style.parentNode !== surface.document.head) move(entry, surface.style, surface.document.head)
      if (surface.root.parentNode !== surface.mount) move(entry, surface.root, surface.mount)
      surface.nodes = nextNodes
      if (entry.editing && entry.continuity === 'preserved') {
        const element = nextNodes.get(entry.editing.occurrenceId)
        if (!connected(element) || element.ownerDocument !== surface.document || surface.document.activeElement !== element
          || !synchronous(entry.editing.isCurrent, undefined, 'editing fence')) terminateEditing(entry, 'native-editing-state-lost')
      }
      if (entry.disposeRequested || surface.closed || !synchronous(surface.authorizePermit, context, 'permit predicate')) cancelled('live DOM permit retired during apply')
      entry.state = 'applied'
      entry.receipt = freeze({ version: '2.0', key: entry.key, revision: String(entry.sequence), phase: 'applied',
        continuity: entry.continuity, continuityReason: entry.continuityReason })
      return entry.receipt
    } catch (error) {
      entry.applyFailure = error
      try { undo(entry, surface) } catch (cleanup) { error.cleanupErrors = [...(error.cleanupErrors ?? []), cleanup] }
      error.outcome = entry.rollbackOutcome; throw error
    }
  }
  measure() {
    const { owner, entry } = entries.get(this), surface = surfaces.get(owner)
    if (surface.closed || surface.fault || !['applied', 'acknowledged'].includes(entry.state)
      || (surface.pending !== entry && (surface.pending || surface.current !== entry))) cancelled('live geometry needs the applied exact revision')
    const nodes = []
    for (const id of entry.staged.order) {
      const element = surface.nodes.get(id)
      if (!connected(element) || element.ownerDocument !== surface.document) cancelled('live geometry encountered a detached occurrence')
      let rect
      if (element.nodeType === 3) {
        const range = surface.document.createRange()
        try { range.selectNodeContents(element); rect = range.getBoundingClientRect() } finally { range.detach?.() }
      } else rect = element.getBoundingClientRect()
      const node = { occurrenceId: id, borderBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        scrollOffset: { x: element.scrollLeft ?? 0, y: element.scrollTop ?? 0 },
        scrollExtent: { width: element.scrollWidth ?? 0, height: element.scrollHeight ?? 0 },
        clientSize: { width: element.clientWidth ?? 0, height: element.clientHeight ?? 0 } }
      if ([...Object.values(node.borderBox), ...Object.values(node.scrollOffset), ...Object.values(node.scrollExtent), ...Object.values(node.clientSize)].some(value => !Number.isFinite(value))
        || [node.borderBox.width, node.borderBox.height, ...Object.values(node.scrollExtent), ...Object.values(node.clientSize)].some(value => value < 0)) throw failure('ERR_RENDER', 'invalid actual live geometry')
      nodes.push(node)
    }
    return freeze({ key: entry.key, viewport: entry.staged.viewport, nodes }) // The caller assigns/adopts the actual geometry epoch.
  }
  acknowledge(ack) {
    const { owner, entry } = entries.get(this), surface = surfaces.get(owner)
    if (entry.state === 'acknowledged') {
      if (entry.ack !== ack) invalid('live DOM confirmation requires the exact original final ACK')
      return entry.receipt
    }
    if (surface.closed || surface.fault || surface.pending !== entry || entry.state !== 'applied') cancelled('live DOM final ACK does not own the applied revision')
    entry.state = 'confirming'
    try {
      if (!synchronous(surface.authorizeAck, Object.freeze({ candidate: this, permit: entry.permit, receipt: entry.receipt, ack }), 'ACK predicate')) cancelled('live DOM final ACK was not authorized')
    } catch (error) { entry.state = 'applied'; throw error }
    // Claim the irreversible ACK before invoking any predecessor resource code.
    entry.ack = ack; entry.state = 'acknowledged'; entry.journal.length = 0
    surface.current = entry; surface.pending = null
    if (entry.base) { entry.base.state = 'retired'; entry.ackDrain = release(entry.base, surface) }
    else entry.ackDrain = Promise.resolve(Object.freeze({ status: 'settled', cleanupPending: false }))
    entry.base = null; entry.baseNodes = null
    return entry.receipt
  }
  rollback() {
    const { owner, entry } = entries.get(this), surface = surfaces.get(owner)
    if (entry.rollbackFailure) throw entry.rollbackFailure
    if (entry.rollbackOutcome) return entry.rollbackOutcome
    if (entry.state === 'acknowledged' || entry.state === 'retired') invalid('an acknowledged live revision cannot roll back')
    if (!['prepared', 'applied'].includes(entry.state) || surface.pending !== entry) cancelled('live revision cannot roll back during another operation')
    return undo(entry, surface)
  }
  /** Register real caller-owned decoder/RAF work that still borrows this plan.
   * Retirement waits for actual settlement before releasing the plan leases.
   * This is an unbounded drain; caller deadlines cannot turn it into success.
   */
  retainUntil(promise) {
    const entry = entries.get(this).entry
    if (!['prepared', 'applied', 'acknowledged'].includes(entry.state) || entry.releasePromise || entry.disposal
      || !promise || typeof promise.then !== 'function') invalid('last use must be registered on a live exact revision')
    if (entry.lastUseCount >= 64) invalid('live DOM asynchronous last-use count budget exceeded')
    entry.lastUseCount++
    const original = Promise.resolve(promise)
    entry.lastUses.add(original)
    original.then(() => entry.lastUses.delete(original), error => { entry.lastUses.delete(original); entry.lastUseFailures.push(error) })
    return original
  }
  disposeAsync() {
    const { owner, entry } = entries.get(this), surface = surfaces.get(owner)
    if (entry.state === 'acknowledged' && surface.current === entry && !surface.closed) return entry.retentionPromise ??= Promise.resolve(Object.freeze({ status: 'retained', cleanupPending: false }))
    if (entry.disposal) return entry.disposal
    entry.disposeRequested = true
    entry.disposal = Promise.resolve().then(async () => {
      let rollbackFailure = entry.rollbackFailure
      if (surface.pending === entry && ['prepared', 'applied'].includes(entry.state)) try { this.rollback() } catch (error) { rollbackFailure = error }
      let result
      try { result = await release(entry, surface) } catch (error) {
        if (rollbackFailure) error.cleanupErrors = [...(error.cleanupErrors ?? []), rollbackFailure]
        throw error
      }
      if (rollbackFailure) throw rollbackFailure
      entry.base = null; entry.baseNodes = null; return result
    })
    entry.disposal.catch(() => {}); return entry.disposal
  }
  drainAsync() {
    const entry = entries.get(this).entry
    return entry.releasePromise ?? entry.ackDrain ?? Promise.reject(failure('ERR_PROTOCOL_VERSION', 'live DOM cleanup has not started'))
  }
}
