#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...options,
})

/** Refuse installation unless the simulator's actual app inventory is readable. */
export function assertIOSBundleAbsent(udid, bundleId, execute = run) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(udid ?? '')
    || !/^[A-Za-z0-9.-]+$/.test(bundleId ?? '')) throw new Error('invalid iOS app resource identity')
  // simctl emits an OpenStep plist on supported Xcode versions. plistlib only
  // accepts XML/binary plists; use Apple's parser rather than guessing keys
  // from text or treating a parse failure as an empty app inventory.
  const inventory = execute('xcrun', ['simctl', 'listapps', udid])
  const json = execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: inventory })
  const apps = JSON.parse(json)
  if (!apps || Array.isArray(apps) || typeof apps !== 'object') throw new Error('invalid simulator app inventory')
  if (Object.hasOwn(apps, bundleId)) throw new Error(`bundle already installed; preserved: ${bundleId}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('usage: ios-simulator-apps.mjs <udid> <absent-bundle-id>')
    assertIOSBundleAbsent(process.argv[2], process.argv[3])
  } catch (error) {
    console.error(`[ios-app] inventory preflight failed: ${error.message}`)
    process.exitCode = 1
  }
}
