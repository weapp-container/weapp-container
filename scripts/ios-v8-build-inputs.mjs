#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const IOS_V8_BUILD_INPUT_CONTRACT = Object.freeze({
  schemaVersion: 1,
  target: 'aarch64-apple-ios-sim',
  simulatorArchitecture: 'arm64',
  crate: {
    name: 'v8',
    version: '152.2.0',
    upstreamCommit: '2768994f664e8a6e3aba27503606c58339136e2a',
  },
  archive: {
    sha256: '083d33d8f9b1f650d6b19c58e80fafcf97a9d910ea9dcf3eb837906622f0fbd9',
    bytes: 63995984,
    staticConsistency: 'consistent-static',
    snapshotMagic: '0xc0de05ca',
    snapshotBlobSha256: '95842f4fb161b9d83ee5664bb37869ed6c71ea22844baa88d6d76fda318114bb',
  },
  binding: {
    file: 'src_binding_release_aarch64-apple-ios-sim.rs',
    sha256: 'b9d5652ebca515eb2bf4c2ee4a6551b2567117b5aa720f430d2032616dd7e3b5',
  },
  gn: {
    v8_enable_lite_mode: true,
    v8_jitless: true,
    v8_enable_sparkplug: false,
    v8_enable_maglev: false,
    v8_enable_turbofan: false,
    v8_enable_webassembly: false,
    targetFeatureChangesFromOfficialBaseline: { added: [], removed: [] },
  },
})

const sha256File = async path => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function evaluateIOSV8BuildInputs({
  target,
  architecture,
  archivePath,
  archivePin,
  archiveSha256,
  archiveBytes,
  bindingPath,
  bindingName,
  bindingSha256,
}, contract = IOS_V8_BUILD_INPUT_CONTRACT) {
  const missing = []
  if (!archivePath) missing.push('RUSTY_V8_ARCHIVE')
  if (!archivePin) missing.push('RUSTY_V8_ARCHIVE_SHA256')
  if (!bindingPath) missing.push('RUSTY_V8_SRC_BINDING_PATH')
  if (missing.length) {
    return {
      schemaVersion: contract.schemaVersion,
      status: 'blocked',
      reason: 'required verified V8 build inputs are not configured',
      missing,
      target,
      architecture,
    }
  }

  const failures = []
  if (target !== contract.target) failures.push(`unsupported iOS V8 target: ${target}`)
  if (architecture !== contract.simulatorArchitecture) failures.push(`unsupported iOS V8 simulator architecture: ${architecture}`)
  if (archivePin.toLowerCase() !== contract.archive.sha256) failures.push('RUSTY_V8_ARCHIVE_SHA256 does not match the accepted archive')
  if (archiveSha256 !== contract.archive.sha256) failures.push('V8 archive bytes do not match the accepted archive')
  if (archiveBytes !== contract.archive.bytes) failures.push('V8 archive size does not match the accepted archive')
  if (bindingName !== contract.binding.file) failures.push('V8 source binding filename does not match the iOS simulator target')
  if (bindingSha256 !== contract.binding.sha256) failures.push('V8 source binding bytes do not match the accepted target binding')
  if (failures.length) {
    return {
      schemaVersion: contract.schemaVersion,
      status: 'failed',
      reason: 'configured V8 build inputs violate the iOS simulator input contract',
      failures,
      target,
      architecture,
    }
  }

  return {
    schemaVersion: contract.schemaVersion,
    status: 'passed',
    target,
    architecture,
    crate: contract.crate,
    archive: {
      path: archivePath,
      bytes: archiveBytes,
      sha256: archiveSha256,
      staticConsistency: contract.archive.staticConsistency,
      snapshotMagic: contract.archive.snapshotMagic,
      snapshotBlobSha256: contract.archive.snapshotBlobSha256,
    },
    binding: { path: bindingPath, file: bindingName, sha256: bindingSha256 },
    gn: contract.gn,
  }
}

export async function inspectIOSV8BuildInputs(environment, target, architecture) {
  const configured = {
    archivePath: environment.RUSTY_V8_ARCHIVE,
    archivePin: environment.RUSTY_V8_ARCHIVE_SHA256,
    bindingPath: environment.RUSTY_V8_SRC_BINDING_PATH,
  }
  const variableNames = {
    archivePath: 'RUSTY_V8_ARCHIVE',
    archivePin: 'RUSTY_V8_ARCHIVE_SHA256',
    bindingPath: 'RUSTY_V8_SRC_BINDING_PATH',
  }
  const missing = Object.entries(configured)
    .filter(([, value]) => !value)
    .map(([key]) => variableNames[key])
  if (missing.length) return evaluateIOSV8BuildInputs({ ...configured, target, architecture })

  let archivePath
  let bindingPath
  try {
    ;[archivePath, bindingPath] = await Promise.all([
      realpath(configured.archivePath),
      realpath(configured.bindingPath),
    ])
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        schemaVersion: IOS_V8_BUILD_INPUT_CONTRACT.schemaVersion,
        status: 'blocked',
        reason: 'a configured V8 build input is unavailable',
        missing: [error.path],
        target,
        architecture,
      }
    }
    throw error
  }
  const [archiveStat, bindingStat] = await Promise.all([stat(archivePath), stat(bindingPath)])
  if (!archiveStat.isFile() || !bindingStat.isFile()) {
    return {
      schemaVersion: IOS_V8_BUILD_INPUT_CONTRACT.schemaVersion,
      status: 'failed',
      reason: 'V8 archive and source binding must be regular files',
      target,
      architecture,
    }
  }
  const [archiveSha256, bindingSha256] = await Promise.all([
    sha256File(archivePath),
    sha256File(bindingPath),
  ])
  return evaluateIOSV8BuildInputs({
    target,
    architecture,
    ...configured,
    archivePath,
    archiveSha256,
    archiveBytes: archiveStat.size,
    bindingPath,
    bindingName: basename(bindingPath),
    bindingSha256,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [outputPath, target, architecture] = process.argv.slice(2)
    if (!outputPath || !target || !architecture || process.argv.length !== 5) {
      throw new Error('usage: ios-v8-build-inputs.mjs <receipt.json> <rust-target> <simulator-architecture>')
    }
    const receipt = await inspectIOSV8BuildInputs(process.env, target, architecture)
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`)
    if (receipt.status !== 'passed') {
      console.error(`[ios-app] ${receipt.status}: ${receipt.reason}`)
      if (receipt.missing?.length) console.error(`[ios-app] missing: ${receipt.missing.join(', ')}`)
      if (receipt.failures?.length) console.error(`[ios-app] ${receipt.failures.join('; ')}`)
      process.exitCode = receipt.status === 'blocked' ? 2 : 1
    }
  } catch (error) {
    console.error(`[ios-app] failed: ${error.message}`)
    process.exitCode = 1
  }
}
