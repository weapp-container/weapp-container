import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { nativeSkiaBuild, resolveLockedSkiaSource, HARMONY_SKIA_BINDINGS_VERSION } from './cargo-skia-source.mjs'

const manifest = '/cargo/registry/src/index/skia-bindings-0.157.0/Cargo.toml'
const source = resolve('/cargo/registry/src/index/skia-bindings-0.157.0/skia')
const required = [
  '.gn',
  'bin/gn',
  'include/core/SkTypes.h',
  'third_party/externals/freetype/include/freetype/config/ftheader.h',
  'third_party/externals/libpng/png.h',
].map(path => resolve(source, path))
const metadata = {
  packages: [{
    name: 'skia-bindings',
    version: HARMONY_SKIA_BINDINGS_VERSION,
    source: 'registry+https://github.com/rust-lang/crates.io-index',
    manifest_path: manifest,
  }],
}

test('selects only a complete source tree belonging to the locked Skia crate', () => {
  const result = resolveLockedSkiaSource(metadata, { exists: path => required.includes(path) })
  assert.equal(result, source)
})

test('rejects an incomplete source tree and non-registry or differently pinned packages', () => {
  assert.equal(resolveLockedSkiaSource(metadata, { exists: path => path !== required.at(-1) }), null)
  assert.equal(resolveLockedSkiaSource({ packages: [{ ...metadata.packages[0], version: '0.158.0' }] }, { exists: () => true }), null)
  assert.equal(resolveLockedSkiaSource({ packages: [{ ...metadata.packages[0], source: 'git+https://example.invalid/skia' }] }, { exists: () => true }), null)
  assert.equal(resolveLockedSkiaSource({ packages: [{ ...metadata.packages[0], manifest_path: '' }] }, { exists: () => true }), null)
})

test('uses the Cargo-locked source cache for deterministic mobile builds', () => {
  const result = nativeSkiaBuild({}, { lockedSourceDir: source })
  assert.deepEqual(result.env, { FORCE_SKIA_BUILD: '1', SKIA_SOURCE_DIR: source })
  assert.equal(result.report.buildMode, 'cargo-lock-source-cache-offline')
  assert.equal(result.report.forceSourceBuild, true)
  assert.equal(result.report.verified, false)
})

test('preserves explicit Skia configuration and reports the source-build mode honestly', () => {
  for (const environment of [
    { SKIA_SOURCE_DIR: '/custom/skia' },
    { SKIA_LIBRARY_SEARCH_PATH: '/custom/lib' },
    { DOCS_RS: '1' },
  ]) {
    const result = nativeSkiaBuild(environment, { lockedSourceDir: source })
    assert.deepEqual(result.env, {})
    assert.equal(result.report.buildMode, 'caller-configured')
    assert.equal(result.report.verified, false)
  }
  assert.equal(nativeSkiaBuild({ DOCS_RS: '0' }, { lockedSourceDir: source }).report.buildMode, 'cargo-lock-source-cache-offline')
  assert.equal(nativeSkiaBuild({}).report.buildMode, 'cargo-binary-cache-with-source-fallback')
})
