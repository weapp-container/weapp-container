#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CATALOG_PATH = new URL('../crates/container-runtime/src/host-api-catalog.json', import.meta.url)
const API_KINDS = new Set(['async', 'object', 'subscription', 'syncLocal', 'syncSnapshot', 'task'])
const OWNERS = new Set(['host', 'runtime'])
const BASELINES = new Set(['included', 'extension', 'newer-than-baseline'])
const PROJECT_EXTENSIONS = new Set([
  'weappContainer.identity.authorizePhone',
  'weappContainer.identity.getState',
  'weappContainer.identity.logout',
  'weappContainer.identity.offChange',
  'weappContainer.identity.onChange',
  'weappContainer.payment.request',
])

function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function assert(condition, message) {
  if (!condition) throw new Error(`Host API catalog invalid: ${message}`)
}

export function validateHostApiCatalog(catalog) {
  assert(catalog && typeof catalog === 'object', 'root must be an object')
  assert(catalog.schemaVersion === 1, 'schemaVersion must be 1')
  assert(catalog.protocolVersion === '1.0', 'protocolVersion must be 1.0')
  assert(catalog.baseline?.baseLibrary === '3.17.3', 'base library must match the pinned 3.17.3 baseline')
  assert(catalog.baseline?.typings?.name === 'miniprogram-api-typings', 'typings package identity is missing')
  assert(catalog.baseline.typings.version === '5.2.3', 'typings package version must match the pinned baseline')
  assert(Array.isArray(catalog.apis) && catalog.apis.length > 0, 'apis must be a non-empty array')
  assert(Array.isArray(catalog.globalProperties), 'globalProperties must be an array')

  const byName = new Map()
  for (const api of catalog.apis) {
    assert(api && typeof api === 'object', 'API entries must be objects')
    assert(typeof api.name === 'string' && api.name.length > 0, 'API name is missing')
    assert(!byName.has(api.name), `duplicate API name ${api.name}`)
    assert(/^(wx\.|object:|component:|weappContainer\.)/.test(api.name), `unrecognized API namespace ${api.name}`)
    assert(API_KINDS.has(api.kind), `${api.name} has invalid kind ${api.kind}`)
    assert(OWNERS.has(api.owner), `${api.name} has invalid owner ${api.owner}`)
    assert(BASELINES.has(api.baseline), `${api.name} has invalid baseline classification ${api.baseline}`)
    if (api.baseline !== 'extension' && api.component !== true) {
      assert(Array.isArray(api.signatures) && api.signatures.length > 0, `${api.name} has no signatures`)
    }
    for (const signature of api.signatures ?? []) {
      assert(signature && Array.isArray(signature.parameters), `${api.name} has an invalid signature`)
      assert(typeof signature.returns === 'string', `${api.name} signature has no return type`)
    }
    if (api.permission !== undefined) assert(typeof api.permission === 'string' && api.permission.length > 0, `${api.name} has an invalid permission`)
    if (api.since !== undefined) assert(/^\d+\.\d+\.\d+$/.test(api.since), `${api.name} has an invalid since version`)
    if (api.baseline === 'included' && api.since) {
      assert(compareVersions(api.since, catalog.baseline.baseLibrary) <= 0, `${api.name} is newer than the baseline but marked included`)
    }
    if (api.baseline === 'newer-than-baseline') {
      assert(api.since && compareVersions(api.since, catalog.baseline.baseLibrary) > 0, `${api.name} must identify a newer since version`)
    }
    if (api.baseline === 'extension') {
      assert(api.name.startsWith('weappContainer.'), `${api.name} is not in the project extension namespace`)
    }
    if (api.kind === 'object') assert(api.objectType || api.component === true, `${api.name} has no object type`)
    if (api.kind === 'task') assert(/Task$/.test(api.objectType ?? ''), `${api.name} has no task object type`)
    if (api.event !== undefined) assert(typeof api.event === 'string', `${api.name} has an invalid event name`)
    if (api.counterpart !== undefined) assert(typeof api.counterpart === 'string' && api.counterpart.length > 0, `${api.name} has an invalid counterpart`)
    if (api.component !== undefined) assert(typeof api.component === 'boolean', `${api.name} has an invalid component classification`)
    byName.set(api.name, api)
  }

  for (const api of catalog.apis) {
    if (api.counterpart) {
      const counterpart = byName.get(api.counterpart)
      // Typings occasionally expose one side of a listener pair. When both
      // sides are present, they must still agree on the relationship.
      if (counterpart) {
        assert(counterpart.counterpart === api.name, `${api.name} counterpart is not reciprocal`)
        assert(counterpart.kind === 'subscription', `${api.name} counterpart is not a subscription`)
      }
    }
  }

  const propertyNames = new Set()
  for (const property of catalog.globalProperties) {
    assert(property && typeof property.name === 'string' && property.name.startsWith('wx.'), 'global property must use the wx namespace')
    assert(!propertyNames.has(property.name), `duplicate global property ${property.name}`)
    assert(typeof property.type === 'string' && property.type.length > 0, `${property.name} has no declared type`)
    assert(typeof property.callable === 'boolean', `${property.name} has no callable classification`)
    assert(OWNERS.has(property.owner), `${property.name} has invalid owner ${property.owner}`)
    propertyNames.add(property.name)
  }

  const actualExtensions = catalog.apis.filter(api => api.baseline === 'extension').map(api => api.name).sort()
  assert(JSON.stringify(actualExtensions) === JSON.stringify([...PROJECT_EXTENSIONS].sort()), 'project extension set changed without an explicit review')
  return {
    apiCount: catalog.apis.length,
    globalPropertyCount: catalog.globalProperties.length,
    ownerCounts: Object.fromEntries([...OWNERS].map(owner => [owner, catalog.apis.filter(api => api.owner === owner).length])),
    kindCounts: Object.fromEntries([...API_KINDS].map(kind => [kind, catalog.apis.filter(api => api.kind === kind).length])),
    extensionCount: actualExtensions.length,
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'))
  const result = validateHostApiCatalog(catalog)
  process.stdout.write(`Host API catalog accepted: ${result.apiCount} APIs, ${result.globalPropertyCount} global properties, ${result.extensionCount} project extensions\n`)
}
