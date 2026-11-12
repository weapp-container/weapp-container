import assert from 'node:assert/strict'
import test from 'node:test'
import { orderedQueryFields, projectOrderedDomNodes, orderedNativeQuery } from './ordered-dom-projection.mjs'

const group = (patch = {}) => ({ selector: '#actual', query: 'css', count: 2,
  nodes: [{ text: ' raw\n A ', attributes: { 'data-value': '', ignored: 'not selected' } },
    { text: ' raw B ', attributes: { 'data-value': 'actual B' } }], ...patch })

test('selected actual text and attribute strings retain every match and raw bytes without unused fields', () => {
  const actual = group(), result = projectOrderedDomNodes([actual], [{ selector: '#actual', text: true, attributes: ['data-value'] }])
  assert.deepEqual(result, [{ selector: '#actual', query: 'css', count: 2, nodes: [
    { text: ' raw\n A ', attributes: { 'data-value': '' } }, { text: ' raw B ', attributes: { 'data-value': 'actual B' } },
  ] }])
  actual.nodes[0].text = 'mutated later'; actual.nodes[0].attributes['data-value'] = 'mutated later'
  assert.equal(result[0].nodes[0].text, ' raw\n A '); assert.equal(result[0].nodes[0].attributes['data-value'], '')
})

test('count-only keeps the actual count and complete object array while discarding incidental random/duration/text fields', () => {
  const actual = group(), first = projectOrderedDomNodes([actual], [{ selector: '#actual' }])
  actual.nodes.forEach(node => { node.text = Math.random().toString(); node.duration = Math.random() })
  assert.deepEqual(projectOrderedDomNodes([actual], [{ selector: '#actual' }]), first)
  assert.deepEqual(first, [{ selector: '#actual', query: 'css', count: 2, nodes: [{}, {}] }])
  assert.deepEqual(projectOrderedDomNodes([group({ count: 0, nodes: [] })], [{ selector: '#actual' }])[0].nodes, [])
})

test('concrete component scope, object scope and has remain distinct ordered actual addresses', () => {
  const query = { selector: '#actual', scope: ['#outer', { has: '.inner-host' }], has: '.descendant' }
  const actual = group({ scope: ['#outer', { has: '.inner-host' }], has: '.descendant' })
  const result = projectOrderedDomNodes([actual], [query])
  assert.deepEqual(result[0], { selector: '#actual', query: 'css', scope: ['#outer', { has: '.inner-host' }], has: '.descendant', count: 2, nodes: [{}, {}] })
  actual.scope[1].has = '.changed'; query.scope[1].has = '.also-changed'
  assert.equal(result[0].scope[1].has, '.inner-host')
})

test('absent/empty scope retains the existing item/user normalized payload without synthetic scope/has fields', () => {
  const value = projectOrderedDomNodes([group({ scope: [] })], [{ selector: '#actual', text: true }])[0]
  assert.equal(Object.hasOwn(value, 'scope'), false); assert.equal(Object.hasOwn(value, 'has'), false)
  assert.deepEqual(Object.keys(value), ['selector', 'query', 'count', 'nodes'])
})

test('selected unusual attribute names remain own data fields without changing object prototypes', () => {
  const attributes = Object.fromEntries([['__proto__', 'actual string'], ['constructor', 'actual constructor']])
  const result = projectOrderedDomNodes([group({ count: 1, nodes: [{ attributes }] })], [{ selector: '#actual', attributes: ['__proto__', 'constructor'] }])
  assert.equal(Object.getPrototypeOf(result[0].nodes[0].attributes), Object.prototype)
  assert.equal(Object.hasOwn(result[0].nodes[0].attributes, '__proto__'), true)
  assert.equal(result[0].nodes[0].attributes.__proto__, 'actual string')
})

test('descriptors reject expected values/counts, unknown fields, invalid modes and malformed/duplicate addresses', () => {
  for (const patch of [{ count: 18 }, { text: 'expected visible text' }, { expected: 'value' }, { attributes: { title: 'expected' } },
    { attributes: ['title', 'title'] }, { attributes: [' title '] }, { attributes: [''] }, { scope: '#flattened' },
    { scope: [{ has: '.child', expected: true }] }, { scope: [null] }, { query: 'eval' }, { has: '' },
    { query: 'xpath', scope: ['#host'] }, { query: 'xpath', has: '.child' }, { selector: '' }])
    assert.throws(() => orderedQueryFields({ selector: '#actual', ...patch }))
})

test('actual query/count/complete-array/selected-field disagreements fail without substituting values', () => {
  const query = { selector: '#actual', text: true, attributes: ['data-value'] }
  for (const mutate of [value => { value.selector = '#other' }, value => { value.query = 'xpath' }, value => { value.has = '.unexpected' },
    value => { value.scope = ['#unexpected'] }, value => { value.count++ }, value => { value.count = -1 }, value => { value.nodes.pop() },
    value => { value.nodes[0] = null }, value => { delete value.nodes[0].text }, value => { value.nodes[0].text = 4 },
    value => { delete value.nodes[0].attributes['data-value'] }, value => { value.nodes[0].attributes['data-value'] = undefined }]) {
    const actual = group(); mutate(actual); assert.throws(() => projectOrderedDomNodes([actual], [query]))
  }
  assert.throws(() => projectOrderedDomNodes([group()], []))
  assert.throws(() => projectOrderedDomNodes([group({ nodes: [null, null] })], [{ selector: '#actual' }]))
})

test('scope/has order and object shape cannot be flattened, broadened or inferred', () => {
  const query = { selector: '#actual', scope: ['#outer', { has: '.inner' }], has: '.child' }
  for (const patch of [{ scope: [{ has: '.inner' }, '#outer'], has: '.child' }, { scope: ['#outer', '.inner'], has: '.child' },
    { scope: ['#outer', { has: '.inner', ignored: true }], has: '.child' }, { scope: ['#outer', { has: '.inner' }], has: '.other' },
    { scope: ['#outer', { has: '.inner' }] }])
    assert.throws(() => projectOrderedDomNodes([group(patch)], [query]))
})

test('native address projection contains only reviewed source addresses and field names', () => {
  assert.equal(orderedNativeQuery({ selector: '#actual', text: true }), '#actual')
  assert.deepEqual(orderedNativeQuery({ selector: '#actual', attributes: ['data-value'] }),
    { selector: '#actual', fields: { text: false, attributes: ['data-value'] } })
  assert.deepEqual(orderedNativeQuery({ selector: '.count-only' }), { selector: '.count-only' })
  assert.deepEqual(orderedNativeQuery({ selector: '.count-only', scope: ['#component'] }), { selector: '.count-only', scope: ['#component'] })
  for (const query of [{ selector: '#actual', has: '.child' }, { selector: '#actual', scope: [{ has: '.component-child' }] },
    { selector: '//view', query: 'xpath' }]) assert.throws(() => orderedNativeQuery(query), /does not support/)
})

test('XPath field projection can observe its actual source address but never invents a native capability', () => {
  const actual = group({ selector: '//view', query: 'xpath' })
  assert.equal(projectOrderedDomNodes([actual], [{ selector: '//view', query: 'xpath', text: true }])[0].query, 'xpath')
})
