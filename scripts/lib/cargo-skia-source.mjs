import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const HARMONY_SKIA_BINDINGS_VERSION = '0.157.0'

const REQUIRED_OFFLINE_SOURCE_PATHS = [
  '.gn',
  'bin/gn',
  'include/core/SkTypes.h',
  'third_party/externals/freetype/include/freetype/config/ftheader.h',
  'third_party/externals/libpng/png.h',
]

export function resolveLockedSkiaSource(metadata, { exists = existsSync } = {}) {
  if (!Array.isArray(metadata?.packages)) return null
  const packages = metadata.packages.filter(pkg => pkg.name === 'skia-bindings' && pkg.version === HARMONY_SKIA_BINDINGS_VERSION)
  if (packages.length !== 1 || !packages[0].source?.startsWith('registry+')) return null

  const manifest = packages[0].manifest_path
  if (typeof manifest !== 'string' || !manifest) return null
  const source = resolve(dirname(manifest), 'skia')
  return REQUIRED_OFFLINE_SOURCE_PATHS.every(path => exists(resolve(source, path))) ? source : null
}

export function nativeSkiaBuild(environment = {}, { lockedSourceDir = null } = {}) {
  const externalConfiguration = ['SKIA_SOURCE_DIR', 'SKIA_LIBRARY_SEARCH_PATH'].some(key => environment[key] !== undefined)
    || (environment.DOCS_RS !== undefined && environment.DOCS_RS !== '0')
  const useLockedSource = !externalConfiguration && Boolean(lockedSourceDir)
  return {
    env: useLockedSource ? { FORCE_SKIA_BUILD: '1', SKIA_SOURCE_DIR: lockedSourceDir } : {},
    report: {
      skiaBindingsVersion: HARMONY_SKIA_BINDINGS_VERSION,
      buildMode: externalConfiguration
        ? 'caller-configured'
        : useLockedSource
          ? 'cargo-lock-source-cache-offline'
          : 'cargo-binary-cache-with-source-fallback',
      forceSourceBuild: useLockedSource || environment.SKIA_SOURCE_DIR !== undefined,
      verified: false,
    },
  }
}
