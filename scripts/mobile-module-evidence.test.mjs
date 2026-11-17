import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectMobileModuleExecution } from './mobile-module-evidence.mjs'

const record = patch => ({
  messages: [{
    kind: 'response', op: 'app.init', payload: {
      ok: true, engine: 'quickjs', engineProviderAvailable: true,
      loadedModules: 4, manifest: { integrity: 'a'.repeat(64) }, ...patch,
    },
  }],
})
const platform = patch => ({ probes: [{ stdout: `WEAPP_CONTAINER_SMOKE app.init json=${JSON.stringify(record(patch))}` }] })

test('real module execution requires provider, manifest integrity, loaded modules and expected engine', () => {
  assert.equal(inspectMobileModuleExecution(platform({})).status, 'passed')
  assert.equal(inspectMobileModuleExecution(platform({ engineProviderAvailable: false })).status, 'incomplete')
  assert.equal(inspectMobileModuleExecution(platform({ loadedModules: 0 })).status, 'incomplete')
  assert.equal(inspectMobileModuleExecution(platform({ manifest: { integrity: '' } })).status, 'incomplete')
  assert.equal(inspectMobileModuleExecution(platform({ engine: 'v8' })).status, 'incomplete')
  assert.equal(inspectMobileModuleExecution(platform({ engine: 'v8' }), 'v8').status, 'passed')
  assert.equal(inspectMobileModuleExecution(platform({ engine: 'host' }), 'host').status, 'incomplete')
})

test('unstructured status fields and malformed JSON never substitute for a runtime app.init response', () => {
  assert.equal(inspectMobileModuleExecution({ moduleExecution: { status: 'passed' } }).status, 'incomplete')
  assert.equal(inspectMobileModuleExecution({ probes: [{ stdout: 'WEAPP_CONTAINER_SMOKE app.init {broken' }] }).status, 'incomplete')
  const ios = { surfaceProbe: { operations: { 'app.init': { json: JSON.stringify(record({})) } } } }
  assert.equal(inspectMobileModuleExecution(ios).status, 'passed')
})
