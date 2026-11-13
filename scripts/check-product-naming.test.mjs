import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { auditProductNaming } from './check-product-naming.mjs'

const fixtures = {
  'package.json': JSON.stringify({ name: '@sonofmagic/weapp-container' }),
  'tools/container-manifest/package.json': JSON.stringify({ name: '@sonofmagic/container-manifest', bin: { 'container-pack': './dist/cli.mjs' } }),
  'crates/container-simulator/Cargo.toml': '[package]\nname = "container-simulator"\n[[bin]]\nname = "weapp-simulator"\npath = "src/main.rs"\n',
  'crates/container-sdk-ffi/Cargo.toml': '[package]\nname = "container-sdk-ffi"\n[lib]\nname = "weapp_container_sdk"\n',
  'crates/container-sdk-ffi/src/lib.rs': '#[no_mangle]\npub extern "C" fn weapp_container_sdk_abi_version() -> u32 { 1 }\n',
  'README.md': '# Weapp Container\n\nPublic embedding interfaces.\n',
}

async function withSource(overrides, verify) {
  const root = await mkdtemp(join(tmpdir(), 'weapp-naming-'))
  try {
    for (const [path, content] of Object.entries({ ...fixtures, ...overrides })) {
      if (content === null) continue
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), content)
    }
    await verify(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('accepts the package, executable and C ABI used by an embedding consumer', async () => {
  await withSource({}, async root => {
    const report = await auditProductNaming({ root })
    assert.equal(report.status, 'passed')
    assert.equal(report.checkedFiles, 6)
    assert.deepEqual(report.findings, [])
  })
})

test('rejects mismatched package, CLI, library, title and export declarations', async () => {
  const changes = [
    ['package.json', JSON.stringify({ name: '@example/other-container' })],
    ['tools/container-manifest/package.json', JSON.stringify({ name: '@sonofmagic/container-manifest', bin: { 'sample-pack': 'bin/container-pack.mjs' } })],
    ['crates/container-simulator/Cargo.toml', fixtures['crates/container-simulator/Cargo.toml'].replace('weapp-simulator', 'sample-simulator')],
    ['crates/container-sdk-ffi/Cargo.toml', fixtures['crates/container-sdk-ffi/Cargo.toml'].replace('weapp_container_sdk', 'sample_container_sdk')],
    ['README.md', '# Sample Container\n'],
    ['crates/container-sdk-ffi/src/lib.rs', fixtures['crates/container-sdk-ffi/src/lib.rs'].replace('weapp_container_sdk_', 'sample_sdk_')],
  ]
  for (const [path, content] of changes) await withSource({ [path]: content }, async root => {
    const report = await auditProductNaming({ root })
    assert.equal(report.status, 'failed', path)
    assert.deepEqual([...new Set(report.findings.map(item => item.path))], [path])
  })
})

test('does not let duplicate targets, empty exports or invalid JSON bypass the contract', async () => {
  for (const [path, content] of [
    ['crates/container-simulator/Cargo.toml', fixtures['crates/container-simulator/Cargo.toml'] + '[[bin]]\nname = "sample-cli"\n'],
    ['crates/container-sdk-ffi/src/lib.rs', 'pub fn internal_helper() {}\n'],
    ['package.json', '{broken'],
  ]) await withSource({ [path]: content }, async root => {
    const report = await auditProductNaming({ root })
    assert.equal(report.status, 'failed')
    assert.ok(report.findings.some(item => item.path === path))
  })
})

test('rejects a missing or linked declaration instead of borrowing another checkout', async () => {
  await withSource({ 'README.md': null }, async root => {
    assert.equal((await auditProductNaming({ root })).status, 'failed')
    await symlink(join(root, 'package.json'), join(root, 'README.md'))
    const report = await auditProductNaming({ root })
    assert.ok(report.findings.some(item => item.path === 'README.md' && item.kind === 'unreadable-declaration'))
  })
})

test('accepts literal TOML strings and ignores unrelated helper declarations', async () => {
  await withSource({
    'crates/container-sdk-ffi/Cargo.toml': "[package]\nname = 'container-sdk-ffi' # package\n[lib]\nname = 'weapp_container_sdk'\n",
    'crates/container-sdk-ffi/src/lib.rs': fixtures['crates/container-sdk-ffi/src/lib.rs'] + 'pub fn sample_helper() {}\n',
  }, async root => assert.equal((await auditProductNaming({ root })).status, 'passed'))
})
