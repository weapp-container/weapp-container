import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateHostApiCatalog } from './verify-host-api-catalog.mjs'

const catalog = JSON.parse(await readFile(new URL('../crates/container-runtime/src/host-api-catalog.json', import.meta.url), 'utf8'))

test('pinned catalog has explicit, valid ownership and execution classifications', () => {
  const result = validateHostApiCatalog(catalog)
  assert.equal(result.apiCount, 1251)
  assert.equal(result.ownerCounts.host, 1114)
  assert.equal(result.ownerCounts.runtime, 137)
  assert.equal(result.extensionCount, 5)
})

test('catalog rejects duplicate names, missing classifications, and external version provenance', () => {
  for (const mutate of [
    value => value.apis.push(structuredClone(value.apis[0])),
    value => { delete value.apis[0].owner },
    value => { value.apis[0].kind = 'unknown' },
    value => { value.apis[0].since = '3.18.0' },
    value => { value.apis.find(api => api.baseline === 'extension').name = 'wx.unreviewedExtension' },
  ]) {
    const value = structuredClone(catalog)
    mutate(value)
    assert.throws(() => validateHostApiCatalog(value), /Host API catalog invalid/)
  }
})

test('catalog rejects broken object, task, counterpart, and global property contracts', () => {
  const cases = [
    value => { value.apis.find(api => api.kind === 'object' && !api.component).objectType = undefined },
    value => { value.apis.find(api => api.kind === 'task').objectType = 'NotAType' },
    value => { value.apis.find(api => api.counterpart).counterpart = 'component:audio' },
    value => { value.globalProperties[0].callable = 'maybe' },
  ]
  for (const mutate of cases) {
    const value = structuredClone(catalog)
    mutate(value)
    assert.throws(() => validateHostApiCatalog(value), /Host API catalog invalid/)
  }
})
