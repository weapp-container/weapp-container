// skia-bindings 0.157.0 disables FreeType for OHOS. Its supported GN override
// hook runs after platform defaults, while the binary-cache key omits those
// overrides. Force a source build so cached binaries cannot silently skip the
// Harmony font-manager and C++ compatibility settings.
export const HARMONY_SKIA_REQUIRED_GN_ARGS = Object.freeze([
  'skia_use_freetype=true',
  'skia_use_system_freetype2=false',
  'skia_enable_fontmgr_custom_empty=true',
  // skia-bindings enables Expat unconditionally, which pulls SkSVGDevice.cpp
  // into the XML target even when the Rust `svg` feature is disabled. The
  // OpenHarmony Clang 15 libc++ cannot compile that optional writer, and the
  // container does not expose Skia's XML/SVG writer API.
  'skia_use_expat=false',
  // The bundled zlib ARM CRC32 implementation crashes DevEco Clang 15.
  'skia_use_system_zlib=true',
])

export function harmonySkiaBuild(environment = process.env, { lockedSourceDir = null } = {}) {
  const inherited = environment.SKIA_GN_ARGS?.trim() || ''
  // A newline preserves user flags even when their final line is a GN comment.
  // Required assignments come last and override conflicting platform/user
  // assignments without rewriting unrelated flags or quoted string values.
  const gnArgs = [inherited, HARMONY_SKIA_REQUIRED_GN_ARGS.join(' ')].filter(Boolean).join('\n')
  const incompatible = ['SKIA_SOURCE_DIR', 'SKIA_LIBRARY_SEARCH_PATH']
    .filter(key => environment[key] !== undefined)
  const error = incompatible.length
    ? `Harmony Skia requires the Cargo.lock-pinned source build; unset ${incompatible.join(', ')}`
    : environment.DOCS_RS !== undefined && environment.DOCS_RS !== '0'
      ? 'Harmony Skia requires a native source build; unset DOCS_RS to disable fake documentation bindings'
      : null
  return {
    env: {
      FORCE_SKIA_BUILD: '1',
      SKIA_GN_ARGS: gnArgs,
      ...(lockedSourceDir ? { SKIA_SOURCE_DIR: lockedSourceDir } : {}),
    },
    error,
    report: {
      skiaBindingsVersion: '0.157.0',
      buildMode: lockedSourceDir ? 'cargo-lock-source-cache-offline' : 'cargo-lock-pinned-source-sync',
      forceSourceBuild: true,
      fontDecoder: 'bundled-freetype',
      fontManager: 'custom-empty',
      xmlWriter: 'disabled',
      requiredGnArgs: [...HARMONY_SKIA_REQUIRED_GN_ARGS],
      effectiveGnArgs: gnArgs,
      verified: false,
    },
  }
}
