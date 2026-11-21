import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { prepareAndroidV8SourceBuild, resolveRustyV8Source, RUSTY_V8_VERSION } from './android-v8-source-build.mjs'

function fixture(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'weapp-v8-android-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const crateRoot = resolve(root, 'registry/src/v8-152.2.0')
  const ndkRoot = resolve(crateRoot, 'third_party/android_ndk')
  const compiler = resolve(ndkRoot, 'toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang++')
  const header = resolve(ndkRoot, 'toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include/stdlib.h')
  mkdirSync(dirname(compiler), { recursive: true })
  mkdirSync(dirname(header), { recursive: true })
  writeFileSync(compiler, '')
  writeFileSync(header, '')
  writeFileSync(resolve(crateRoot, 'Cargo.toml'), '[package]\nname = "v8"\nversion = "152.2.0"\n')
  const metadata = {
    packages: [{
      name: 'v8',
      version: RUSTY_V8_VERSION,
      source: 'registry+https://github.com/rust-lang/crates.io-index',
      manifest_path: resolve(crateRoot, 'Cargo.toml'),
    }],
  }
  return { crateRoot, metadata }
}

test('resolves only the pinned registry rusty_v8 package', t => {
  const { metadata, crateRoot } = fixture(t)
  assert.equal(resolveRustyV8Source(metadata), crateRoot)
  assert.equal(resolveRustyV8Source({ packages: metadata.packages.map(pkg => ({ ...pkg, version: '152.2.1' })) }), null)
  assert.equal(resolveRustyV8Source({ packages: metadata.packages.map(pkg => ({ ...pkg, source: null })) }), null)
})

test('prepares the GN NDK path and appends the selected Android API', t => {
  const { crateRoot, metadata } = fixture(t)
  const result = prepareAndroidV8SourceBuild(metadata, 30, { inheritedGnArgs: 'is_component_build=false' })
  const alias = resolve(crateRoot, 'third_party/android_toolchain/ndk')
  assert.equal(result.status, 'passed')
  assert.equal(readlinkSync(alias), '../android_ndk')
  assert.equal(existsSync(resolve(alias, 'toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include/stdlib.h')), true)
  assert.equal(result.env.GN_ARGS, 'is_component_build=false\ndefault_min_sdk_version=30 android_ndk_api_level=30 use_custom_libcxx=true libcxx_is_shared=true')
  assert.equal(result.report.androidApiLevel, 30)
})

test('accepts an existing correct NDK alias and rejects a conflicting path', t => {
  const { crateRoot, metadata } = fixture(t)
  const alias = resolve(crateRoot, 'third_party/android_toolchain/ndk')
  mkdirSync(dirname(alias), { recursive: true })
  const correct = prepareAndroidV8SourceBuild(metadata, 26)
  assert.equal(correct.status, 'passed')
  rmSync(alias)
  mkdirSync(alias)
  const conflict = prepareAndroidV8SourceBuild(metadata, 26)
  assert.equal(conflict.status, 'failed')
  assert.match(conflict.error, /does not resolve to its pinned Android NDK source/)
})

test('fails clearly when the pinned Cargo source is unavailable', () => {
  const result = prepareAndroidV8SourceBuild({ packages: [] }, 26)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /Pinned rusty_v8 152\.2\.0 Cargo source is unavailable/)
})
