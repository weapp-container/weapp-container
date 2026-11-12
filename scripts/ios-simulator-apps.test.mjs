import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { assertIOSBundleAbsent } from './ios-simulator-apps.mjs'

const udid = '8FF8E968-BB02-4039-A25C-7C7EBCBDA402'
const bundle = 'com.example.task.unique'
const inventory = '{ "com.example.unrelated" = { CFBundleIdentifier = "com.example.unrelated"; }; }'

test('uses native plist conversion and exact bundle keys before installation', () => {
  const calls = []
  assertIOSBundleAbsent(udid, bundle, (command, args, options) => {
    calls.push({ command, args, options })
    return command === 'xcrun' ? inventory : '{"com.example.task.unique.other":{}}'
  })
  assert.deepEqual(calls, [
    { command: 'xcrun', args: ['simctl', 'listapps', udid], options: undefined },
    { command: '/usr/bin/plutil', args: ['-convert', 'json', '-o', '-', '--', '-'], options: { input: inventory } },
  ])
  assert.throws(() => assertIOSBundleAbsent(udid, bundle, command => command === 'xcrun' ? inventory : JSON.stringify({ [bundle]: {} })), /already installed; preserved/)
})

test('inventory command, conversion, and malformed results fail closed', () => {
  assert.throws(() => assertIOSBundleAbsent(udid, bundle, () => { throw new Error('simctl failed') }), /simctl failed/)
  assert.throws(() => assertIOSBundleAbsent(udid, bundle, command => {
    if (command === 'xcrun') return inventory
    throw new Error('plist conversion failed')
  }), /plist conversion failed/)
  for (const output of ['invalid', 'null', '[]', '"text"']) {
    assert.throws(() => assertIOSBundleAbsent(udid, bundle, command => command === 'xcrun' ? inventory : output))
  }
})

test('invalid resource identities cannot inspect or mutate simulator state', () => {
  for (const [device, app] of [['booted', bundle], [udid, ''], [udid, 'bad;command']]) {
    assert.throws(() => assertIOSBundleAbsent(device, app, () => assert.fail('must not execute')), /invalid iOS app resource identity/)
  }
})

test('Apple parser accepts simctl OpenStep inventories', { skip: process.platform !== 'darwin' }, () => {
  const execute = (command, args, options) => command === 'xcrun' ? inventory
    : execFileSync(command, args, { ...options, encoding: 'utf8' })
  assertIOSBundleAbsent(udid, bundle, execute)
  assert.throws(() => assertIOSBundleAbsent(udid, 'com.example.unrelated', execute), /already installed; preserved/)
})
