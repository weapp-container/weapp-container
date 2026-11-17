import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { DomPointerContacts, DomViewPresenter, domTextControlState, restoreDomTextControlState, prepareDomDocument, planDomEvent, scopeDomSelector, validateDomInputFacts, validateDomPresentationKey, validateDomViewDocument } from '../examples/hosts/web-wasm/dom-presenter.mjs'

const owner = (eventOwner = null, documentId = 'pages/home.wxml') => ({ eventOwner, documentId })
const element = (id, tag = 'view', options = {}) => ({ kind: 'element', occurrenceId: id, tag, attrs: {}, typedAttrs: {}, ownership: owner(), events: [], children: [], ...options })
const document = (nodes = [element('root')], revision = 1) => ({ version: '1.0', sessionId: 'session', pageId: 1, revision, routePath: 'pages/home', profile: 'webview', nodes, styleRoots: [], styles: [], resources: [] })
const viewport = { width: 375, height: 667 }
const rule = (selector, values) => ({ selectors: [selector], declarations: Object.entries(values).map(([property, value]) => ({ property, value, important: false })), nested: [] })
const sheet = (id, rules, scopeId) => ({ id: `style:${id}`, ...(scopeId == null ? {} : { scopeId }), ir: { version: 2, imports: [], rules } })
const resource = path => ({ path, sha256: 'a'.repeat(64), mime: 'image/png', size: 12 })
const binding = (handler, phase = 'bubble', catches = false, event = 'tap') => ({ event, handler, phase, catch: catches })

test('DOM input is a strict evaluated document, never a positioned RenderFrame', () => {
  validateDomViewDocument(document())
  for (const mutate of [value => value.nodes[0].bounds = { x: 1, y: 1, width: 1, height: 1 },
    value => value.profile = 'skia', value => value.version = '2.0', value => value.nodes.push(value.nodes[0]),
    value => value.nodes[0].tag = 'live-player', value => value.nodes[0].events = [binding('async', 'bubble', false, 'longpress')]]) {
    const value = document(); mutate(value)
    assert.throws(() => validateDomViewDocument(value), /ERR_RENDER|ERR_UNSUPPORTED_CAPABILITY|ERR_PROTOCOL_VERSION/)
  }
})

test('modern evaluator branches and keyed repeats reach the DOM as evaluated topology with consumed source controls', async () => {
  const context = vm.createContext({})
  vm.runInContext('const parse=JSON.parse, serialize=JSON.stringify;', context)
  vm.runInContext(readFileSync(new URL('../crates/container-core/src/modern_view.js', import.meta.url), 'utf8'), context)
  const sourceNode = (attrs, children = []) => ({ kind: 'element', tag: 'view', attrs, bindings: [], children })
  const text = value => ({ kind: 'text', value, bindings: [] })
  const source = [sourceNode({ id: 'primary', 'wx:if': '{{visible}}' }),
    sourceNode({ id: 'fallback', 'wx:elif': '{{fallback}}' }), sourceNode({ id: 'empty', 'wx:else': '' }),
    sourceNode({ id: '{{row.id}}', 'wx:for': '{{rows}}', 'wx:for-item': 'row', 'wx:for-index': 'position', 'wx:key': 'id',
      'wx:if': '{{row.visible}}', animation: '{{row.animation}}' }, [text('{{position}}:{{row.id}}')])]
  const controls = new Set()
  for (const [visible, fallback, selected] of [[true, true, 'primary'], [false, true, 'fallback'], [false, false, 'empty']]) {
    context.input = JSON.stringify({ documents: [{ documentId: 'pages/home.wxml', bindings: {}, ast: { version: 1, nodes: source } }],
      tasks: [{ taskId: 'root', scopeId: 'page', documentId: 'pages/home.wxml', data: { visible, fallback,
        rows: [{ id: 'a', visible: true, animation: { actions: [] } }, { id: 'b', visible: false, animation: { actions: [] } }, { id: 'c', visible: true, animation: { actions: [] } }] } }] })
    let output = JSON.parse(vm.runInContext('serialize(__weappContainer_view_render(parse(input)))', context))
    if (typeof output === 'string') output = JSON.parse(output)
    assert.equal(output.ok, true, JSON.stringify(output))
    const evaluated = output.results[0].ast.nodes
    assert.deepEqual(evaluated.map(node => node.attrs.id), [selected, 'a', 'c'])
    assert.deepEqual(evaluated.slice(1).map(node => node.key), ['a', 'c'])
    // Exercise the same evaluated attribute channels as ViewDocument export;
    // these test IDs stand in for the runtime's own occurrence identities.
    let sequence = 0
    const project = node => node.kind === 'text'
      ? { kind: 'text', occurrenceId: `evaluated:${sequence++}`, value: node.value, ownership: owner() }
      : element(`evaluated:${sequence++}`, node.tag, { attrs: node.attrs, typedAttrs: node.boundValues, key: node.key,
        children: node.children.map(project) })
    const value = document(evaluated.map(project)), before = structuredClone(value)
    for (const node of value.nodes) for (const name of Object.keys(node.attrs)) if (name.startsWith('wx:')) controls.add(name)
    const animation = { version: '1.0', requestId: 'animation:evaluated', styles: [], baselines: value.nodes.slice(1)
      .map(node => ({ occurrenceId: node.occurrenceId, opacity: false, transform: false })) }
    const plan = await prepareDomDocument(value, viewport, { animation })
    assert.deepEqual(value, before)
    assert.deepEqual(plan.nodes.map(node => [node.occurrenceId, node.key]), value.nodes.map(node => [node.occurrenceId, node.key]))
    assert.deepEqual(plan.nodes.slice(1).map(node => node.children[0].value), ['0:a', '2:c'])
    for (const node of plan.nodes) for (const attrs of [node.attrs, node.typedAttrs, node.domAttributes]) {
      assert.equal(Object.keys(attrs).some(name => name.startsWith('wx:') || name === 'animation'), false)
    }
    plan.dispose()
  }
  assert.deepEqual([...controls].sort(), ['wx:elif', 'wx:else', 'wx:for', 'wx:for-index', 'wx:for-item', 'wx:if', 'wx:key'])
})

test('only exact evaluated structural controls are stripped from both attribute channels', async () => {
  const controls = { 'wx:if': '{{alreadyEvaluated()}}', 'wx:elif': '{{fallback}}', 'wx:else': '', 'wx:for': '{{rows}}',
    'wx:for-item': 'entry', 'wx:for-index': 'position', 'wx:key': 'id' }
  for (const tag of ['view', 'card']) {
    const source = element('kept', tag, { key: 'stable-key', attrs: { ...controls, id: 'kept' }, typedAttrs: { ...controls, 'wx:if': false },
      ownership: { ...owner(), ...(tag === 'card' ? { componentScope: 'card-scope' } : {}) } })
    const value = document([source]), original = structuredClone(value), plan = await prepareDomDocument(value, viewport)
    assert.deepEqual(value, original)
    assert.equal(plan.nodes[0].occurrenceId, 'kept'); assert.equal(plan.nodes[0].key, 'stable-key')
    assert.deepEqual(plan.nodes[0].attrs, { id: 'kept' }); assert.deepEqual(plan.nodes[0].typedAttrs, {})
    plan.dispose()
    for (const unknown of ['wx:unknown', 'wx:ref', 'wx:model', 'wx:for-items', 'wx:If', 'WX:if']) for (const channel of ['attrs', 'typedAttrs']) {
      const invalid = structuredClone(value); invalid.nodes[0][channel][unknown] = '{{value}}'
      await assert.rejects(prepareDomDocument(invalid, viewport), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY' && error.message.includes(unknown))
    }
  }
})

test('consumed animation directives require exact typed occurrence metadata and leave no browser projection', async () => {
  const payload = { actions: [] }, raw = JSON.stringify(payload)
  const value = document([element('root', 'view', { attrs: { animation: raw, style: 'opacity:.7' }, typedAttrs: { animation: payload } })])
  const animation = { version: '1.0', requestId: 'animation:1', baselines: [{ occurrenceId: 'root', opacity: false, transform: false }], styles: [] }
  const original = structuredClone(value)
  const plan = await prepareDomDocument(value, viewport, { animation })
  assert.deepEqual(value, original, 'consuming a directive must not mutate the evaluated source document')
  assert.equal(Object.hasOwn(plan.nodes[0].attrs, 'animation'), false)
  assert.equal(Object.hasOwn(plan.nodes[0].typedAttrs, 'animation'), false)
  assert.deepEqual(plan.nodes[0].domAttributes, {})
  assert.equal(plan.nodes[0].inlineStyle, 'opacity:.7;')
  assert.equal(plan.css, '')
  assert.equal(plan.allElements.get('root'), plan.nodes[0])
  plan.dispose()
})

test('raw, missing, mismatched or styles-only animation authority cannot consume a directive', async () => {
  const payload = { actions: [] }, raw = JSON.stringify(payload)
  const metadata = { version: '1.0', requestId: 'animation:1', baselines: [{ occurrenceId: 'other', opacity: false, transform: false }], styles: [] }
  for (const tag of ['view', 'card']) {
    const animated = element('root', tag, { attrs: { animation: raw, 'wx:if': '{{visible}}' }, typedAttrs: { animation: payload },
      ownership: { ...owner(), ...(tag === 'card' ? { componentScope: 'card-scope' } : {}) } })
    const value = document([animated, element('other')])
    for (const animation of [undefined, metadata, { ...metadata, baselines: [], styles: [{ occurrenceId: 'root', opacity: null, transform: null, origin: null }] }]) {
      await assert.rejects(prepareDomDocument(value, viewport, { animation }), /no matching consumed animation metadata/)
    }
    const rawOnly = structuredClone(value); rawOnly.nodes[0].typedAttrs = {}
    await assert.rejects(prepareDomDocument(rawOnly, viewport, { animation: { ...metadata, baselines: [{ ...metadata.baselines[0], occurrenceId: 'root' }] } }), /typed evaluator binding/)
    for (const empty of [null, '']) {
      const unconsumed = structuredClone(value); unconsumed.nodes[0].attrs.animation = ''; unconsumed.nodes[0].typedAttrs.animation = empty
      await assert.rejects(prepareDomDocument(unconsumed, viewport), /no matching consumed animation metadata/)
    }
  }
  const value = document([element('root', 'view', { attrs: { animation: raw }, typedAttrs: { animation: payload } }),
    { kind: 'text', occurrenceId: 'text', value: 'label', ownership: owner() }])
  for (const occurrenceId of ['missing', 'text']) await assert.rejects(prepareDomDocument(value, viewport, {
    animation: { ...metadata, baselines: [{ ...metadata.baselines[0], occurrenceId }] },
  }), /metadata must identify an element occurrence/)
  await assert.rejects(prepareDomDocument(value, viewport, { animation: { ...metadata, version: '2.0' } }), /invalid animation baseline request/)
})

test('consumed runtime animation metadata never enables authored CSS animation or transition', async () => {
  const payload = { actions: [] }
  const animation = { version: '1.0', requestId: 'animation:1', baselines: [{ occurrenceId: 'root', opacity: false, transform: false }], styles: [] }
  for (const property of ['animation', 'animation-name', 'transition', 'transition-duration']) {
    const value = document([element('root', 'view', { attrs: { animation: JSON.stringify(payload), 'wx:if': '{{visible}}', style: `${property}:none` }, typedAttrs: { animation: payload } })])
    await assert.rejects(prepareDomDocument(value, viewport, { animation }), new RegExp(`CSS ${property}`))
    value.nodes[0].attrs.style = ''
    value.styleRoots = ['style:pages/home.wxss']; value.styles = [sheet('pages/home.wxss', [rule('view', { [property]: 'none' })])]
    await assert.rejects(prepareDomDocument(value, viewport, { animation }), new RegExp(`CSS ${property}`))
  }
})

test('scoped browser selectors preserve specificity while preventing descendant scope leaks', () => {
  assert.equal(scopeDomSelector('view.card > text:first-child, .label::before', 'o1'), 'wx-view.card:where([data-wc-owner="o1"]) > wx-text:first-child:where([data-wc-owner="o1"]), .label:where([data-wc-owner="o1"])::before')
  assert.equal(scopeDomSelector('card.foo', 'p'), 'wx-component:where([data-wc-tag="card"]).foo:where([data-wc-owner="p"])')
  assert.equal(scopeDomSelector('input[data-kind="a b"]:focus', 'p'), 'input[data-kind="a b"]:focus:where([data-wc-owner="p"])')
  assert.equal(scopeDomSelector('button.primary:disabled > text', 'p'), 'button.primary:disabled:where([data-wc-owner="p"]) > wx-text:where([data-wc-owner="p"])')
  assert.equal(scopeDomSelector('button[type="primary"]', 'p'), 'button[data-wc-button-source-type="primary"]:where([data-wc-owner="p"])')
  assert.equal(scopeDomSelector('button[type]', 'p'), 'button[data-wc-button-source-type]:where([data-wc-owner="p"])')
  assert.equal(scopeDomSelector('[type]', 'p'), ':is([type]:where(:not(button)),[data-wc-button-source-type]:where(button)):where([data-wc-owner="p"])')
  assert.equal(scopeDomSelector('.control[type=primary]', 'p'), '.control:is([type=primary]:where(:not(button)),[data-wc-button-source-type=primary]:where(button)):where([data-wc-owner="p"])')
  assert.equal(scopeDomSelector('input[type=password]', 'p'), 'input[type=password]:where([data-wc-owner="p"])')
  for (const selector of ['view:has(text)', '::slotted(text)', '.a\\:b', 'view{color:red}', '[x="broken]']) assert.throws(() => scopeDomSelector(selector, 'p'), /ERR_/)
})

test('basic buttons retain evaluated children and use typed booleans with bounded appearance values', async () => {
  const child = element('label', 'text', { children: [{ kind: 'text', occurrenceId: 'text', value: 'Save 7', ownership: owner() }] })
  const value = document([element('save', 'button', { attrs: { type: 'warn', disabled: 'true', loading: 'false', plain: 'false' },
    typedAttrs: { type: 'primary', size: 'mini', disabled: false, loading: true, plain: true }, children: [child] })])
  const plan = await prepareDomDocument(value, viewport)
  assert.equal(plan.nodes[0].domTag, 'button')
  assert.deepEqual(plan.nodes[0].button, { type: 'primary', size: 'mini', disabled: false, loading: true, plain: true })
  assert.deepEqual(plan.nodes[0].domAttributes, { size: 'mini', plain: 'true', loading: 'true' }, 'WXML type is appearance, never an HTML type attribute')
  assert.deepEqual(plan.nodes[0].children[0].children[0].value, 'Save 7')
  const defaults = await prepareDomDocument(document([element('button', 'button')]), viewport)
  assert.deepEqual(defaults.nodes[0].button, { type: 'default', size: 'default', disabled: false, loading: false, plain: false })
  for (const disabled of [false, 0, null, 'false']) {
    const planned = await prepareDomDocument(document([element('button', 'button', { typedAttrs: { disabled } })]), viewport)
    assert.equal(planned.nodes[0].button.disabled, false)
  }
  for (const name of ['disabled', 'loading', 'plain']) await assert.rejects(
    prepareDomDocument(document([element('button', 'button', { typedAttrs: { [name]: {} } })]), viewport), /must be a scalar attribute/)
})

test('button host abilities and unknown appearances reject rather than submit, reset or fake success', async () => {
  for (const attrs of [{ 'open-type': 'getUserInfo' }, { 'open-type': '' }, { 'form-type': 'submit' }, { 'form-type': 'reset' },
    { 'hover-class': 'active' }, { 'session-from': 'fixture' }, { 'data-wc-button-source-type': 'submit' },
    { type: 'submit' }, { type: 'reset' }, { type: 'unknown' }, { size: 'large' }]) {
    await assert.rejects(prepareDomDocument(document([element('button', 'button', { attrs })]), viewport), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
  }
  await assert.rejects(prepareDomDocument(document([element('button', 'button', { typedAttrs: { 'data-wc-button-source-type': 'submit' } })]), viewport), /reserved presenter attribute/)
  for (const event of ['input', 'confirm', 'scroll']) await assert.rejects(
    prepareDomDocument(document([element('button', 'button', { events: [binding('unsupported', 'bubble', false, event)] })]), viewport), /button event/)
})

test('interactive button descendants reject before candidate creation or any resource acquisition', async () => {
  for (const child of [element('nested', 'button'), element('nested', 'input'), element('nested', 'textarea'), element('nested', 'text', { attrs: { tabindex: '0' } }),
    element('component', 'card', { ownership: { ...owner(), componentScope: 'card' }, children: [element('nested', 'input')] })]) {
    const h = fakePresenter(), value = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } }), element('button', 'button', { children: [child] })])
    value.resources = [resource('assets/pixel.png')]
    let acquired = 0; h.presenter.resolveResource = () => { acquired++; return '/api/resources/pixel' }
    await assert.rejects(h.presenter.prepare(value, { viewport, presentationKey: key(value) }), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(h.candidates.length, 0); assert.equal(acquired, 0)
    await h.presenter.disposeAsync()
  }
})

test('raw WXSS imports inherit scope, convert rpx once and resolve only manifest resources', async () => {
  const value = document([element('root', 'image', { attrs: { src: '../assets/pixel.png', style: 'width: 100rpx; height: calc(40rpx + 1px)', mode: 'aspectFit' } })])
  value.resources = [resource('assets/pixel.png')]
  value.styleRoots = ['style:components/card.wxss']
  value.styles = [sheet('components/card.wxss', [{ atRule: '@import "../shared/theme.wxss" (min-width: 200px)', selectors: [], declarations: [], nested: [] }], 'instance'),
    sheet('shared/theme.wxss', [rule('view', { width: '80rpx', 'background-image': 'url(../assets/pixel.png)', content: '"40rpx"' })], 'instance')]
  const calls = [], releases = []
  const plan = await prepareDomDocument(value, viewport, { resolveResource: async (descriptor, context) => {
    calls.push({ descriptor, context }); return { url: '/api/resources/pixel', release: () => releases.push(descriptor.path) }
  } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].descriptor.sha256, 'a'.repeat(64))
  assert.equal(calls[0].context.sessionId, 'session')
  assert.deepEqual(calls[0].context.presentationKey, key(value))
  assert.ok(Object.isFrozen(calls[0].context.presentationKey))
  assert.equal(plan.nodes[0].imageUrl, '/api/resources/pixel')
  assert.equal(plan.nodes[0].inlineStyle, 'width:50px;height:calc(20px + 1px);')
  assert.match(plan.css, /@media \(min-width: 200px\)/)
  assert.match(plan.css, /width:40px;/)
  assert.match(plan.css, /content:"40rpx";/)
  assert.match(plan.css, /data-wc-owner="o1"/)
  assert.doesNotMatch(plan.css, /owner="p"/)
  assert.deepEqual(plan.dispose(), [])
  assert.deepEqual(releases, ['assets/pixel.png'])
  plan.dispose(); assert.equal(releases.length, 1)
})

test('failed preparation releases resolved assets and unsupported capabilities never disappear silently', async () => {
  const cases = [
    value => value.nodes[0].attrs.src = 'https://external.invalid/file.png',
    value => value.nodes[0].attrs.mode = 'widthFix',
    value => value.nodes[0].attrs.style = 'animation:spin 1s',
    value => value.nodes[0].attrs['data-wc-owner'] = 'p',
    value => value.nodes[0].attrs.style = 'height:10px; -moz-binding:url(a)',
  ]
  for (const mutate of cases) {
    const value = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } })]); value.resources = [resource('assets/pixel.png')]; mutate(value)
    await assert.rejects(prepareDomDocument(value, viewport, { resolveResource: () => '/api/resources/pixel' }), /ERR_/)
  }
  const value = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } }), element('bad', 'input', { attrs: { type: 'number' } })])
  value.resources = [resource('assets/pixel.png')]
  let released = 0
  await assert.rejects(prepareDomDocument(value, viewport, { resolveResource: () => ({ url: 'blob:owned', release: () => released++ }) }), /input type number/)
  assert.equal(released, 0, 'invalid native controls reject in whole-document preflight, before acquiring resources')
  const unsupportedCss = document(); unsupportedCss.nodes[0].attrs.style = 'made-up-property:1'
  await assert.rejects(prepareDomDocument(unsupportedCss, viewport, { supports: () => false }), /ERR_UNSUPPORTED_CAPABILITY/)
})

test('native text controls preflight scalar attributes and selection before acquiring a candidate', async () => {
  await assert.rejects(prepareDomDocument(document([element('control', 'input', { attrs: { type: 'textarea' } })]), viewport), /input type textarea/)
  for (const tag of ['input', 'textarea']) {
    for (const attrs of [{ maxlength: -2 }, { maxlength: 2147483648 }, { cursor: 1.5 }, { cursor: -2 }, { 'selection-start': 1 },
      { 'selection-start': 3, 'selection-end': 2 }, { focus: true }, { value: {} }, { placeholder: [] }, { disabled: {} }]) {
      const h = fakePresenter(), value = document([element('control', tag, { typedAttrs: attrs })]);
      await assert.rejects(h.presenter.prepare(value, { viewport, presentationKey: key(value) }), /ERR_/)
      assert.equal(h.candidates.length, 0)
      await h.presenter.disposeAsync()
    }
    await assert.rejects(prepareDomDocument(document([element('control', tag, { children: [element('nested')] })]), viewport), /children/)
  }
  const plan = await prepareDomDocument(document([element('multi', 'textarea', { typedAttrs: { value: 'a\nb', placeholder: 'Text', maxlength: -1, disabled: false, cursor: 2 } })]), viewport)
  assert.equal(plan.nodes[0].domTag, 'textarea')
  assert.equal(plan.nodes[0].textControl.type, 'textarea')
  assert.equal(plan.nodes[0].textControl.value, 'a\nb')
  assert.deepEqual(plan.nodes[0].textControl.selection, { start: 2, end: 2, direction: 'none' })
  assert.equal(scopeDomSelector('textarea:focus', 'p'), 'textarea:focus:where([data-wc-owner="p"])')
  plan.dispose()
})

test('text edit restoration uses semantic identity and normalized source values', () => {
  const node = element('editor', 'input', { typedAttrs: { value: 42 }, ownership: { ...owner('component'), componentScope: 'scope', slotOwner: 'slot' } })
  const initial = domTextControlState(node)
  const previous = { controlIdentity: initial.identity, sourceValue: initial.value, value: 'edited😀', focus: true, selectionStart: 2, selectionEnd: 8, selectionDirection: 'backward' }
  const equivalent = domTextControlState({ ...node, typedAttrs: { value: '42' } })
  assert.deepEqual(restoreDomTextControlState(equivalent, previous), { value: 'edited😀', focus: true, selection: { start: 2, end: 8, direction: 'backward' } })
  const replaced = domTextControlState({ ...node, typedAttrs: { value: 'x' } })
  assert.deepEqual(restoreDomTextControlState(replaced, previous), { value: 'x', focus: true, selection: { start: 1, end: 1, direction: 'backward' } })
  for (const changed of [
    { ...node, tag: 'textarea' }, { ...node, typedAttrs: { value: 42, password: true } }, { ...node, key: 'different' },
    ...['documentId', 'eventOwner', 'componentScope', 'slotOwner'].map(field => ({ ...node, ownership: { ...node.ownership, [field]: 'other' } })),
  ]) assert.deepEqual(restoreDomTextControlState(domTextControlState(changed), previous), { value: '42', selection: null, focus: false })
  const disabled = domTextControlState({ ...node, typedAttrs: { value: 42, disabled: true } })
  assert.equal(restoreDomTextControlState(disabled, previous).focus, false)
})

test('explicit text selection takes precedence over cursor and retained native range', () => {
  const node = element('editor', 'textarea', { typedAttrs: { value: 'A😀B', cursor: 2, 'selection-start': 1, 'selection-end': 99 } })
  const control = domTextControlState(node)
  assert.deepEqual(restoreDomTextControlState(control), { value: 'A😀B', focus: false, selection: { start: 1, end: 4, direction: 'none' } })
  for (const tag of ['input', 'textarea']) {
    const value = document([element('editor', tag, { typedAttrs: { disabled: true }, events: [binding('edit', 'bubble', false, 'input')] })])
    for (const type of ['input', 'focus', 'blur', 'confirm', 'tap', 'touchstart']) assert.equal(planDomEvent(value, 'editor', type).disabled, true)
  }
})

test('missing imports, cycles, differing scoped sources and unsafe resolver URLs reject', async () => {
  const value = document()
  value.styleRoots = ['style:app.wxss']
  value.styles = [sheet('app.wxss', [{ atRule: '@import "./missing.wxss" print', selectors: [], declarations: [], nested: [] }])]
  await assert.rejects(prepareDomDocument(value, viewport), /unavailable scoped stylesheet/)
  value.styles[0].ir.rules[0].atRule = '@import "./app.wxss"'
  await assert.rejects(prepareDomDocument(value, viewport), /cycle/)
  value.styles = [sheet('app.wxss', [rule('view', { color: 'red' })], 'a'), sheet('app.wxss', [rule('view', { color: 'blue' })], 'b')]
  assert.throws(() => validateDomViewDocument(value), /sources differ/)
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', '//external.invalid/x', '/a" onclick="bad']) {
    const image = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } })]); image.resources = [resource('assets/pixel.png')]
    await assert.rejects(prepareDomDocument(image, viewport, { resolveResource: () => url }), /invalid image URL/)
  }
})

test('events preserve component and slot declaration ownership, typed dataset and capture/catch order', () => {
  const light = element('light', 'text', { attrs: { 'data-active': 'false' }, typedAttrs: { 'data-active': false }, events: [binding('lightTap')], ownership: { ...owner('declaration-owner', 'shared/light.wxml'), slotOwner: 'declaration-owner' } })
  const host = element('host', 'card', { ownership: { ...owner('page-owner'), componentScope: 'mounted-card' }, events: [binding('hostCapture', 'capture'), binding('hostCatch', 'bubble', true)], children: [light] })
  const root = element('root', 'view', { events: [binding('rootCapture', 'capture'), binding('rootBubble')], children: [host] })
  const event = planDomEvent(document([root]), 'light', 'tap', { x: 4, y: 6 })
  assert.deepEqual(event.listeners.map(listener => listener.handler), ['rootCapture', 'hostCapture', 'lightTap', 'hostCatch'])
  assert.equal(event.caught, true)
  assert.equal(event.target.dataset.active, false)
  assert.equal(event.listeners[2].ownerScopeId, 'declaration-owner')
  assert.equal(event.listeners[3].ownerScopeId, 'page-owner')
  assert.equal(event.target.ownerScopeId, 'declaration-owner')
  assert.deepEqual(event.detail, { x: 4, y: 6 })
})

test('component properties never become native control attributes while evaluated child text is preserved', async () => {
  const props = Object.fromEntries(['value', 'type', 'checked', 'disabled', 'placeholder', 'maxlength', 'scroll-x', 'scroll-y', 'scroll-top', 'scroll-left', 'selectable', 'mode', 'password', 'focus'].map(name => [name, { property: name }]))
  const value = document([element('component', 'counter-card', {
    ownership: { ...owner(), componentScope: 'counter-instance' }, typedAttrs: props,
    children: [{ kind: 'text', occurrenceId: 'label', value: 'count: 7', ownership: owner('counter-instance') }],
  }), element('control', 'input', { typedAttrs: { value: 'native value', type: 'text', placeholder: 'native placeholder', disabled: false, maxlength: 12 } })])
  const plan = await prepareDomDocument(value, viewport)
  assert.equal(plan.nodes[0].domTag, 'wx-component')
  assert.deepEqual(plan.nodes[0].domAttributes, {})
  assert.deepEqual(plan.nodes[0].typedAttrs, props)
  assert.equal(plan.nodes[0].children[0].value, 'count: 7')
  assert.deepEqual(plan.nodes[1].domAttributes, { value: 'native value', placeholder: 'native placeholder', disabled: 'false', maxlength: '12' })
  assert.equal(plan.nodes[1].inputType, 'text')
  plan.dispose()
  for (const name of ['value', 'placeholder', 'disabled', 'maxlength']) {
    await assert.rejects(prepareDomDocument(document([element('control', 'input', { typedAttrs: { [name]: { invalid: true } } })]), viewport), new RegExp(`${name} must be a scalar`))
  }
})

const key = (value = document(), presentationRevision = String(value.revision), surfaceGeneration = '0') => ({ sessionId: value.sessionId, pageId: String(value.pageId), documentRevision: String(value.revision), presentationRevision, surfaceGeneration, profile: 'webview' })
const permit = candidate => ({ version: '1.0', key: candidate.preparation.key, epoch: candidate.preparation.epoch, permitId: 'runtime-issued-permit' })
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function fakePresenter(options = {}) {
  const output = [], geometries = [], candidates = [], presenter = new DomViewPresenter({ ownerDocument: {}, append() {} }, {
    timeoutMs: 1000, onEventBatch: batch => output.push(batch), onGeometry: batch => geometries.push(batch), ...options,
  })
  presenter.createCandidate = async () => {
    const candidate = { supports: () => true, validateSelector() {}, disposed: false, connected: true, visible: false, interactive: false, disposeCount: 0,
      async populate(plan) { candidate.plan = plan; if (candidate.fail) throw new Error('candidate failed'); },
      snapshot() { if (candidate.snapshotFailure) throw new Error('snapshot failed'); return candidate.snapshotValue ?? new Map() }, restore(state) { candidate.restored = state },
      measure() { return candidate.geometry ?? Array.from(candidate.plan.tables.nodes.keys(), occurrenceId => ({ occurrenceId, x: 0, y: 0, width: 120, height: 30, scrollTop: 0, scrollHeight: 300, clientHeight: 30 })) },
      isConnected() { return candidate.connected && !candidate.disposed },
      setVisible(value) { candidate.visible = value }, setInteractive(value) { candidate.interactive = value },
      activate(send, changed) { if (candidate.activationFailure) throw new Error('activation failed'); candidate.send = send; candidate.changed = changed },
      dispose() { if (candidate.disposed) return []; candidate.disposeCount++; candidate.disposed = true; candidate.connected = false; candidate.interactive = false; return [...(candidate.plan?.dispose() ?? []), ...(candidate.cleanupErrors ?? [])] } }
    candidates.push(candidate); return candidate
  }
  return { presenter, output, geometries, candidates }
}

test('presentation publishes geometry only after success and retains accepted surface on failure', async () => {
  const { presenter, candidates } = fakePresenter()
  const first = await presenter.submit(document(), { viewport, frameId: 7, configGeneration: 3 })
  assert.equal(first.acknowledgement, 'standalone-compatibility')
  assert.equal(first.layoutAuthority, 'browser')
  assert.equal(first.frameId, 7); assert.equal(first.configGeneration, 3)
  assert.equal(first.geometry[0].width, 120)
  const accepted = presenter.current, create = presenter.createCandidate
  presenter.createCandidate = async (...args) => { const candidate = await create(...args); candidate.fail = true; return candidate }
  await assert.rejects(presenter.submit(document(undefined, 2), { viewport, frameId: 8, configGeneration: 3 }), /candidate failed/)
  assert.equal(presenter.current, accepted)
  assert.equal(candidates[1].disposed, true)
  assert.equal(accepted.disposed, false)
  presenter.createCandidate = create
  await presenter.submit(document(undefined, 3), { viewport, frameId: 9, configGeneration: 3 })
  assert.equal(accepted.disposed, true)
  await assert.rejects(presenter.submit(document(undefined, 2), { viewport, frameId: 8, configGeneration: 3 }), /ERR_CANCELLED/)
  await assert.rejects(presenter.submit(document(undefined, 4), { viewport, frameId: 10, configGeneration: 2 }), /ERR_CANCELLED/)
  presenter.dispose(); assert.equal(presenter.current, null)
  assert.equal(candidates[2].disposed, true)
})

test('superseded asynchronous candidates release their resources without replacing the newer revision', async () => {
  const { presenter, candidates } = fakePresenter()
  let resolveImage, released = 0
  presenter.resolveResource = () => new Promise(resolve => { resolveImage = resolve })
  const firstDocument = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } })])
  firstDocument.resources = [resource('assets/pixel.png')]
  const first = presenter.submit(firstDocument, { viewport })
  const rejected = assert.rejects(first, /ERR_CANCELLED/)
  while (!resolveImage) await new Promise(resolve => setImmediate(resolve))
  await presenter.submit(document(undefined, 2), { viewport })
  resolveImage({ url: 'blob:late', release: () => released++ })
  await rejected
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(released, 1)
  assert.equal(candidates[0].disposed, true)
  assert.equal(presenter.current.plan.document.revision, 2)
  presenter.dispose()
})

test('native event policy is immediate and listener calls cross the host once per microtask batch', async () => {
  const { presenter, candidates, output } = fakePresenter()
  const node = element('root', 'view', { events: [binding('move', 'bubble', true, 'touchmove'), binding('tap')] })
  await presenter.submit(document([node]), { viewport })
  let stopped = 0, prevented = 0
  const native = { cancelable: true, stopPropagation() { stopped++ }, preventDefault() { prevented++ } }
  candidates[0].send('root', 'touchmove', { x: 5 }, native)
  candidates[0].send('root', 'tap', { x: 6 }, native)
  assert.equal(stopped, 1); assert.equal(prevented, 1); assert.equal(output.length, 0)
  await tick()
  assert.equal(output.length, 1); assert.equal(output[0].events.length, 2)
  assert.deepEqual(output[0].key, key())
  assert.match(output[0].epoch, /^[1-9][0-9]*$/)
  assert.deepEqual(output[0].events, [{ type: 'touchmove', targetOccurrenceId: 'root', detail: { x: 5 }, timeStamp: 0 }, { type: 'tap', targetOccurrenceId: 'root', detail: { x: 6 }, timeStamp: 0 }])
  presenter.dispose()
  candidates[0].send('root', 'tap', {}, native)
  await tick(); assert.equal(output.length, 1)
})

test('disabled button ancestors synchronously block descendant activation before event batching', async () => {
  const child = element('label', 'text', { events: [binding('childTap')] })
  const button = element('button', 'button', { typedAttrs: { disabled: true }, events: [binding('buttonTap')], children: [child] })
  const value = document([element('parent', 'view', { events: [binding('parentTap', 'capture')], children: [button] })])
  for (const type of ['tap', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'confirm']) {
    const planned = planDomEvent(value, 'label', type)
    assert.equal(planned.disabled, true); assert.deepEqual(planned.listeners, [])
  }
  const h = fakePresenter(); await h.presenter.submit(value, { viewport })
  let stopped = 0, prevented = 0
  const native = { cancelable: true, stopImmediatePropagation() { stopped++ }, preventDefault() { prevented++ } }
  h.candidates[0].send('label', 'tap', {}, native)
  h.candidates[0].send('label', 'touchstart', {}, native, { timeStamp: 1, touches: [touch(1, 0, 0)], changedTouches: [touch(1, 0, 0)] })
  assert.equal(stopped, 2); assert.equal(prevented, 2)
  await tick(); assert.deepEqual(h.output, [])
  await h.presenter.disposeAsync()
})

test('loading does not disable button events and typed false retains capture/catch and dataset ownership', async () => {
  const child = element('label', 'text', { typedAttrs: { 'data-value': 7 }, ownership: owner('slot-source'), events: [binding('child')] })
  const button = element('button', 'button', { attrs: { disabled: 'true' }, typedAttrs: { type: 'primary', disabled: false, loading: true, 'data-label': 'button' },
    ownership: owner('component'), events: [binding('buttonCatch', 'bubble', true)], children: [child] })
  const value = document([element('parent', 'view', { events: [binding('capture', 'capture')], children: [button] })])
  const planned = planDomEvent(value, 'label', 'tap')
  assert.notEqual(planned.disabled, true)
  assert.deepEqual(planned.listeners.map(listener => listener.handler), ['capture', 'child', 'buttonCatch'])
  assert.equal(planned.target.dataset.value, 7); assert.equal(planned.target.ownerScopeId, 'slot-source')
  assert.deepEqual(planned.listeners[2].currentTarget.dataset, { label: 'button' }, 'internal source-type/appearance markers never enter the IR dataset')
  const h = fakePresenter(); await h.presenter.submit(value, { viewport })
  let stopped = 0
  h.candidates[0].send('label', 'tap', {}, { stopPropagation() { stopped++ } })
  assert.equal(stopped, 1)
  await tick(); assert.equal(h.output.length, 1); assert.equal(h.output[0].events[0].targetOccurrenceId, 'label')
  await h.presenter.disposeAsync()
})

test('touch ownership facts include unbound start and move before bound end while unknown pointers remain absent', async () => {
  const { presenter, candidates, output } = fakePresenter(), contacts = new DomPointerContacts()
  await presenter.submit(document([element('root', 'view', { events: [binding('end', 'bubble', false, 'touchend')] })]), { viewport })
  const send = (type, event) => {
    const facts = contacts.update(type, event)
    if (facts) candidates[0].send('root', type, {}, event, facts)
  }
  send('touchmove', pointer(99, 1, 2, 1))
  send('touchstart', pointer(1, 10, 20, 2))
  send('touchmove', pointer(1, 11, 21, 3))
  send('touchend', pointer(1, 12, 22, 4))
  send('touchstart', pointer(2, 20, 30, 5))
  send('touchcancel', pointer(2, 21, 31, 6))
  send('touchmove', pointer(2, 22, 32, 7))
  candidates[0].send('root', 'tap', {})
  await tick()
  assert.equal(output.length, 1)
  assert.deepEqual(output[0].events.map(event => event.type), ['touchstart', 'touchmove', 'touchend', 'touchstart', 'touchcancel'])
  assert.deepEqual(output[0].events[0].touches, [touch(1, 10, 20)])
  assert.deepEqual(output[0].events[2].touches, [])
  assert.deepEqual(output[0].events[2].changedTouches, [touch(1, 12, 22)])
  assert.deepEqual(output[0].events[4].touches, [])
  assert.deepEqual(output[0].events[4].changedTouches, [touch(2, 21, 31)])
  presenter.dispose()
})

test('presentation keys use canonical u64 strings while ViewDocument v1 retains safe numeric identity', async () => {
  const { presenter } = fakePresenter()
  const value = document(), precise = key(value, '9007199254740993', '18446744073709551615')
  validateDomPresentationKey(precise, value)
  const candidate = await presenter.prepare(value, { viewport, presentationKey: precise })
  assert.deepEqual(candidate.preparation.key, precise)
  assert.ok(Object.isFrozen(candidate.preparation.key))
  assert.throws(() => { candidate.preparation.nodes[0].borderBox.width = 1 }, TypeError)
  presenter.confirm(presenter.commit(candidate, permit(candidate)))
  await assert.rejects(presenter.prepare(value, { viewport, presentationKey: { ...precise, presentationRevision: '9007199254740992' } }), /ERR_CANCELLED/)
  for (const field of ['pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration']) {
    for (const invalid of [1, '01', '-1', '1.0', '18446744073709551616']) assert.throws(() => validateDomPresentationKey({ ...precise, [field]: invalid }), /invalid presentation key/)
  }
  for (const field of ['pageId', 'revision']) {
    const unsafe = { ...value, [field]: 9007199254740992 }
    await assert.rejects(presenter.prepare(unsafe, { viewport, presentationKey: key(unsafe) }), /invalid ViewDocument/)
  }
  await assert.rejects(presenter.prepare(value, { viewport, presentationKey: { ...precise, pageId: '2' } }), /does not identify/)
  assert.throws(() => validateDomPresentationKey({ ...precise, handler: 'injected' }), /invalid presentation key fields/)
  presenter.dispose()
})

test('resource leases receive the complete frozen transaction key across equal-document surface attempts', async () => {
  const { presenter } = fakePresenter(), contexts = []
  const value = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } })])
  value.resources = [resource('assets/pixel.png')]
  presenter.resolveResource = (_descriptor, context) => { contexts.push(context); return { url: 'blob:transaction-asset', release() {} } }
  for (const presentationKey of [key(value, '9007199254740993', '8'), key(value, '9007199254740994', '9')]) {
    const candidate = await presenter.prepare(value, { viewport, presentationKey })
    const context = contexts.at(-1)
    assert.deepEqual(context.presentationKey, presentationKey)
    assert.notEqual(context.presentationKey, presentationKey)
    assert.ok(Object.isFrozen(context.presentationKey))
    assert.throws(() => { context.presentationKey.surfaceGeneration = '0' }, TypeError)
    presenter.abort(candidate)
  }
  assert.notDeepEqual(contexts[0].presentationKey, contexts[1].presentationKey)
  presenter.dispose()
})

test('runtime prepare, commit and confirm retain the prior lease and pause all application events', async () => {
  const { presenter, candidates, output } = fakePresenter()
  const value = document([element('root', 'view', { events: [binding('tap')] })])
  await presenter.submit(value, { viewport })
  const previous = candidates[0]
  const next = await presenter.prepare({ ...value, revision: 2 }, { viewport, presentationKey: key({ ...value, revision: 2 }) })
  assert.equal(next.state, 'prepared')
  assert.equal(previous.visible, true); assert.equal(previous.interactive, false); assert.equal(previous.disposed, false)
  previous.send('root', 'tap', {})
  await tick(); assert.equal(output.length, 0)
  const receipt = presenter.commit(next, permit(next)), candidate = candidates[1]
  assert.equal(next.state, 'committed'); assert.equal(receipt.phase, 'committed')
  assert.equal(previous.visible, false); assert.equal(previous.disposed, false)
  assert.equal(candidate.visible, true); assert.equal(candidate.interactive, false)
  candidate.send('root', 'tap', {})
  assert.throws(() => presenter.confirm({ ...receipt, permitId: 'forged' }), /does not identify/)
  assert.throws(() => presenter.confirm({ ...receipt, commitId: 'old-commit' }), /does not identify/)
  await tick(); assert.equal(output.length, 0); assert.equal(candidate.interactive, false)
  presenter.confirm(receipt)
  assert.equal(previous.disposeCount, 1); assert.equal(candidate.interactive, true)
  assert.equal(presenter.confirm(receipt), receipt); assert.equal(previous.disposeCount, 1)
  candidate.send('root', 'tap', { safe: true })
  await tick(); assert.equal(output.length, 1)
  assert.deepEqual(output[0].events, [{ type: 'tap', targetOccurrenceId: 'root', detail: { safe: true }, timeStamp: 0 }])
  assert.deepEqual(output[0].key, next.preparation.key)
  assert.equal(output[0].epoch, next.preparation.epoch)
  presenter.dispose()
})

test('aborting prepared or unconfirmed committed candidates restores the accepted surface', async () => {
  const { presenter, candidates, output } = fakePresenter()
  const value = document([element('root', 'view', { events: [binding('tap')] })])
  await presenter.submit(value, { viewport })
  for (const committed of [false, true]) {
    const nextValue = { ...value, revision: 2 }
    const candidate = await presenter.prepare(nextValue, { viewport, presentationKey: key(nextValue) })
    const target = committed ? presenter.commit(candidate, permit(candidate)) : candidate
    assert.equal(presenter.abort(target), true)
    assert.equal(presenter.abort(target), false)
    assert.equal(candidate.state, 'aborted')
    assert.equal(presenter.current, candidates[0]); assert.equal(candidates[0].visible, true); assert.equal(candidates[0].interactive, true)
    assert.equal(candidates.at(-1).disposeCount, 1)
    candidates[0].send('root', 'tap', {})
    await tick()
  }
  assert.equal(output.length, 2)
  presenter.dispose()
})

test('wrong permits, stale handles and post-prepare layout drift cannot activate a candidate', async () => {
  const { presenter, candidates } = fakePresenter()
  await presenter.submit(document(), { viewport })
  const value = document(undefined, 2), candidate = await presenter.prepare(value, { viewport, presentationKey: key(value) })
  const valid = permit(candidate)
  for (const invalid of [{ ...valid, version: '2.0' }, { ...valid, epoch: '0' }, { ...valid, permitId: '' }, { ...valid, key: { ...valid.key, surfaceGeneration: '1' } }, { ...valid, ownerScopeId: 'forged' }]) {
    assert.throws(() => presenter.commit(candidate, invalid), /ERR_RENDER/)
    assert.equal(candidates[1].visible, false); assert.equal(candidates[0].disposed, false)
  }
  candidates[1].geometry = [{ occurrenceId: 'root', x: 0, y: 0, width: 121, height: 30 }]
  assert.throws(() => presenter.commit(candidate, valid), /geometry changed/)
  presenter.abort(candidate)
  assert.throws(() => presenter.commit(candidate, valid), /ERR_CANCELLED/)
  assert.equal(candidates[0].interactive, true)
  presenter.dispose()
})

test('scroll and native input notify complete geometry without application listeners', async () => {
  const { presenter, candidates, geometries, output } = fakePresenter()
  await presenter.submit(document(), { viewport })
  await tick()
  const initial = geometries[0], candidate = candidates[0]
  assert.equal(initial.nodes[0].scrollExtent.height, 300)
  assert.equal(initial.nodes[0].clientSize.height, 30)
  candidate.geometry = [{ occurrenceId: 'root', x: 0, y: 0, width: 120, height: 30, scrollLeft: 4, scrollTop: 70, scrollWidth: 240, scrollHeight: 300, clientWidth: 120, clientHeight: 30 }]
  candidate.send('root', 'scroll', { scrollTop: 70 })
  candidate.send('root', 'input', { value: 'native' })
  await tick()
  assert.equal(geometries.length, 2); assert.equal(output.length, 0)
  assert.ok(BigInt(geometries[1].epoch) > BigInt(initial.epoch))
  assert.deepEqual(geometries[1].nodes[0].scrollOffset, { x: 4, y: 70 })
  assert.deepEqual(geometries[1].key, key())
  candidate.changed(); await tick(); assert.equal(geometries.length, 2)
  candidate.send('root', 'input', { value: 'changed-with-same-layout' })
  await tick(); assert.equal(geometries.length, 3)
  presenter.dispose()
})

test('input dispatch waits for geometry admission, and failed geometry transport keeps input blocked', async () => {
  const admission = deferred(), batches = [], geometry = []
  const { presenter, candidates } = fakePresenter({ onGeometry: batch => { geometry.push(batch); return admission.promise }, onEventBatch: batch => batches.push(batch) })
  await presenter.submit(document([element('root', 'input', { events: [binding('edit', 'bubble', false, 'input')] })]), { viewport })
  candidates[0].send('root', 'input', { value: 'typed' })
  await tick(); assert.equal(batches.length, 0)
  admission.resolve(); await tick()
  assert.equal(batches.length, 1); assert.equal(batches[0].epoch, geometry.at(-1).epoch)
  presenter.onGeometry = async () => { throw new Error('geometry rejected') }
  candidates[0].send('root', 'input', { value: 'blocked' })
  await tick()
  assert.equal(batches.length, 1); assert.equal(candidates[0].interactive, false)
  assert.match(presenter.errors.at(-1).message, /geometry rejected/)
  candidates[0].send('root', 'input', { value: 'still-blocked' }); await tick(); assert.equal(batches.length, 1)
  presenter.dispose()
})

test('ACK then failed predecessor cleanup retains the new image beyond its timer and external abort', async () => {
  const { presenter, candidates, output } = fakePresenter({ timeoutMs: 30 })
  await presenter.submit(document(), { viewport })
  const disposePrevious = candidates[0].dispose
  candidates[0].dispose = () => { disposePrevious(); throw new Error('lease release failed') }
  const value = document([element('root', 'view', { events: [binding('tap')] })], 2)
  const controller = new AbortController()
  const candidate = await presenter.prepare(value, { viewport, presentationKey: key(value), signal: controller.signal })
  const receipt = presenter.commit(candidate, permit(candidate))
  assert.throws(() => presenter.confirm(receipt), /previous surface cleanup failed/)
  assert.equal(candidates[0].disposed, true); assert.equal(candidates[1].interactive, false)
  candidates[1].send('root', 'tap', {}); await tick(); assert.equal(output.length, 0)
  assert.throws(() => presenter.confirm(receipt), /previous surface cleanup failed/)
  assert.equal(candidate.state, 'confirmed'); assert.equal(presenter.transaction, null)
  assert.equal(presenter.abort(candidate), false)
  controller.abort()
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(presenter.current, candidates[1]); assert.equal(candidates[1].disposeCount, 0)
  assert.equal(candidates[1].visible, true); assert.equal(candidates[1].interactive, false)
  presenter.dispose()
  assert.equal(candidates[1].disposeCount, 1)
})

test('slow geometry retains only in-flight and latest batches and admits input without chasing future updates', async () => {
  const gates = [], geometries = [], batches = []
  const { presenter, candidates } = fakePresenter({
    onGeometry: batch => { const gate = deferred(); gates.push(gate); geometries.push(batch); return gate.promise },
    onEventBatch: batch => batches.push(batch),
  })
  await presenter.submit(document([element('root', 'input', { events: [binding('edit', 'bubble', false, 'input')] })]), { viewport })
  await tick()
  const entry = presenter.currentEntry, candidate = candidates[0], inFlight = entry.geometryInFlight
  let pending
  for (let index = 1; index <= 100; index++) {
    candidate.geometry = [{ occurrenceId: 'root', x: 0, y: index, width: 120, height: 30 }]
    candidate.send('root', 'input', { value: index })
    await tick()
    assert.equal(entry.geometryInFlight, inFlight)
    pending ??= entry.geometryPending
    assert.equal(entry.geometryPending, pending, 'all pending measurements replace one latest job')
    assert.equal(geometries.length, 1)
  }
  assert.equal(pending.events.length, 100)
  gates[0].resolve({ ok: true }); await tick()
  assert.equal(geometries.length, 2); assert.equal(entry.geometryInFlight, pending)
  assert.equal(geometries[1].nodes[0].borderBox.y, 100)
  for (let index = 101; index <= 200; index++) {
    candidate.geometry = [{ occurrenceId: 'root', x: 0, y: index, width: 120, height: 30 }]
    candidate.changed(); await tick()
  }
  assert.equal(geometries.length, 2); assert.equal(batches.length, 0)
  gates[1].resolve({ ok: true }); await tick()
  assert.equal(batches.length, 1); assert.equal(batches[0].events.length, 100)
  assert.equal(batches[0].epoch, geometries[1].epoch, 'input binds the admitted job, not future scroll geometry')
  assert.equal(geometries.length, 3); assert.equal(geometries[2].nodes[0].borderBox.y, 200)
  gates[2].resolve({ ok: true }); await tick()
  assert.equal(entry.geometryInFlight, null); assert.equal(entry.geometryPending, null)
  assert.equal(presenter.errors.length, 0)
  presenter.dispose()
})

test('discarded local geometry stops its associated event batch without reporting an overlay', async () => {
  const gate = deferred(), batches = []
  const { presenter, candidates } = fakePresenter({ onGeometry: () => gate.promise, onEventBatch: batch => batches.push(batch) })
  await presenter.submit(document([element('root', 'input', { events: [binding('edit', 'bubble', false, 'input')] })]), { viewport })
  candidates[0].send('root', 'input', { value: 'retired' })
  await tick()
  gate.resolve({ discarded: true, source: 'local-retirement' }); await tick()
  assert.equal(batches.length, 0); assert.equal(candidates[0].interactive, false); assert.equal(presenter.errors.length, 0)
  presenter.dispose()
})

test('event overflow freezes explicitly before exceeding the runtime wire batch budget', async () => {
  const { presenter, candidates, output } = fakePresenter()
  await presenter.submit(document([element('root', 'view')]), { viewport })
  for (let index = 0; index < 257; index++) candidates[0].send('root', 'touchstart', { pointerId: index })
  await tick()
  assert.equal(candidates[0].interactive, false); assert.equal(presenter.eventQueue.length, 0); assert.equal(output.length, 0)
  assert.match(presenter.errors.at(-1).message, /event batch budget exceeded/)
  presenter.dispose()

  const gate = deferred(), slow = fakePresenter({ onGeometry: () => gate.promise })
  await slow.presenter.submit(document([element('root', 'input', { events: [binding('edit', 'bubble', false, 'input')] })]), { viewport })
  for (let index = 0; index < 200; index++) slow.candidates[0].send('root', 'input', { value: index })
  await tick()
  assert.equal(slow.presenter.currentEntry.geometryPending.events.length, 200)
  for (let index = 0; index < 100; index++) slow.candidates[0].send('root', 'input', { value: index + 200 })
  await tick()
  assert.equal(slow.candidates[0].interactive, false)
  assert.equal(slow.presenter.currentEntry.geometryPending.events.length, 0)
  gate.resolve({ ok: true }); await tick()
  assert.equal(slow.output.length, 0)
  assert.match(slow.presenter.errors.at(-1).message, /event batch budget exceeded/)
  slow.presenter.dispose()
})

test('authoritative ACK can retain the committed image while keeping native input frozen', async () => {
  const { presenter, candidates, output, geometries } = fakePresenter({ timeoutMs: 30 })
  await presenter.submit(document(), { viewport })
  await tick()
  const value = document([element('root', 'view', { events: [binding('tap')] })], 2)
  const candidate = await presenter.prepare(value, { viewport, presentationKey: key(value) })
  const receipt = presenter.commit(candidate, permit(candidate)), before = geometries.length
  presenter.confirm(receipt, { inputEnabled: false })
  assert.equal(candidate.state, 'confirmed'); assert.equal(candidates[1].visible, true)
  assert.equal(candidates[1].interactive, false); assert.equal(candidates[0].disposeCount, 1)
  assert.equal(presenter.abort(candidate), false)
  presenter.confirm(receipt)
  candidates[1].send('root', 'tap', {})
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(presenter.current, candidates[1]); assert.equal(output.length, 0); assert.equal(geometries.length, before)
  presenter.dispose()
})

test('snapshot or activation exceptions clear transaction ownership and retain accepted state', async () => {
  const { presenter, candidates } = fakePresenter()
  await presenter.submit(document(), { viewport })
  candidates[0].snapshotFailure = true
  const value = document(undefined, 2)
  await assert.rejects(presenter.prepare(value, { viewport, presentationKey: key(value) }), /snapshot failed/)
  assert.equal(presenter.pending, null); assert.equal(candidates[0].interactive, true)
  candidates[0].snapshotFailure = false
  const next = await presenter.prepare(value, { viewport, presentationKey: key(value) })
  candidates[1].activationFailure = true
  assert.throws(() => presenter.commit(next, permit(next)), /activation failed/)
  assert.equal(presenter.pending, null); assert.equal(presenter.transaction, null)
  assert.equal(candidates[0].interactive, true); assert.equal(candidates[1].disposeCount, 1)
  presenter.dispose()
})

test('native control state is retained only within the accepted session and page', async () => {
  const { presenter, candidates } = fakePresenter()
  await presenter.submit(document(), { viewport })
  const nativeState = new Map([['root', { value: 'uncommitted-edit', scrollTop: 50 }]])
  candidates[0].snapshotValue = nativeState
  const samePage = document(undefined, 2)
  const retained = await presenter.prepare(samePage, { viewport, presentationKey: key(samePage) })
  assert.equal(candidates.at(-1).restored, nativeState)
  presenter.abort(retained)
  for (const value of [{ ...samePage, pageId: 2 }, { ...samePage, sessionId: 'new-session' }]) {
    const isolated = await presenter.prepare(value, { viewport, presentationKey: key(value) })
    assert.equal(candidates.at(-1).restored, undefined)
    presenter.abort(isolated)
  }
  const otherPage = { ...samePage, pageId: 2 }
  const unconfirmed = await presenter.prepare(otherPage, { viewport, presentationKey: key(otherPage) })
  presenter.commit(unconfirmed, permit(unconfirmed))
  const replacement = await presenter.prepare(otherPage, { viewport, presentationKey: key(otherPage) })
  assert.equal(candidates.at(-1).restored, undefined)
  assert.equal(unconfirmed.state, 'aborted')
  presenter.abort(replacement)
  presenter.dispose()
})

test('external abort, deadline and disconnected candidates never replace the accepted presentation', async () => {
  const { presenter, candidates } = fakePresenter({ timeoutMs: 30 })
  await presenter.submit(document(), { viewport })
  const value = document(undefined, 2), controller = new AbortController()
  const first = await presenter.prepare(value, { viewport, presentationKey: key(value), signal: controller.signal })
  controller.abort()
  assert.equal(first.state, 'aborted'); assert.equal(candidates[0].interactive, true)
  const next = await presenter.prepare(value, { viewport, presentationKey: key(value) })
  presenter.commit(next, permit(next))
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(next.state, 'aborted'); assert.equal(presenter.current, candidates[0])
  const disconnected = await presenter.prepare(value, { viewport, presentationKey: key(value) })
  candidates.at(-1).connected = false
  assert.throws(() => presenter.commit(disconnected, permit(disconnected)), /ERR_CANCELLED/)
  presenter.abort(disconnected); assert.equal(candidates[0].interactive, true)
  presenter.dispose()
})

test('late candidate creation is disposed once after supersession and shutdown clears pending leases', async () => {
  const { presenter, candidates } = fakePresenter()
  const create = presenter.createCandidate, delayed = deferred()
  presenter.createCandidate = async () => delayed.promise
  const preparing = presenter.prepare(document(), { viewport, presentationKey: key() })
  const rejected = assert.rejects(preparing, /ERR_CANCELLED/)
  presenter.dispose()
  const late = await create(); delayed.resolve(late)
  await rejected; await tick()
  assert.equal(late.disposeCount, 1); assert.equal(presenter.pending, null)
  assert.equal(candidates.length, 1)
})

const pointer = (pointerId, clientX, clientY, timeStamp = 10) => ({ pointerId, clientX, clientY, pageX: clientX + 2, pageY: clientY + 3, timeStamp })
const touch = (identifier, x, y) => ({ identifier, x, y, clientX: x, clientY: y, pageX: x + 2, pageY: y + 3 })

test('candidate pointer facts retain simultaneous contacts and correctly distinguish end from changed touches', () => {
  const contacts = new DomPointerContacts()
  const first = contacts.update('touchstart', pointer(7, 20, 30, 11))
  assert.deepEqual(first, { timeStamp: 11, touches: [touch(7, 20, 30)], changedTouches: [touch(7, 20, 30)] })
  const second = contacts.update('touchstart', pointer(9, 40, 50, 12))
  assert.deepEqual(second.touches, [touch(7, 20, 30), touch(9, 40, 50)])
  assert.deepEqual(second.changedTouches, [touch(9, 40, 50)])
  const moved = contacts.update('touchmove', pointer(7, 25, 35, 13))
  assert.deepEqual(moved.touches, [touch(7, 25, 35), touch(9, 40, 50)])
  assert.deepEqual(moved.changedTouches, [touch(7, 25, 35)])
  assert.deepEqual(first.touches, [touch(7, 20, 30)], 'previous wire batches remain immutable snapshots')
  const ended = contacts.update('touchend', pointer(7, 27, 37, 14))
  assert.deepEqual(ended.touches, [touch(9, 40, 50)])
  assert.deepEqual(ended.changedTouches, [touch(7, 27, 37)])
  const cancelled = contacts.update('touchcancel', pointer(9, 44, 54, 15))
  assert.deepEqual(cancelled.touches, [])
  assert.deepEqual(cancelled.changedTouches, [touch(9, 44, 54)])
  assert.deepEqual(contacts.update('input', { timeStamp: 16 }), { timeStamp: 16 })
})

test('freezing a candidate clears contact state and isolates the next candidate or gesture', () => {
  const current = new DomPointerContacts(), next = new DomPointerContacts()
  current.update('touchstart', pointer(1, 1, 2))
  assert.equal(next.update('touchend', pointer(1, 2, 3)), null)
  current.clear()
  assert.equal(current.update('touchmove', pointer(1, 3, 4)), null)
  assert.equal(current.update('touchend', pointer(1, 4, 5)), null)
  assert.equal(current.update('touchcancel', pointer(1, 5, 6)), null)
  assert.deepEqual(current.update('touchstart', pointer(2, 7, 8)).touches, [touch(2, 7, 8)])
  assert.deepEqual(next.update('touchstart', pointer(3, 9, 10)).touches, [touch(3, 9, 10)])
  current.clear(); next.clear()
  assert.equal(current.contacts.size, 0); assert.equal(next.contacts.size, 0)
})

test('browser fact validation rejects nonfinite, unsafe, duplicate or authority-bearing data', async () => {
  const valid = { timeStamp: 1.25, touches: [touch(1, 2, 3)], changedTouches: [touch(1, 2, 3)] }
  assert.deepEqual(validateDomInputFacts(valid), valid)
  for (const invalid of [{ ...valid, timeStamp: NaN }, { ...valid, timeStamp: Infinity }, { ...valid, timeStamp: '1' },
    { ...valid, handler: 'forged' }, { ...valid, ownerScopeId: 'forged' }, { ...valid, touches: null },
    { ...valid, touches: [...valid.touches, ...valid.touches] }, { ...valid, changedTouches: [{ ...touch(1, 2, 3), path: ['root'] }] }]) assert.throws(() => validateDomInputFacts(invalid), /ERR_RENDER/)
  for (const field of ['identifier', 'x', 'y', 'clientX', 'clientY', 'pageX', 'pageY']) assert.throws(() => validateDomInputFacts({ ...valid, touches: [{ ...touch(1, 2, 3), [field]: Infinity }] }), /ERR_RENDER/)
  assert.throws(() => validateDomInputFacts({ ...valid, touches: [{ ...touch(1, 2, 3), identifier: 9007199254740992 }] }), /ERR_RENDER/)
  const contacts = new DomPointerContacts()
  assert.throws(() => contacts.update('touchstart', pointer(9007199254740992, 2, 3)), /ERR_RENDER/)
  assert.equal(contacts.contacts.size, 0)
  contacts.update('touchstart', pointer(1, 2, 3))
  assert.throws(() => contacts.update('touchstart', pointer(1, 4, 5)), /duplicate active pointer/)
  assert.deepEqual(contacts.update('touchend', pointer(1, 6, 7)).touches, [])

  const { presenter, candidates, output } = fakePresenter()
  await presenter.submit(document([element('root', 'view', { events: [binding('touch', 'bubble', false, 'touchstart')] })]), { viewport })
  const facts = { timeStamp: 17, touches: [touch(2, 10, 20)], changedTouches: [touch(2, 10, 20)] }
  candidates[0].send('root', 'touchstart', { x: 10, y: 20 }, {}, facts)
  facts.touches[0].x = 999
  await tick()
  assert.deepEqual(output[0].events[0], { type: 'touchstart', targetOccurrenceId: 'root', detail: { x: 10, y: 20 }, timeStamp: 17, touches: [touch(2, 10, 20)], changedTouches: [touch(2, 10, 20)] })
  assert.throws(() => candidates[0].send('root', 'touchstart', {}, {}, { ...facts, timeStamp: NaN }), /timeStamp must be finite/)
  presenter.dispose()
})


// Strong-release contract candidates: authored here, executed only by root.
test('plan preserves synchronous disposal while sharing an exact asynchronous lease barrier', async () => {
  const releasing = deferred(), value = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } })])
  value.resources = [resource('assets/pixel.png')]
  let releases = 0
  const plan = await prepareDomDocument(value, viewport, { resolveResource: () => ({ url: 'blob:owned', release() { releases++; return releasing.promise } }) })
  assert.deepEqual(plan.dispose(), [])
  const drain = plan.disposeAsync()
  assert.equal(plan.disposeAsync(), drain)
  assert.deepEqual(plan.dispose(), [])
  let settled = false; drain.then(() => { settled = true }, () => { settled = true })
  await tick(); assert.equal(settled, false); assert.equal(releases, 1)
  const rejected = assert.rejects(drain, failure => failure.code === 'ERR_RENDER' && failure.cleanupErrors.some(value => /lease denied/.test(value)))
  releasing.reject(new Error('lease denied')); await rejected
  assert.equal(releases, 1)
})

test('versioned release owns exact candidate handles and publishes one reentrant once-only barrier', async () => {
  const h = fakePresenter(), other = fakePresenter()
  const handle = await h.presenter.prepare(document(), { viewport, presentationKey: key() })
  assert.deepEqual(h.presenter.candidateReleaseContract(), { version: '1.0', exactHandle: true, pendingAcquisitions: true, asynchronousDisposal: true, asynchronousConfirmation: true, asynchronousShutdown: true })
  assert.equal(Object.isFrozen(h.presenter.candidateReleaseContract()), true)
  await assert.rejects(h.presenter.releaseCandidate({ ...handle }), /exact owned/)
  await assert.rejects(other.presenter.releaseCandidate(handle), /exact owned/)
  await assert.rejects(h.presenter.releaseCandidate(handle, { timeoutMs: 0 }), /invalid DOM release timeout/)
  let reentrant
  const dispose = h.candidates[0].dispose
  h.candidates[0].dispose = () => { reentrant = h.presenter.releaseCandidate(handle); return dispose() }
  const release = h.presenter.releaseCandidate(handle)
  assert.equal(reentrant, release); assert.equal(h.presenter.releaseCandidate(handle), release)
  assert.deepEqual(await release, { version: '1.0', handle, key: key(), status: 'released', cleanupPending: false })
  assert.equal(h.candidates[0].disposeCount, 1)
  await h.presenter.disposeAsync(); await other.presenter.disposeAsync()
})

test('boolean legacy abort retains synchronous cleanup errors for a later strict drain', async () => {
  const h = fakePresenter(), handle = await h.presenter.prepare(document(), { viewport, presentationKey: key() })
  h.candidates[0].cleanupErrors = ['sync disposer failure']
  assert.equal(h.presenter.abort(handle), true); assert.equal(h.presenter.abort(handle), false)
  await assert.rejects(h.presenter.releaseCandidate(handle), failure => failure.code === 'ERR_RENDER' && failure.cleanupErrors.some(value => /sync disposer failure/.test(value)))
  await assert.rejects(h.presenter.drainCandidate(handle), /candidate cleanup failed/)
  assert.equal(h.candidates[0].disposeCount, 1)
  await assert.rejects(h.presenter.disposeAsync(), /shutdown cleanup failed/)
})

test('release waits the actual late candidate acquisition and observes its asynchronous disposer failure', async () => {
  const h = fakePresenter(), creating = deferred(), disposed = deferred()
  let releases = 0
  h.presenter.createCandidate = () => creating.promise
  const preparing = h.presenter.prepare(document(), { viewport, presentationKey: key() })
  const handle = h.presenter.pending.handle, failedPrepare = assert.rejects(preparing, /ERR_CANCELLED/)
  h.presenter.abort(handle); await failedPrepare
  const releasing = h.presenter.releaseCandidate(handle), failedRelease = assert.rejects(releasing, /candidate cleanup failed/)
  let settled = false; releasing.catch(() => { settled = true })
  await tick(); assert.equal(settled, false)
  creating.resolve({ dispose() { releases++; return disposed.promise } })
  await tick(); assert.equal(releases, 1); assert.equal(settled, false)
  disposed.reject(new Error('late candidate dispose failed')); await failedRelease
  await assert.rejects(h.presenter.drainCandidate(handle), failure => failure.cleanupErrors.some(value => /late candidate dispose failed/.test(value)))
  assert.equal(releases, 1); await assert.rejects(h.presenter.disposeAsync(), /shutdown cleanup failed/)
})

test('release tracks a late resource lease and propagates its real asynchronous revocation failure', async () => {
  const acquiring = deferred(), revoking = deferred(), started = deferred(), h = fakePresenter({ resolveResource: () => { started.resolve(); return acquiring.promise } })
  const value = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } })]); value.resources = [resource('assets/pixel.png')]
  const preparing = h.presenter.prepare(value, { viewport, presentationKey: key(value) })
  await started.promise
  const handle = h.presenter.pending.handle, failedPrepare = assert.rejects(preparing, /ERR_CANCELLED/)
  h.presenter.abort(handle); await failedPrepare
  let releases = 0
  const failedRelease = assert.rejects(h.presenter.releaseCandidate(handle), /candidate cleanup failed/)
  acquiring.resolve({ url: 'blob:late', release() { releases++; return revoking.promise } })
  await tick(); assert.equal(releases, 1)
  revoking.reject(new Error('late lease revocation failed')); await failedRelease
  await assert.rejects(h.presenter.drainCandidate(handle), failure => failure.cleanupErrors.some(value => /late lease revocation failed/.test(value)))
  assert.equal(releases, 1); await assert.rejects(h.presenter.disposeAsync(), /shutdown cleanup failed/)
})

test('an original population operation is included in strict release even after local cancellation', async () => {
  const h = fakePresenter(), populate = deferred(), started = deferred(), create = h.presenter.createCandidate.bind(h.presenter)
  h.presenter.createCandidate = async (...args) => {
    const candidate = await create(...args)
    candidate.populate = plan => { candidate.plan = plan; started.resolve(); return populate.promise }
    return candidate
  }
  const preparing = h.presenter.prepare(document(), { viewport, presentationKey: key() })
  await started.promise
  const handle = h.presenter.pending.handle, failedPrepare = assert.rejects(preparing, /ERR_CANCELLED/)
  h.presenter.abort(handle); await failedPrepare
  const release = h.presenter.releaseCandidate(handle)
  let settled = false; release.then(() => { settled = true })
  await tick(); assert.equal(settled, false)
  populate.resolve(); assert.equal((await release).cleanupPending, false)
  assert.equal(h.candidates[0].disposeCount, 1); await h.presenter.disposeAsync()
})

test('bounded release timeout stays rejected while the actual late drain remains observable', async () => {
  const h = fakePresenter(), creating = deferred(), cleanup = deferred()
  h.presenter.createCandidate = () => creating.promise
  const preparing = h.presenter.prepare(document(), { viewport, presentationKey: key() })
  const handle = h.presenter.pending.handle, failedPrepare = assert.rejects(preparing, /ERR_CANCELLED/)
  h.presenter.abort(handle); await failedPrepare
  const release = h.presenter.releaseCandidate(handle, { timeoutMs: 10 })
  await assert.rejects(release, failure => failure.code === 'ERR_TIMEOUT' && failure.releaseOutcome.handle === handle && failure.releaseOutcome.cleanupPending === true)
  assert.equal(h.presenter.releaseCandidate(handle), release)
  const drained = assert.rejects(h.presenter.drainCandidate(handle), /candidate cleanup failed/)
  creating.resolve({ dispose: () => cleanup.promise }); await tick()
  cleanup.reject(new Error('failed after timeout')); await drained
  await assert.rejects(release, failure => failure.code === 'ERR_TIMEOUT')
  await assert.rejects(h.presenter.disposeAsync(), /shutdown cleanup failed/)
})

test('strict confirmation awaits predecessor lease release before input and initial geometry admission', async () => {
  const revoking = deferred(), h = fakePresenter({ resolveResource: () => ({ url: 'blob:previous', release: () => revoking.promise }) })
  const first = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } })]); first.resources = [resource('assets/pixel.png')]
  const firstHandle = await h.presenter.prepare(first, { viewport, presentationKey: key(first) })
  await h.presenter.confirmAsync(h.presenter.commit(firstHandle, permit(firstHandle)))
  await h.presenter.currentEntry.geometryBarrier
  const handle = await h.presenter.prepare(document(undefined, 2), { viewport, presentationKey: key(document(undefined, 2)) })
  const receipt = h.presenter.commit(handle, permit(handle)), before = h.geometries.length
  await assert.rejects(h.presenter.confirmAsync({ ...receipt }), /exact committed receipt/)
  const confirming = h.presenter.confirmAsync(receipt)
  assert.equal(h.presenter.confirmAsync(receipt), confirming)
  await tick(); assert.equal(h.candidates[1].interactive, false); assert.equal(h.geometries.length, before)
  revoking.resolve(); const result = await confirming
  assert.equal(result.handle, handle); assert.equal(result.receipt, receipt); assert.equal(result.inputEnabled, true)
  assert.equal(h.candidates[1].interactive, true); assert.ok(h.geometries.length > before)
  await h.presenter.disposeAsync()
})

test('predecessor cleanup failure cannot undo an ACK and keeps the new confirmed pixels noninteractive', async () => {
  const h = fakePresenter()
  const first = await h.presenter.prepare(document(), { viewport, presentationKey: key() })
  await h.presenter.confirmAsync(h.presenter.commit(first, permit(first)))
  h.candidates[0].cleanupErrors = ['previous cleanup failed']
  const next = await h.presenter.prepare(document(undefined, 2), { viewport, presentationKey: key(document(undefined, 2)) })
  const receipt = h.presenter.commit(next, permit(next))
  await assert.rejects(h.presenter.confirmAsync(receipt), /cleanup failed/)
  assert.equal(next.state, 'confirmed'); assert.equal(h.presenter.current, h.candidates[1])
  assert.equal(h.candidates[1].visible, true); assert.equal(h.candidates[1].interactive, false)
  assert.equal(h.presenter.abort(next), false)
  await assert.rejects(h.presenter.disposeAsync(), /shutdown cleanup failed/)
})

test('async shutdown is stable under reentrant disposal and exposes the actual post-timeout failure', async () => {
  const h = fakePresenter(), gate = deferred()
  const handle = await h.presenter.prepare(document(), { viewport, presentationKey: key() })
  const dispose = h.candidates[0].dispose
  let reentrant
  h.candidates[0].dispose = () => { reentrant = h.presenter.disposeAsync(); dispose(); return gate.promise }
  const closing = h.presenter.disposeAsync({ timeoutMs: 10 })
  assert.equal(reentrant, closing); assert.equal(h.presenter.disposeAsync(), closing)
  await assert.rejects(closing, failure => failure.code === 'ERR_TIMEOUT' && failure.releaseOutcome.cleanupPending === true)
  const failed = assert.rejects(h.presenter.drainDisposal(), /shutdown cleanup failed/)
  gate.reject(new Error('shutdown lease failed')); await failed
  await assert.rejects(closing, failure => failure.code === 'ERR_TIMEOUT')
  assert.equal(h.candidates[0].disposeCount, 1)
  await assert.rejects(h.presenter.drainCandidate(handle), /candidate cleanup failed/)
})

test('invalid asynchronous disposer result is a failed barrier rather than cleanup success', async () => {
  const h = fakePresenter(), handle = await h.presenter.prepare(document(), { viewport, presentationKey: key() })
  const dispose = h.candidates[0].dispose
  h.candidates[0].dispose = () => { dispose(); return Promise.resolve({ ok: true }) }
  await assert.rejects(h.presenter.releaseCandidate(handle), failure => failure.code === 'ERR_RENDER' && failure.cleanupErrors.some(value => /disposer must return/.test(value)))
  await assert.rejects(h.presenter.disposeAsync(), /shutdown cleanup failed/)
})


// The real built-in browser candidate runs against an owned DOM/RAF shim.
// These are unit contracts, not real-browser evidence or GPU acceptance.
function ownedBrowserProvider({ decode = () => Promise.resolve(), fonts = Promise.resolve() } = {}) {
  const images = [], requested = new Map(), canceled = [], allFrames = [], documentListeners = new Map()
  let rafSequence = 0, fontsObserved = 0
  const node = tag => {
    const events = new Map(), value = { nodeType: 1, tagName: tag.toUpperCase(), style: {}, attrs: new Map(), children: [], isConnected: true,
      setAttribute(name, content) { value.attrs.set(name, content) },
      removeAttribute(name) { value.attrs.delete(name); if (name === 'src') value.src = '' },
      append(...children) { value.children.push(...children) },
      addEventListener(name, listener) { const list = events.get(name) ?? []; list.push(listener); events.set(name, list) },
      removeEventListener(name, listener) { events.set(name, (events.get(name) ?? []).filter(value => value !== listener)) },
      dispatch(name) { for (const listener of [...(events.get(name) ?? [])]) listener() },
      remove() { value.removeCount = (value.removeCount ?? 0) + 1; value.isConnected = false },
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
      focus() { browserDocument.activeElement = value },
    }
    if (tag === 'img') { value.decode = () => decode(value); images.push(value) }
    return value
  }
  const browserDocument = { head: node('head'), body: node('body'), fonts: { get ready() { fontsObserved++; return fonts } }, createElement: node,
    createTextNode: text => ({ nodeType: 3, textContent: text }), querySelector() {},
    createRange: () => ({ selectNodeContents() {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 80, height: 20 }) }),
    addEventListener(name, listener) { const list = documentListeners.get(name) ?? []; list.push(listener); documentListeners.set(name, list) },
    removeEventListener(name, listener) { documentListeners.set(name, (documentListeners.get(name) ?? []).filter(value => value !== listener)) } }
  const browserWindow = { CSS: { supports: () => true },
    requestAnimationFrame(callback) { const id = ++rafSequence; requested.set(id, callback); return id },
    cancelAnimationFrame(id) { canceled.push(id); requested.delete(id) },
  }
  const ownerDocument = { createElement(tag) {
    assert.equal(tag, 'iframe')
    const frame = node('iframe'); frame.contentDocument = browserDocument; frame.contentWindow = browserWindow; allFrames.push(frame); return frame
  } }
  const container = { ownerDocument, isConnected: true, append(frame) { queueMicrotask(() => frame.dispatch('load')) } }
  return { container, images, requested, canceled, allFrames, browserDocument, browserWindow,
    dispatchNative(name, event) { for (const listener of [...(documentListeners.get(name) ?? [])]) listener(event) },
    get fontsObserved() { return fontsObserved } }
}

async function untilOwned(predicate) {
  for (let turn = 0; turn < 100; turn++) { if (predicate()) return; await tick() }
  assert.fail('owned provider did not reach expected phase')
}

test('built-in query sampling reads actual iframe viewport scroll and never reuses input geometry', async t => {
  const owned = ownedBrowserProvider(), presenter = new DomViewPresenter(owned.container, { timeoutMs: 500 })
  t.after(() => presenter.disposeAsync())
  const preparing = presenter.prepare(document(), { viewport, presentationKey: key() })
  await untilOwned(() => owned.requested.size === 1)
  const [id, callback] = [...owned.requested][0]
  owned.requested.delete(id); callback()
  const handle = await preparing
  const receipt = presenter.commit(handle, { version: '1.0', key: key(), epoch: handle.preparation.epoch, permitId: 'actual-sample' })
  presenter.confirm(receipt)
  const priorGeometry = presenter.currentEntry.geometry
  owned.browserWindow.scrollX = 4; owned.browserWindow.scrollY = 90
  owned.browserDocument.scrollingElement = { scrollLeft: 7, scrollTop: 100, scrollWidth: 900, scrollHeight: 1200 }
  const first = presenter.sampleQueryGeometry(key(), '400', ['root'], true)
  assert.deepEqual(first.viewportScroll, { x: 4, y: 90 })
  assert.deepEqual(first.viewportExtent, { width: 900, height: 1200 })
  assert.equal(first.geometry.epoch, '401')
  assert.deepEqual(first.geometry.nodes.map(node => node.occurrenceId), ['root'])
  delete owned.browserWindow.scrollX; delete owned.browserWindow.scrollY
  const next = presenter.sampleQueryGeometry(key(), '401', [], true)
  assert.deepEqual(next.viewportScroll, { x: 7, y: 100 })
  owned.browserDocument.scrollingElement.scrollHeight = 1600
  assert.deepEqual(presenter.sampleQueryGeometry(key(), '402', [], true).viewportExtent, { width: 900, height: 1600 })
  owned.browserDocument.scrollingElement.scrollHeight = Number.NaN
  assert.throws(() => presenter.sampleQueryGeometry(key(), '403', [], true), /invalid browser viewport content extent/)
  owned.browserWindow.scrollX = 0; owned.browserWindow.scrollY = 0
  assert.equal(Object.hasOwn(presenter.sampleQueryGeometry(key(), '403', []), 'viewportExtent'), false, 'older native requests keep their exact result shape')
  owned.browserDocument.scrollingElement = null
  assert.throws(() => presenter.sampleQueryGeometry(key(), '403', [], true), /invalid browser viewport content extent/)
  assert.equal(presenter.currentEntry.geometry, priorGeometry)
  owned.container.ownerDocument.hidden = true
  assert.throws(() => presenter.sampleQueryGeometry(key(), '402'), failure => failure.code === 'ERR_CANCELLED')
})

async function submitOwnedButton(owned, presenter, value) {
  const submitting = presenter.submit(value, { viewport })
  await untilOwned(() => owned.requested.size === 1)
  const [id, callback] = [...owned.requested][0]; owned.requested.delete(id); callback()
  return submitting
}

test('built-in button provider uses native type, accessibility state and zero-specificity defaults', async () => {
  const owned = ownedBrowserProvider(), presenter = new DomViewPresenter(owned.container)
  const value = document([element('button', 'button', { attrs: { 'aria-label': 'Save item', style: 'background:purple' },
    typedAttrs: { type: 'primary', size: 'mini', plain: true, disabled: false, loading: true },
    children: [{ kind: 'text', occurrenceId: 'label', value: 'Save', ownership: owner() }] })])
  value.styleRoots = ['style:pages/home.wxss']; value.styles = [sheet('pages/home.wxss', [rule('button[type="primary"]', { background: 'navy' })])]
  try {
    await submitOwnedButton(owned, presenter, value)
    const button = owned.browserDocument.body.children[0].children[0]
    assert.equal(button.tagName, 'BUTTON'); assert.equal(button.type, 'button'); assert.equal(button.disabled, false)
    assert.equal(button.attrs.get('aria-label'), 'Save item'); assert.equal(button.attrs.get('aria-disabled'), 'false'); assert.equal(button.attrs.get('aria-busy'), 'true')
    assert.equal(button.attrs.get('data-wc-button-type'), 'primary'); assert.equal(button.attrs.get('data-wc-button-loading'), 'true')
    assert.equal(button.attrs.get('data-wc-button-source-type'), 'primary'); assert.equal(button.attrs.get('plain'), 'true')
    assert.equal(button.style.cssText, 'background:purple;'); assert.equal(button.children[0].textContent, 'Save')
    const css = owned.browserDocument.head.children[0].textContent
    assert.match(css, /:where\(button\[data-wc-tag="button"\]\)\{/)
    assert.match(css, /prefers-reduced-motion:reduce/)
    assert.equal(css.slice(css.indexOf(':where(button'), css.indexOf('[hidden]')).includes('!important'), false)
    assert.ok(css.indexOf('background:navy;') > css.indexOf('[hidden]'), 'authored WXSS follows zero-specificity defaults')
    assert.match(css, /button\[data-wc-button-source-type="primary"\]:where\(\[data-wc-owner="p"\]\)/)
  } finally { await presenter.disposeAsync() }
})

test('built-in button focus migrates by occurrence only after presentation and skips newly disabled controls', async () => {
  for (const disabled of [false, true]) {
    const owned = ownedBrowserProvider(), presenter = new DomViewPresenter(owned.container)
    try {
      await submitOwnedButton(owned, presenter, document([element('button', 'button')]))
      const before = owned.browserDocument.body.children.at(-1).children[0]; before.focus()
      assert.equal(before.type, 'button'); assert.equal(before.attrs.has('data-wc-button-source-type'), false, 'an omitted WXML type must not acquire a source attribute')
      await submitOwnedButton(owned, presenter, document([element('button', 'button', { typedAttrs: { disabled } })], 2))
      const after = owned.browserDocument.body.children.at(-1).children[0]
      assert.notEqual(before, after)
      assert.equal(owned.browserDocument.activeElement === after, !disabled)
    } finally { await presenter.disposeAsync() }
  }
})

test('built-in button capture blocks disabled descendants and delegates keyboard activation to native click', async () => {
  for (const disabled of [false, true]) {
    const owned = ownedBrowserProvider(), output = [], presenter = new DomViewPresenter(owned.container, { onEventBatch: batch => output.push(batch) })
    const value = document([element('button', 'button', { typedAttrs: { disabled, loading: true }, events: [binding('tap')], children: [element('label', 'text')] })])
    try {
      await submitOwnedButton(owned, presenter, value)
      const button = owned.browserDocument.body.children[0].children[0], label = button.children[0]
      let stopped = 0, prevented = 0
      const native = { target: label, composedPath: () => [label, button], cancelable: true, key: 'Enter', timeStamp: 1,
        stopImmediatePropagation() { stopped++ }, preventDefault() { prevented++ } }
      owned.dispatchNative('keydown', native)
      owned.dispatchNative('keydown', { ...native, key: ' ' })
      await tick(); assert.deepEqual(output, [], 'Enter does not synthesize an input confirm event for a native button')
      owned.dispatchNative('click', native)
      assert.equal(stopped, disabled ? 3 : 0); assert.equal(prevented, disabled ? 3 : 0)
      await tick(); assert.equal(output.length, disabled ? 0 : 1)
      if (!disabled) assert.equal(output[0].events[0].type, 'tap')
    } finally { await presenter.disposeAsync() }
  }
})

test('native text key policy separates composition, fallback IME keys and multiline Enter', async () => {
  for (const tag of ['input', 'textarea']) {
    const owned = ownedBrowserProvider(), output = [], presenter = new DomViewPresenter(owned.container, { onEventBatch: batch => output.push(batch) })
    try {
      await submitOwnedButton(owned, presenter, document([element('editor', tag, { attrs: { value: '😀' }, events: [binding('confirmed', 'bubble', false, 'confirm')] })]))
      const editor = owned.browserDocument.body.children[0].children[0]
      editor.selectionStart = 2; editor.selectionEnd = 2
      const native = { target: editor, composedPath: () => [editor], key: 'Enter', timeStamp: 1 }
      owned.dispatchNative('keydown', { ...native, isComposing: true, keyCode: 13 })
      owned.dispatchNative('keydown', { ...native, isComposing: false, keyCode: 229 })
      await tick(); assert.deepEqual(output, [])
      owned.dispatchNative('keydown', { ...native, isComposing: false, keyCode: 13 })
      await tick()
      assert.equal(output.length, tag === 'input' ? 1 : 0)
      if (tag === 'input') assert.deepEqual(output[0].events[0].detail, { value: '😀', cursor: 2, selectionStart: 2, selectionEnd: 2 })
    } finally { await presenter.disposeAsync() }
  }
})

test('built-in provider cancels and settles its original pending RAF before frame destruction', async () => {
  const owned = ownedBrowserProvider(), presenter = new DomViewPresenter(owned.container, { timeoutMs: 500 })
  const preparing = presenter.prepare(document(), { viewport, presentationKey: key() })
  const failed = assert.rejects(preparing, /ERR_CANCELLED/)
  await untilOwned(() => owned.requested.size === 1)
  const handle = presenter.pending.handle, frameId = [...owned.requested.keys()][0]
  presenter.abort(handle); await failed
  const result = await presenter.releaseCandidate(handle)
  assert.equal(result.cleanupPending, false)
  assert.deepEqual(owned.canceled, [frameId]); assert.equal(owned.requested.size, 0)
  assert.equal(owned.allFrames[0].removeCount, 1)
  await presenter.disposeAsync()
})

test('built-in provider ends local font waiting on cancel without fabricating global font readiness', async () => {
  const fonts = deferred(), owned = ownedBrowserProvider({ fonts: fonts.promise }), presenter = new DomViewPresenter(owned.container, { timeoutMs: 500 })
  const preparing = presenter.prepare(document(), { viewport, presentationKey: key() }), failed = assert.rejects(preparing, /ERR_CANCELLED/)
  await untilOwned(() => owned.fontsObserved === 1)
  const handle = presenter.pending.handle
  presenter.abort(handle); await failed
  assert.equal((await presenter.releaseCandidate(handle)).cleanupPending, false)
  assert.equal(owned.requested.size, 0); assert.equal(owned.canceled.length, 0)
  assert.equal(owned.allFrames[0].removeCount, 1)
  fonts.resolve(); await presenter.disposeAsync()
})

test('built-in pending decoder keeps actual frame and leases owned after cancellation until true settlement', async () => {
  const decoding = deferred(), owned = ownedBrowserProvider({ decode: () => decoding.promise })
  let releases = 0
  const presenter = new DomViewPresenter(owned.container, { timeoutMs: 500, resolveResource: () => ({ url: 'blob:decode', release() { releases++ } }) })
  const value = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } })]); value.resources = [resource('assets/pixel.png')]
  const preparing = presenter.prepare(value, { viewport, presentationKey: key(value) }), failed = assert.rejects(preparing, /ERR_CANCELLED/)
  await untilOwned(() => owned.images.length === 1)
  const handle = presenter.pending.handle
  presenter.abort(handle); await failed
  const releasing = presenter.releaseCandidate(handle)
  await tick()
  assert.equal(owned.images[0].src, '')
  assert.equal(owned.allFrames[0].removeCount, undefined); assert.equal(releases, 0)
  decoding.reject(new Error('decode canceled by browser'))
  assert.equal((await releasing).cleanupPending, false)
  assert.equal(owned.allFrames[0].removeCount, 1); assert.equal(releases, 1)
  assert.equal(owned.requested.size, 0); await presenter.disposeAsync()
})

test('an uncancellable original browser decoder reports pending timeout and later actual cleanup settlement', async () => {
  const decoding = deferred(), owned = ownedBrowserProvider({ decode: () => decoding.promise })
  let releases = 0
  const presenter = new DomViewPresenter(owned.container, { timeoutMs: 500, resolveResource: () => ({ url: 'blob:slow', release() { releases++ } }) })
  const value = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } })]); value.resources = [resource('assets/pixel.png')]
  const preparing = presenter.prepare(value, { viewport, presentationKey: key(value) }), failed = assert.rejects(preparing, /ERR_CANCELLED/)
  await untilOwned(() => owned.images.length === 1)
  const handle = presenter.pending.handle
  presenter.abort(handle); await failed
  const release = presenter.releaseCandidate(handle, { timeoutMs: 10 })
  await assert.rejects(release, failure => failure.code === 'ERR_TIMEOUT' && failure.releaseOutcome.cleanupPending === true)
  assert.equal(releases, 0); assert.equal(owned.allFrames[0].removeCount, undefined)
  decoding.resolve(); assert.equal((await presenter.drainCandidate(handle)).status, 'settled')
  assert.equal(releases, 1); assert.equal(owned.allFrames[0].removeCount, 1)
  await assert.rejects(release, failure => failure.code === 'ERR_TIMEOUT')
  await presenter.disposeAsync()
})

test('unknown pending populate cannot lose candidate or resource ownership before last use ends', async () => {
  const population = deferred(), started = deferred(), h = fakePresenter(), create = h.presenter.createCandidate.bind(h.presenter)
  let releases = 0
  h.presenter.resolveResource = () => ({ url: 'blob:in-use', release() { releases++ } })
  h.presenter.createCandidate = async (...args) => {
    const candidate = await create(...args)
    candidate.populate = plan => { candidate.plan = plan; started.resolve(); return population.promise }
    return candidate
  }
  const value = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } })]); value.resources = [resource('assets/pixel.png')]
  const preparing = h.presenter.prepare(value, { viewport, presentationKey: key(value) }), failed = assert.rejects(preparing, /ERR_CANCELLED/)
  await started.promise
  const handle = h.presenter.pending.handle
  h.presenter.abort(handle); await failed
  const releasing = h.presenter.releaseCandidate(handle)
  await tick(); assert.equal(h.candidates[0].disposeCount, 0); assert.equal(releases, 0)
  assert.equal(h.candidates[0].visible, false); assert.equal(h.candidates[0].interactive, false)
  population.resolve(); await releasing
  assert.equal(h.candidates[0].disposeCount, 1); assert.equal(releases, 1)
  await h.presenter.disposeAsync()
})

test('asynchronous candidate disposal cannot revoke delegated plan leases before its last local use', async () => {
  const h = fakePresenter(), cleanup = deferred()
  let releases = 0
  h.presenter.resolveResource = () => ({ url: 'blob:async-owner', release() { releases++ } })
  const value = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } })]); value.resources = [resource('assets/pixel.png')]
  const handle = await h.presenter.prepare(value, { viewport, presentationKey: key(value) }), dispose = h.candidates[0].dispose
  h.candidates[0].dispose = () => { const errors = dispose(); return cleanup.promise.then(() => errors) }
  const releasing = h.presenter.releaseCandidate(handle)
  await tick(); assert.equal(h.candidates[0].disposeCount, 1); assert.equal(releases, 0)
  cleanup.resolve(); await releasing
  assert.equal(releases, 1); await h.presenter.disposeAsync()
})

test('optional asynchronous candidate disposer also fences previously delegated synchronous plan disposal', async () => {
  const h = fakePresenter(), cleanup = deferred()
  let releases = 0
  h.presenter.resolveResource = () => ({ url: 'blob:async-method', release() { releases++ } })
  const value = document([element('image', 'image', { attrs: { src: '../assets/pixel.png' } })]); value.resources = [resource('assets/pixel.png')]
  const handle = await h.presenter.prepare(value, { viewport, presentationKey: key(value) })
  h.candidates[0].disposeAsync = () => cleanup.promise
  const releasing = h.presenter.releaseCandidate(handle)
  await tick(); assert.equal(h.candidates[0].disposeCount, 1); assert.equal(releases, 0)
  cleanup.resolve(); await releasing
  assert.equal(releases, 1); await h.presenter.disposeAsync()
})
