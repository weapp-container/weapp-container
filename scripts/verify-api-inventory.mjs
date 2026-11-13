#!/usr/bin/env node
/** Validate the versioned API inventory and its committed canonical golden hash. */
import { readFile } from 'node:fs/promises'
import { canonicalize, DEFAULT_CAPABILITIES, sha256 } from '../tools/container-manifest/src/index.ts'

const inventoryPath = new URL('../docs/api-inventory-v1.json', import.meta.url)
const goldenPath = new URL('../docs/api-inventory-v1.sha256', import.meta.url)
const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'))
const golden = (await readFile(goldenPath, 'utf8')).trim().split(/\s+/)[0]
const actual = sha256(canonicalize(inventory))
const fail = (message) => {
  throw new Error(`API inventory invalid: ${message}`)
}
if (actual !== golden) fail(`canonical hash ${actual} does not match ${golden}`)
if (inventory.schemaVersion !== 1 || inventory.manifestVersion !== '1.0' || inventory.protocolVersion !== '1.0') {
  fail('schema/manifest/protocol version must be 1/1.0/1.0')
}
const hosts = ['web', 'macos', 'windows', 'linux', 'android', 'ios', 'harmony']
const engines = ['quickjs', 'v8']
if (JSON.stringify(inventory.hosts) !== JSON.stringify(hosts)) fail('host order or set changed')
if (JSON.stringify(inventory.engines) !== JSON.stringify(engines)) fail('engine order or set changed')
if (!Array.isArray(inventory.apis) || inventory.apis.length === 0) fail('apis must be non-empty')
const statuses = new Set(['full', 'partial', 'unsupported'])
const ids = new Set()
const names = new Set()
const inventoryStatusByName = new Map()
for (const api of inventory.apis) {
  if (!api || typeof api !== 'object' || typeof api.id !== 'string' || !api.id) fail('every API needs an id')
  if (ids.has(api.id)) fail(`duplicate API id ${api.id}`)
  ids.add(api.id)
  if (!Array.isArray(api.names) || api.names.length === 0) fail(`${api.id} needs names[]`)
  for (const name of api.names) {
    if (typeof name !== 'string' || !name) fail(`${api.id} has an invalid name`)
    if (names.has(name)) fail(`duplicate API name ${name}`)
    names.add(name)
    inventoryStatusByName.set(name, api.support)
  }
  if (!statuses.has(api.support)) fail(`${api.id} has invalid support ${api.support}`)
  for (const host of hosts) {
    if (!statuses.has(api.hostCoverage?.[host])) fail(`${api.id} missing host coverage ${host}`)
  }
  for (const engine of engines) {
    if (!statuses.has(api.engineCoverage?.[engine])) fail(`${api.id} missing engine coverage ${engine}`)
  }
  if (typeof api.permission !== 'string' || !api.permission) fail(`${api.id} needs permission`) 
  if (typeof api.difference !== 'string' || !api.difference) fail(`${api.id} needs difference`) 
  if (!Array.isArray(api.conformance) || api.conformance.length === 0) fail(`${api.id} needs conformance[]`)
  if (!/^\d+\.\d+$/.test(api.minimumManifestVersion) || !/^\d+\.\d+$/.test(api.minimumProtocolVersion)) {
    fail(`${api.id} has invalid minimum version`)
  }
  // An explicitly unsupported API must be unsupported on every execution
  // surface. This prevents the inventory from documenting a false fallback.
  if (api.support === 'unsupported' && [...hosts, ...engines].some((key) => (api.hostCoverage?.[key] ?? api.engineCoverage?.[key]) !== 'unsupported')) {
    fail(`${api.id} is unsupported but has a non-unsupported coverage entry`)
  }
}
for (const [name, status] of Object.entries(DEFAULT_CAPABILITIES)) {
  if (inventoryStatusByName.has(name) && inventoryStatusByName.get(name) !== status) {
    fail(`${name} differs from packer default: inventory=${inventoryStatusByName.get(name)} default=${status}`)
  }
}
console.log(`API inventory accepted: ${inventory.apis.length} groups, canonical=${actual}`)
