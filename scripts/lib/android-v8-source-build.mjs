import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

export const RUSTY_V8_VERSION = '152.2.0'

export function resolveRustyV8Source(metadata) {
  if (!Array.isArray(metadata?.packages)) return null
  const packages = metadata.packages.filter(pkg => pkg.name === 'v8' && pkg.version === RUSTY_V8_VERSION)
  if (packages.length !== 1 || !packages[0].source?.startsWith('registry+')) return null

  const manifest = packages[0].manifest_path
  if (typeof manifest !== 'string' || !manifest) return null
  return dirname(resolve(manifest))
}

function hasAndroidNdk(source, exists) {
  return exists(resolve(source, 'toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang++'))
    && exists(resolve(source, 'toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include/stdlib.h'))
}

export function prepareAndroidV8SourceBuild(metadata, apiLevel, {
  exists = existsSync,
  lstat = lstatSync,
  realpath = realpathSync,
  mkdir = mkdirSync,
  symlink = symlinkSync,
  inheritedGnArgs = process.env.GN_ARGS || '',
} = {}) {
  const crateRoot = resolveRustyV8Source(metadata)
  if (!crateRoot) return {
    status: 'failed',
    error: 'Pinned rusty_v8 152.2.0 Cargo source is unavailable for the Android V8 source build',
  }

  const sourceNdk = resolve(crateRoot, 'third_party/android_ndk')
  if (!hasAndroidNdk(sourceNdk, exists)) return {
    status: 'failed',
    error: 'rusty_v8 Android NDK source is incomplete; expected the pinned Linux NDK compiler and sysroot headers',
  }

  const alias = resolve(crateRoot, 'third_party/android_toolchain/ndk')
  let aliasExists = false
  try {
    lstat(alias)
    aliasExists = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  if (aliasExists) {
    if (!hasAndroidNdk(alias, exists) || realpath(alias) !== realpath(sourceNdk)) return {
      status: 'failed',
      error: 'rusty_v8 Android toolchain NDK path exists but does not resolve to its pinned Android NDK source',
    }
  } else {
    const parent = dirname(alias)
    mkdir(parent, { recursive: true })
    symlink(relative(parent, sourceNdk), alias, 'dir')
  }

  const requiredGnArgs = `default_min_sdk_version=${apiLevel} android_ndk_api_level=${apiLevel}`
  const gnArgs = [inheritedGnArgs.trim(), requiredGnArgs].filter(Boolean).join('\n')
  return {
    status: 'passed',
    env: { GN_ARGS: gnArgs },
    report: {
      rustyV8Version: RUSTY_V8_VERSION,
      ndkAlias: 'third_party/android_toolchain/ndk',
      ndkSource: 'third_party/android_ndk',
      androidApiLevel: apiLevel,
      effectiveGnArgs: gnArgs,
    },
  }
}
