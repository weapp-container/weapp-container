// skia-bindings 0.153.3 disables FreeType for OHOS. Its supported GN override
// hook runs after platform defaults, while the binary-cache key omits those
// overrides. Force the pinned source build so cached fontless binaries cannot
// silently satisfy the Harmony target.
export const HARMONY_SKIA_FONT_ARGS = Object.freeze([
  'skia_use_freetype=true',
  'skia_use_system_freetype2=false',
  'skia_enable_fontmgr_custom_empty=true',
])

export function harmonySkiaBuild(environment = process.env) {
  const inherited = environment.SKIA_GN_ARGS?.trim() || ''
  // A newline preserves user flags even when their final line is a GN comment.
  // Required assignments come last and override conflicting platform/user
  // assignments without rewriting unrelated flags or quoted string values.
  const gnArgs = [inherited, HARMONY_SKIA_FONT_ARGS.join(' ')].filter(Boolean).join('\n')
  const incompatible = ['SKIA_SOURCE_DIR', 'SKIA_LIBRARY_SEARCH_PATH']
    .filter(key => environment[key] !== undefined)
  const error = incompatible.length
    ? `Harmony Skia requires the Cargo.lock-pinned source build; unset ${incompatible.join(', ')}`
    : environment.DOCS_RS !== undefined && environment.DOCS_RS !== '0'
      ? 'Harmony Skia requires a native source build; unset DOCS_RS to disable fake documentation bindings'
      : null
  return {
    env: { FORCE_SKIA_BUILD: '1', SKIA_GN_ARGS: gnArgs },
    error,
    report: {
      skiaBindingsVersion: '0.153.3',
      buildMode: 'cargo-lock-pinned-source',
      forceSourceBuild: true,
      fontDecoder: 'bundled-freetype',
      fontManager: 'custom-empty',
      requiredGnArgs: [...HARMONY_SKIA_FONT_ARGS],
      effectiveGnArgs: gnArgs,
      verified: false,
    },
  }
}
