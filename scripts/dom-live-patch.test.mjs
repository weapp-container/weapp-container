import assert from 'node:assert/strict'
import test from 'node:test'
import { DOM_LIVE_PATCH_CONTRACT, DomLiveSurface } from '../examples/hosts/web-wasm/dom-live-patch.mjs'
import { prepareDomDocument, validateDomViewDocument } from '../examples/hosts/web-wasm/dom-presenter.mjs'

// Structural/lifecycle doubles only. These tests do not create native browser
// composition, emulate isComposing, or constitute real IME evidence.
function ownedDocument() {
  const log = []
  const document = { nodeType: 9, parentNode: null, log, activeElement: null, fail: null }
  const changed = (kind, node, name, value) => {
    log.push({ kind, node, name, value, live: node.isConnected })
    document.fail?.({ kind, node, name, value })
  }
  class Node {
    constructor(type, tag = '') {
      this.ownerDocument = document; this.nodeType = type; this.tagName = tag.toUpperCase(); this.parentNode = null
      this.childNodes = []; this.attributes = new Map(); this._text = ''; this._data = ''; this._css = ''
      this.scrollLeft = 0; this.scrollTop = 0; this.scrollWidth = 100; this.scrollHeight = 20; this.clientWidth = 100; this.clientHeight = 20
      this.style = { get cssText() { return this.node._css }, set cssText(value) { this.node._css = value; changed('style', this.node, 'cssText', value) }, node: this }
      this._type = tag === 'input' ? 'text' : tag === 'button' ? 'submit' : undefined
      this._value = ''; this._disabled = false; this._placeholder = ''; this._maximum = -1
      this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none'
    }
    get nextSibling() { const nodes = this.parentNode?.childNodes; return nodes ? nodes[nodes.indexOf(this) + 1] ?? null : null }
    get isConnected() { let node = this; while (node) { if (node === document) return true; node = node.parentNode } return false }
    contains(target) { return this === target || this.childNodes.some(child => child.contains(target)) }
    insertBefore(node, before) {
      if (before !== null && before.parentNode !== this) throw new Error('invalid insertBefore anchor')
      if (node === before) return node
      node.parentNode?.removeChild(node)
      const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before)
      this.childNodes.splice(index, 0, node); node.parentNode = this; changed('insert', node, this.tagName, before)
      return node
    }
    append(...nodes) { for (const node of nodes) this.insertBefore(node, null) }
    removeChild(node) {
      const index = this.childNodes.indexOf(node)
      if (index === -1) throw new Error('not a child')
      this.childNodes.splice(index, 1); node.parentNode = null
      // Detaching a focused subtree loses focus. The coordinator must avoid
      // doing this to a preserved editing branch; it must never repair focus.
      if (node.contains(document.activeElement)) document.activeElement = document.body
      changed('remove', node, this.tagName, null); return node
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'maxlength') this._maximum = Number(value); changed('attribute', this, name, String(value)) }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
    removeAttribute(name) { this.attributes.delete(name); if (name === 'maxlength') this._maximum = -1; changed('remove-attribute', this, name, null) }
    get type() { return this._type }
    set type(value) { this._type = value; changed('property', this, 'type', value) }
    get value() { return this._value }
    set value(value) { this._value = value; changed('property', this, 'value', value) }
    get placeholder() { return this._placeholder }
    set placeholder(value) { this._placeholder = value; changed('property', this, 'placeholder', value) }
    get disabled() { return this._disabled }
    set disabled(value) { this._disabled = value; changed('property', this, 'disabled', value) }
    get maxLength() { return this._maximum }
    set maxLength(value) { this._maximum = value; this.attributes.set('maxlength', String(value)); changed('property', this, 'maxLength', value) }
    get textContent() { return this._text }
    set textContent(value) { this._text = value; changed('text', this, 'textContent', value) }
    get data() { return this._data }
    set data(value) { this._data = value; changed('text', this, 'data', value) }
    setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; changed('selection', this, 'selection', [start, end, direction]) }
    focus() { document.activeElement = this; changed('focus', this, 'focus', true) }
    getBoundingClientRect() { changed('measure', this, 'rect', null); return { x: 0, y: 0, width: 100, height: 20 } }
  }
  document.createElement = tag => new Node(1, tag)
  document.createTextNode = text => { const node = new Node(3); node._data = text; return node }
  document.createRange = () => ({ selectNodeContents(node) { this.node = node }, getBoundingClientRect() { return this.node.getBoundingClientRect() }, detach() {} })
  document.head = new Node(1, 'head'); document.body = new Node(1, 'body')
  document.head.parentNode = document; document.body.parentNode = document; document.activeElement = document.body
  return document
}
const owner = { documentId: 'pages/home.wxml', eventOwner: null }
const element = (id, tag = 'view', options = {}) => ({ kind: 'element', occurrenceId: id, tag, attrs: {}, typedAttrs: {}, ownership: owner, events: [], children: [], ...options })
const text = (id, value) => ({ kind: 'text', occurrenceId: id, value, ownership: owner })
const view = (nodes, revision = 1) => ({ version: '1.0', sessionId: 'session', pageId: 1, revision, routePath: 'pages/home', profile: 'webview', nodes, styleRoots: [], styles: [], resources: [] })
const viewport = { width: 375, height: 667 }
const key = plan => ({ sessionId: 'session', pageId: '1', documentRevision: String(plan.document.revision), presentationRevision: String(plan.document.revision), surfaceGeneration: '0', profile: 'webview' })
const planFor = (nodes = [element('root')], revision = 1) => prepareDomDocument(view(nodes, revision), viewport)
const identities = (plan, overrides = {}) => new Map([...validateDomViewDocument(plan.document).nodes.keys()].map(id => [id, overrides[id] ?? `runtime:${id}`]))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function harness(options = {}) {
  const document = ownedDocument(), permits = new Set(), acknowledgements = new Set()
  const h = { document, permits, acknowledgements, blocked: false }
  h.surface = new DomLiveSurface({ document, contract: DOM_LIVE_PATCH_CONTRACT,
    authorizePermit: context => !h.blocked && permits.has(context.permit) && context.permit.candidate === context.candidate,
    authorizeAck: context => acknowledgements.has(context.ack) && context.ack.candidate === context.candidate, ...options })
  h.prepare = (plan, options = {}) => h.surface.prepare(plan, { presentationKey: key(plan), runtimeIdentities: identities(plan), ...options })
  h.permit = candidate => { const permit = { candidate }; permits.add(permit); return permit }
  h.ack = candidate => { const ack = { candidate }; acknowledgements.add(ack); return ack }
  h.accept = async (plan, options) => { const candidate = h.prepare(plan, options); candidate.apply(h.permit(candidate)); candidate.acknowledge(h.ack(candidate)); await candidate.drainAsync(); return candidate }
  h.editing = (id, extra = {}) => ({ occurrenceId: id, runtimeIdentity: `runtime:${id}`, isCurrent: () => !h.blocked,
    terminate: reason => document.log.push({ kind: 'terminate', reason }), ...extra })
  return h
}

test('explicit v2 negotiation and synchronous exact authority precede any live mutation', async () => {
  const document = ownedDocument()
  assert.throws(() => new DomLiveSurface({ document }), /explicit complete v2/)
  assert.throws(() => new DomLiveSurface({ document, contract: { ...DOM_LIVE_PATCH_CONTRACT, ignored: true } }), /explicit complete v2/)
  const h = harness(), plan = await planFor(), before = h.document.log.length
  const candidate = h.prepare(plan)
  assert.equal(h.document.body.childNodes.length, 0); assert.equal(h.document.head.childNodes.length, 0)
  assert.equal(h.document.log.length, before, 'prepare only stages typed data')
  assert.throws(() => candidate.measure(), /applied exact revision/)
  assert.throws(() => candidate.apply({}), /not authorized/)
  assert.equal(candidate.state, 'prepared'); assert.equal(h.document.body.childNodes.length, 0)
  assert.throws(() => h.surface.prepare({}, {}), /unfinished revision/)
  await candidate.disposeAsync(); await h.surface.disposeAsync()
  const promiseGate = harness({ authorizePermit: () => Promise.resolve(true) })
  const blocked = promiseGate.prepare(await planFor())
  assert.throws(() => blocked.apply({}), /synchronous boolean/)
  await blocked.disposeAsync(); await promiseGate.surface.disposeAsync()
})

test('same runtime identity preserves Document, editor, ancestors and native edits while removing old attributes, CSS and text', async () => {
  const h = harness({ baseCss: 'wx-page{display:block;}' })
  const initial = await planFor([element('root', 'view', { attrs: { class: 'old', 'data-obsolete': 'yes', style: 'color:red' }, children: [
    element('editor', 'input', { typedAttrs: { value: 'source', maxlength: 9 } }), text('label', 'before'),
  ] })])
  await h.accept(initial)
  const root = h.surface.node('root'), editor = h.surface.node('editor'), label = h.surface.node('label'), document = editor.ownerDocument
  editor.focus(); editor.value = '本地编辑'; editor.setSelectionRange(1, 3, 'backward'); h.document.log.length = 0
  const next = await planFor([element('root', 'view', { attrs: { class: 'new' }, children: [element('editor', 'input', { typedAttrs: { value: 'source' } }), text('label', 'after')] })], 2)
  const candidate = h.prepare(next, { editing: h.editing('editor') }), receipt = candidate.apply(h.permit(candidate))
  assert.equal(receipt.continuity, 'preserved'); assert.equal(h.surface.node('root'), root); assert.equal(h.surface.node('editor'), editor)
  assert.equal(h.surface.node('label'), label); assert.equal(label.data, 'after'); assert.equal(editor.ownerDocument, document)
  assert.equal(h.document.activeElement, editor); assert.equal(editor.value, '本地编辑'); assert.equal(editor.selectionDirection, 'backward')
  assert.equal(root.getAttribute('class'), 'new'); assert.equal(root.getAttribute('data-obsolete'), null); assert.equal(root.style.cssText, '')
  assert.equal(editor.maxLength, -1)
  assert.equal(h.document.log.some(event => event.node === editor && ['value', 'type', 'selection'].includes(event.name)), false)
  assert.equal(h.document.log.some(event => event.kind === 'focus' || event.kind === 'terminate'), false)
  const sampled = candidate.measure(); assert.equal(sampled.nodes.length, 3); assert.equal(Object.hasOwn(sampled, 'epoch'), false)
  candidate.acknowledge(h.ack(candidate)); await candidate.drainAsync(); await h.surface.disposeAsync()
})

test('source echo and unchanged explicit textarea selection do not perform equivalent native writes', async () => {
  const h = harness()
  await h.accept(await planFor([element('editor', 'textarea', { typedAttrs: { value: 'source', cursor: 1 } })]))
  const editor = h.surface.node('editor'); editor.focus(); editor.value = '中文'; editor.setSelectionRange(2, 2); h.document.log.length = 0
  const candidate = h.prepare(await planFor([element('editor', 'textarea', { typedAttrs: { value: '中文', cursor: 1 } })], 2), { editing: h.editing('editor') })
  assert.equal(candidate.apply(h.permit(candidate)).continuity, 'preserved')
  assert.equal(editor.selectionStart, 2)
  assert.equal(h.document.log.some(event => event.node === editor && ['value', 'selection', 'type', 'focus'].includes(event.name)), false)
  candidate.acknowledge(h.ack(candidate)); await candidate.drainAsync(); await h.surface.disposeAsync()
})

test('active ancestry remains anchored during sibling reorder in either direction', async () => {
  for (const reversed of [false, true]) {
    const h = harness(), editor = element('editor', 'input'), sibling = element('sibling')
    await h.accept(await planFor([element('root', 'view', { children: reversed ? [editor, sibling] : [sibling, editor] })]))
    const native = h.surface.node('editor'); native.focus(); h.document.log.length = 0
    const candidate = h.prepare(await planFor([element('root', 'view', { children: reversed ? [sibling, editor] : [editor, sibling] })], 2), { editing: h.editing('editor') })
    candidate.apply(h.permit(candidate))
    assert.equal(h.document.activeElement, native)
    assert.deepEqual(h.surface.node('root').childNodes.map(node => node.getAttribute('data-wc-id')), reversed ? ['sibling', 'editor'] : ['editor', 'sibling'])
    assert.equal(h.document.log.some(event => event.node === native && ['insert', 'remove'].includes(event.kind)), false)
    assert.equal(candidate.receipt.continuity, 'preserved')
    candidate.acknowledge(h.ack(candidate)); await candidate.drainAsync(); await h.surface.disposeAsync()
  }
})

test('runtime identity replacement, ancestor replacement and reparenting terminate continuity before mutation', async () => {
  for (const change of ['editor', 'root', 'move', 'remove']) {
    const h = harness()
    await h.accept(await planFor([element('root', 'view', { children: [element('editor', 'input')] }), element('other')]))
    const old = h.surface.node('editor'); old.focus(); h.document.log.length = 0
    const nodes = change === 'move' ? [element('root'), element('other', 'view', { children: [element('editor', 'input')] })]
      : [element('root', 'view', { children: change === 'remove' ? [] : [element('editor', 'input')] }), element('other')]
    const next = await planFor(nodes, 2), candidate = h.prepare(next, { runtimeIdentities: identities(next, { [change]: `replaced:${change}` }), editing: h.editing('editor') })
    const receipt = candidate.apply(h.permit(candidate))
    assert.equal(receipt.continuity, 'ended'); assert.equal(h.document.log[0].kind, 'terminate')
    assert.equal(h.document.log.filter(event => event.kind === 'terminate').length, 1)
    if (change === 'editor') assert.notEqual(h.surface.node('editor'), old)
    assert.equal(h.document.log.some(event => event.kind === 'focus'), false)
    candidate.rollback(); await candidate.disposeAsync(); await h.surface.disposeAsync()
  }
})

test('controlled value and selection conflicts end caller editing before writes and rollback never refocuses', async () => {
  for (const controlled of [{ value: 'new' }, { value: 'old', cursor: 0 }, { value: 'old', disabled: true }]) {
    const h = harness()
    await h.accept(await planFor([element('editor', 'input', { typedAttrs: { value: 'old' } })]))
    const editor = h.surface.node('editor'); editor.focus(); editor.value = 'native'; h.document.log.length = 0
    const candidate = h.prepare(await planFor([element('editor', 'input', { typedAttrs: controlled })], 2), { editing: h.editing('editor') })
    assert.equal(candidate.apply(h.permit(candidate)).continuity, 'ended')
    assert.equal(h.document.log[0].kind, 'terminate')
    const outcome = candidate.rollback(); assert.equal(outcome.continuity, 'ended'); assert.equal(editor.value, 'native')
    assert.equal(h.document.log.some(event => event.kind === 'focus'), false)
    await candidate.disposeAsync(); await h.surface.disposeAsync()
  }
})

test('apply and final ACK use exact objects, repeat once, and ACK is irreversible', async () => {
  const h = harness(), candidate = h.prepare(await planFor()), permit = h.permit(candidate)
  const receipt = candidate.apply(permit), operations = h.document.log.length
  assert.equal(candidate.apply(permit), receipt); assert.equal(h.document.log.length, operations)
  assert.throws(() => candidate.apply({ ...permit }), /exact original permit/)
  assert.throws(() => candidate.acknowledge({}), /not authorized/); assert.equal(candidate.state, 'applied')
  const ack = h.ack(candidate); assert.equal(candidate.acknowledge(ack), receipt); assert.equal(candidate.acknowledge(ack), receipt)
  assert.throws(() => candidate.acknowledge({ ...ack }), /exact original final ACK/)
  assert.throws(() => candidate.rollback(), /cannot roll back/)
  assert.equal((await candidate.disposeAsync()).status, 'retained'); assert.equal(h.surface.current, candidate)
  await h.surface.disposeAsync()
})

test('rollback restores exact retained nodes, attributes, style, text and native value', async () => {
  const h = harness()
  const first = await h.accept(await planFor([element('root', 'view', { attrs: { class: 'before', style: 'color:red' }, children: [element('editor', 'input', { typedAttrs: { value: 'old' } }), text('label', 'old')] })]))
  const root = h.surface.node('root'), editor = h.surface.node('editor'), label = h.surface.node('label')
  const next = h.prepare(await planFor([element('root', 'view', { attrs: { class: 'after', style: 'color:blue' }, children: [element('editor', 'input', { typedAttrs: { value: 'new' } }), text('label', 'new'), element('added')] })], 2))
  next.apply(h.permit(next)); assert.equal(editor.value, 'new'); assert.equal(label.data, 'new')
  const rolled = next.rollback(); assert.equal(next.rollback(), rolled)
  assert.equal(h.surface.current, first); assert.equal(h.surface.node('root'), root); assert.equal(h.surface.node('editor'), editor)
  assert.equal(editor.value, 'old'); assert.equal(label.data, 'old'); assert.equal(root.getAttribute('class'), 'before'); assert.equal(root.style.cssText, 'color:red;')
  assert.equal(h.surface.node('added'), null); await next.disposeAsync(); await h.surface.disposeAsync()
})

test('initial rollback and shutdown remove only this surface owned nodes', async () => {
  const h = harness(), unrelated = h.document.createElement('aside'); h.document.body.append(unrelated)
  const candidate = h.prepare(await planFor()); candidate.apply(h.permit(candidate)); candidate.rollback()
  assert.deepEqual(h.document.body.childNodes, [unrelated]); assert.equal(h.document.head.childNodes.length, 0)
  await candidate.disposeAsync(); await h.surface.disposeAsync(); assert.equal(unrelated.isConnected, true)
})

test('staged snapshots and complete runtime identity coverage are bounded before live changes', async () => {
  const h = harness(), plan = await planFor([element('root', 'view', { attrs: { class: 'frozen' } })])
  assert.throws(() => h.prepare(plan, { runtimeIdentities: new Map() }), /runtime continuity identity/)
  const candidate = h.prepare(plan); plan.nodes[0].attrs.class = 'mutated-after-prepare'
  candidate.apply(h.permit(candidate)); assert.equal(h.surface.node('root').getAttribute('class'), 'frozen')
  candidate.rollback(); await candidate.disposeAsync(); await h.surface.disposeAsync()
  for (const options of [{ maxNodes: 1 }, { maxOperations: 2 }, { maxPatchBytes: 100 }]) {
    const bounded = harness(options), oversized = await planFor([element('a'), element('b')])
    assert.throws(() => bounded.prepare(oversized), /budget/)
    assert.equal(bounded.document.body.childNodes.length, 0); await oversized.disposeAsync(); await bounded.surface.disposeAsync()
  }
})

test('mutation that throws after writing is journaled, rolled back, and keeps the original sticky failure', async () => {
  const h = harness(); await h.accept(await planFor([element('root', 'view', { attrs: { class: 'old' } })]))
  const root = h.surface.node('root'), original = new Error('write failed after mutation')
  h.document.fail = event => { if (event.node === root && event.name === 'class' && event.value === 'new') { h.document.fail = null; throw original } }
  const candidate = h.prepare(await planFor([element('root', 'view', { attrs: { class: 'new' } })], 2)), permit = h.permit(candidate)
  assert.throws(() => candidate.apply(permit), error => error === original)
  assert.equal(root.getAttribute('class'), 'old'); assert.equal(candidate.state, 'rolled-back')
  assert.throws(() => candidate.apply(permit), error => error === original)
  await candidate.disposeAsync(); await h.surface.disposeAsync()
})

test('rollback failures remain visible and fault the owner instead of pretending restoration succeeded', async () => {
  const h = harness(); await h.accept(await planFor([element('root', 'view', { attrs: { class: 'old' } })]))
  const root = h.surface.node('root'), candidate = h.prepare(await planFor([element('root', 'view', { attrs: { class: 'new' } })], 2))
  candidate.apply(h.permit(candidate))
  h.document.fail = event => { if (event.node === root && event.name === 'class' && event.value === 'old') throw new Error('rollback setter failed') }
  assert.throws(() => candidate.rollback(), error => error.cleanupErrors?.some(item => /rollback setter failed/.test(item.message)))
  assert.equal(candidate.state, 'rollback-failed'); assert.throws(() => candidate.rollback(), /rollback failed/)
  assert.throws(() => h.surface.prepare({}, {}), /retired or faulted/)
  h.document.fail = null; await assert.rejects(candidate.disposeAsync(), /rollback failed/); await assert.rejects(h.surface.disposeAsync(), /shutdown cleanup failed/)
})

test('late predecessor cleanup failure cannot remove the acknowledged successor and remains in shutdown', async () => {
  const h = harness(), gate = deferred(), first = await planFor([element('editor', 'input')])
  let releases = 0
  first.disposeAsync = async () => { releases++; await gate.promise; throw new Error('late lease failure') }
  const previous = await h.accept(first), oldNode = h.surface.node('editor')
  const candidate = h.prepare(await planFor([element('editor', 'input')], 2)); candidate.apply(h.permit(candidate)); candidate.acknowledge(h.ack(candidate))
  const failedDrain = assert.rejects(candidate.drainAsync(), /late lease failure/)
  const failedOldRelease = assert.rejects(previous.disposeAsync(), /late lease failure/)
  gate.resolve(); await failedDrain; await failedOldRelease
  assert.equal(releases, 1); assert.equal(h.surface.current, candidate); assert.equal(h.surface.node('editor'), oldNode); assert.equal(oldNode.isConnected, true)
  assert.throws(() => candidate.rollback(), /cannot roll back/)
  await assert.rejects(h.surface.disposeAsync(), /shutdown cleanup failed/)
})

test('retained revision count includes pending predecessor cleanup and frees successful releases', async () => {
  const h = harness({ maxRetainedRevisions: 2 }), gate = deferred(), first = await planFor()
  first.disposeAsync = () => gate.promise
  await h.accept(first)
  const second = h.prepare(await planFor(undefined, 2)); second.apply(h.permit(second)); second.acknowledge(h.ack(second))
  const third = await planFor(undefined, 3)
  assert.throws(() => h.prepare(third), /retained revision budget/)
  gate.resolve(); await second.drainAsync()
  const next = h.prepare(third); await next.disposeAsync(); await h.surface.disposeAsync()
})

test('reentrant hard retirement during editing termination prevents live apply', async () => {
  const h = harness(); await h.accept(await planFor([element('editor', 'input', { typedAttrs: { value: 'old' } })]))
  const editor = h.surface.node('editor'); editor.focus(); h.document.log.length = 0
  const candidate = h.prepare(await planFor([element('editor', 'input', { typedAttrs: { value: 'new' } })], 2), {
    editing: h.editing('editor', { terminate() { h.blocked = true } }),
  })
  assert.throws(() => candidate.apply(h.permit(candidate)), /retired before apply/)
  assert.equal(editor.value, 'old'); assert.equal(h.document.log.some(event => event.live && event.kind !== 'measure'), false)
  assert.equal(candidate.rollback().continuity, 'ended'); await candidate.disposeAsync(); await h.surface.disposeAsync()
})

test('reentrant shutdown from authorized ACK retains the irreversible acceptance before cleanup', async () => {
  let h, shutdown
  h = harness({ authorizeAck(context) { shutdown = h.surface.disposeAsync(); return context.ack.accepted === true } })
  const candidate = h.prepare(await planFor()); candidate.apply(h.permit(candidate))
  candidate.acknowledge({ accepted: true }); assert.equal(candidate.state, 'acknowledged')
  assert.throws(() => candidate.rollback(), /cannot roll back/)
  await shutdown; assert.equal(h.surface.current, null)
})

test('resource disposal publishes its real promise before reentrant shutdown and releases once', async () => {
  const h = harness(), plan = await planFor(), gate = deferred(), entered = deferred()
  let reentrant, releases = 0
  plan.disposeAsync = async () => { releases++; reentrant = h.surface.disposeAsync(); entered.resolve(); await gate.promise }
  await h.accept(plan)
  const shutdown = h.surface.disposeAsync(); await entered.promise
  assert.equal(reentrant, shutdown); assert.equal(h.surface.disposeAsync(), shutdown)
  gate.resolve(); await shutdown; assert.equal(releases, 1)
})

test('an old accepted revision cannot measure the successor live tree under its old key', async () => {
  const h = harness(), previous = await h.accept(await planFor())
  const candidate = h.prepare(await planFor([element('replacement')], 2))
  assert.throws(() => previous.measure(), /applied exact revision/)
  candidate.apply(h.permit(candidate))
  assert.throws(() => previous.measure(), /applied exact revision/)
  assert.deepEqual(candidate.measure().nodes.map(node => node.occurrenceId), ['replacement'])
  candidate.rollback(); assert.deepEqual(previous.measure().nodes.map(node => node.occurrenceId), ['root'])
  await candidate.disposeAsync(); await h.surface.disposeAsync()
})

test('a page or surface change cannot transfer native editing even when caller identity strings repeat', async () => {
  for (const changed of ['page', 'surface']) {
    const h = harness(); await h.accept(await planFor([element('editor', 'input', { typedAttrs: { value: 'source' } })]))
    const old = h.surface.node('editor'); old.focus(); old.value = 'private local edit'
    const next = await planFor([element('editor', 'input', { typedAttrs: { value: 'source' } })], 2)
    if (changed === 'page') next.document.pageId = 2
    const presentationKey = { ...key(next), ...(changed === 'page' ? { pageId: '2' } : { surfaceGeneration: '1' }) }
    const candidate = h.prepare(next, { presentationKey, editing: h.editing('editor') })
    assert.equal(candidate.apply(h.permit(candidate)).continuity, 'ended')
    assert.notEqual(h.surface.node('editor'), old); assert.equal(h.surface.node('editor').value, 'source')
    candidate.rollback(); await candidate.disposeAsync(); await h.surface.disposeAsync()
  }
})

test('rollback journal bytes bound unexpectedly large native values before a controlled write', async () => {
  const h = harness({ maxPatchBytes: 4096 })
  await h.accept(await planFor([element('editor', 'input', { typedAttrs: { value: 'source' } })]))
  const editor = h.surface.node('editor'); editor.value = '界'.repeat(4096)
  const candidate = h.prepare(await planFor([element('editor', 'input', { typedAttrs: { value: 'reset' } })], 2))
  assert.throws(() => candidate.apply(h.permit(candidate)), /rollback journal byte/)
  assert.equal(editor.value, '界'.repeat(4096)); assert.equal(candidate.state, 'rolled-back')
  await candidate.disposeAsync(); await h.surface.disposeAsync()
})

test('actual last-use drains fence plan leases through retirement and preserve late failures', async () => {
  const h = harness(), borrowed = deferred(), first = await planFor()
  let released = false
  first.disposeAsync = () => { released = true }
  const previous = await h.accept(first)
  previous.retainUntil(borrowed.promise)
  const candidate = h.prepare(await planFor(undefined, 2)); candidate.apply(h.permit(candidate)); candidate.acknowledge(h.ack(candidate))
  await Promise.resolve(); assert.equal(released, false)
  assert.throws(() => previous.retainUntil(Promise.resolve()), /live exact revision/)
  const failed = assert.rejects(candidate.drainAsync(), /decoder last use failed/)
  borrowed.reject(new Error('decoder last use failed')); await failed
  assert.equal(released, true); assert.equal(h.surface.current, candidate)
  await assert.rejects(h.surface.disposeAsync(), /shutdown cleanup failed/)
})

test('last-use registrations are finite and a reentrant disposal during permit verification prevents activation', async () => {
  let h, disposal
  h = harness({ authorizePermit(context) { disposal = context.candidate.disposeAsync(); return true } })
  const candidate = h.prepare(await planFor())
  for (let index = 0; index < 64; index++) candidate.retainUntil(Promise.resolve())
  assert.throws(() => candidate.retainUntil(Promise.resolve()), /last-use count budget/)
  assert.throws(() => candidate.apply({}), /retired during permit verification/)
  assert.equal(h.document.body.childNodes.length, 0)
  await disposal; await h.surface.disposeAsync()
})
