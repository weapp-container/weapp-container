import test from 'node:test'
import assert from 'node:assert/strict'
import { hasHarmonyRuntimeCrash } from './mobile-runtime-parser.mjs'

test('ignores unrelated Harmony system Reason markers', () => {
  assert.equal(hasHarmonyRuntimeCrash(
    'I C05610/ASP: [PermissionUpgrade]OnReceiveOnDemandReason: receive on demand reason',
  ), false)
})

test('classifies an app ArkTS exception as runtime failure evidence', () => {
  assert.equal(hasHarmonyRuntimeCrash(
    'I A03d00/JSAPP: Error name: TypeError: start is not a function',
  ), true)
})

