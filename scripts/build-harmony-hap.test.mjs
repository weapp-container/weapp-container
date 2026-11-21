import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { inspectInstalledHarmonyNapiTypes } from './lib/harmony-build-contract.mjs'

test('Harmony build help exits without starting a build or creating output', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmony-hap-help-'))
  const out = join(root, 'must-not-exist')
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./build-harmony-hap.mjs', import.meta.url)), '--help', '--out', out], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Usage: node scripts\/build-harmony-hap\.mjs/)
    assert.equal(result.stderr, '')
    assert.equal(existsSync(out), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Harmony module dynamically loads the native N-API package through the platform loader', () => {
  const moduleRoot = fileURLToPath(new URL('../examples/hosts/harmony/entry/src/main/', import.meta.url))
  const profilePath = fileURLToPath(new URL('../examples/hosts/harmony/entry/build-profile.json5', import.meta.url))
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
  assert.deepEqual(profile.buildOption.arkOptions.runtimeOnly.packages, ['libentry.so'])
  assert.match(readFileSync(join(moduleRoot, 'ets/native/WeappContainer.ets'), 'utf8'), /loadNativeModule\('libentry\.so'\) as NativeModule/)
  assert.match(readFileSync(join(moduleRoot, 'ets/native/WeappContainer.ets'), 'utf8'), /import type \{ NativeModule, NativeOwner \} from 'libentry\.so';/)
  assert.match(readFileSync(join(moduleRoot, 'cpp/types/libentry/index.d.ts'), 'utf8'), /export interface NativeModule/)
})

test('Harmony build rejects unknown and incomplete options before creating output', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmony-hap-invalid-'))
  const out = join(root, 'must-not-exist')
  const script = fileURLToPath(new URL('./build-harmony-hap.mjs', import.meta.url))
  try {
    for (const args of [['--unknown', 'value'], ['--out', out, '--profile']]) {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /Unknown option: --unknown|--profile requires a value/)
      assert.equal(existsSync(out), false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isolated Harmony builds require the installed local N-API declaration package', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmony-hap-package-'))
  try {
    const packagePath = resolve(root, 'entry/oh_modules/libentry.so')
    mkdirSync(packagePath, { recursive: true })
    const declaration = Buffer.from('export declare class NativeOwner {}\n')
    writeFileSync(join(packagePath, 'index.d.ts'), declaration)
    assert.deepEqual(inspectInstalledHarmonyNapiTypes(root), {
      path: 'entry/oh_modules/libentry.so',
      resolvedPath: 'entry/oh_modules/libentry.so',
      typesSha256: createHash('sha256').update(declaration).digest('hex'),
    })
    rmSync(join(packagePath, 'index.d.ts'))
    assert.throws(() => inspectInstalledHarmonyNapiTypes(root), /type package/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isolated Harmony builds reject a local N-API package escaping the project', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmony-hap-package-'))
  const outside = mkdtempSync(join(tmpdir(), 'harmony-hap-outside-'))
  try {
    mkdirSync(join(outside, 'libentry.so'), { recursive: true })
    writeFileSync(join(outside, 'libentry.so/index.d.ts'), 'export declare class NativeOwner {}\n')
    mkdirSync(resolve(root, 'entry/oh_modules'), { recursive: true })
    symlinkSync(join(outside, 'libentry.so'), resolve(root, 'entry/oh_modules/libentry.so'), 'dir')
    assert.throws(() => inspectInstalledHarmonyNapiTypes(root), /outside the isolated Harmony project/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('isolated Harmony builds reject declarations escaping the installed N-API package', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmony-hap-types-'))
  const outside = mkdtempSync(join(tmpdir(), 'harmony-hap-types-outside-'))
  try {
    mkdirSync(join(root, 'entry/oh_modules/libentry.so'), { recursive: true })
    writeFileSync(join(outside, 'index.d.ts'), 'export declare class NativeOwner {}\n')
    symlinkSync(join(outside, 'index.d.ts'), resolve(root, 'entry/oh_modules/libentry.so/index.d.ts'))
    assert.throws(() => inspectInstalledHarmonyNapiTypes(root), /declarations resolve outside the installed package/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
