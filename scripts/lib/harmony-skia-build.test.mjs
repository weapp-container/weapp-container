import assert from 'node:assert/strict'
import test from 'node:test'
import { HARMONY_SKIA_FONT_ARGS, harmonySkiaBuild } from './harmony-skia-build.mjs'

test('Harmony requires source-built FreeType and the custom-empty manager', () => {
  const result = harmonySkiaBuild({ FORCE_SKIA_BUILD: '0', FORCE_SKIA_BINARIES_DOWNLOAD: '1' })
  assert.equal(result.error, null)
  assert.equal(result.env.FORCE_SKIA_BUILD, '1')
  assert.equal(result.env.SKIA_GN_ARGS, HARMONY_SKIA_FONT_ARGS.join(' '))
  assert.equal(result.report.buildMode, 'cargo-lock-pinned-source')
  assert.equal(result.report.fontDecoder, 'bundled-freetype')
  assert.equal(result.report.fontManager, 'custom-empty')
  assert.equal(result.report.verified, false)
})

test('Harmony preserves user GN text and puts required settings after comments and conflicts', () => {
  const original = 'skia_use_freetype=false skia_use_system_freetype2=true\ncustom_value="a b" # keep this flag'
  const environment = { SKIA_GN_ARGS: original, FORCE_SKIA_BUILD: '0' }
  const result = harmonySkiaBuild(environment)
  assert.equal(result.env.SKIA_GN_ARGS, `${original}\n${HARMONY_SKIA_FONT_ARGS.join(' ')}`)
  assert.equal(result.report.effectiveGnArgs, result.env.SKIA_GN_ARGS)
  assert.deepEqual(environment, { SKIA_GN_ARGS: original, FORCE_SKIA_BUILD: '0' })
})

for (const key of ['SKIA_SOURCE_DIR', 'SKIA_LIBRARY_SEARCH_PATH']) {
  test(`Harmony rejects ${key} instead of claiming arbitrary binaries use the pinned font decoder`, () => {
    for (const value of ['', '/other/skia']) {
      const result = harmonySkiaBuild({ [key]: value })
      assert.match(result.error, new RegExp(`unset ${key}`))
      assert.equal(result.report.verified, false)
    }
  })
}

test('Harmony refuses fake docs bindings while accepting an explicitly disabled docs build', () => {
  for (const value of ['', '1', 'true']) assert.match(harmonySkiaBuild({ DOCS_RS: value }).error, /fake documentation bindings/)
  assert.equal(harmonySkiaBuild({ DOCS_RS: '0' }).error, null)
})
