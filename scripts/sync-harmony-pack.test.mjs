import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./sync-harmony-pack.mjs', import.meta.url))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value)
const references = [
  ['viewScripts.sha256', manifest => [manifest.viewScripts[0], 'sha256']],
  ['compilation.sourceSha256', manifest => [manifest.viewCompilation.modules[0], 'sourceSha256']],
  ['compilation.executableSha256', manifest => [manifest.viewCompilation.modules[0], 'executableSha256']],
  ['document.wxmlAst', manifest => [manifest.viewCompilation.documents[0], 'wxmlAst']],
  ['expression.executableSha256', manifest => [manifest.viewCompilation.documents[0].expressions[0], 'executableSha256']],
]

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'weapp-harmony-pack-'))
  try {
    const source = join(root, 'source'), destination = join(root, 'destination')
    await mkdir(join(source, 'blobs/sha256'), { recursive: true })
    const contents = { module: 'App({})', template: '{"version":1,"nodes":[]}', style: '{"rules":[]}',
      asset: 'image', source: 'module.exports=[]', executable: 'compiled-module', expression: 'compiled-expression' }
    const hashes = {}
    for (const [name, bytes] of Object.entries(contents)) {
      hashes[name] = sha256(bytes)
      await writeFile(join(source, 'blobs/sha256', hashes[name]), bytes)
    }
    const manifest = {
      schemaVersion: 1, modules: [{ id: 'app.js', sha256: hashes.module }],
      templates: [{ id: 'page', wxmlAst: `sha256:${hashes.template}` }],
      styles: [{ id: 'app.wxss', wxssIr: `sha256:${hashes.style}` }],
      assets: [{ path: 'image.png', sha256: hashes.asset }],
      viewScripts: [{ id: 'wxs:source', sha256: hashes.source }],
      viewCompilation: { compiler: 'weapp-container-wxs', version: '1.0.0', abi: '1.0',
        modules: [{ id: 'wxs:source', sourceSha256: hashes.source, executableSha256: hashes.executable }],
        documents: [{ documentId: 'page', wxmlAst: `sha256:${hashes.template}`,
          expressions: [{ source: 'value.constructor', helper: '__wcWxs0', shorthand: false, executableSha256: hashes.expression }] }] },
      integrity: { algorithm: 'sha256', root: '' },
    }
    const save = async () => {
      manifest.integrity.root = ''
      manifest.integrity.root = sha256(canonical(manifest))
      await writeFile(join(source, 'manifest.json'), canonical(manifest))
    }
    await save()
    const invoke = (check = false, target = destination) => spawnSync(process.execPath,
      [script, '--pack', source, '--out', target, ...(check ? ['--check'] : [])], { encoding: 'utf8' })
    await run({ source, destination, manifest, hashes, save, invoke })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('Harmony copies and checks every original/executable View resource', async () => fixture(async f => {
  const copied = f.invoke()
  assert.equal(copied.status, 0, copied.stderr)
  const report = JSON.parse(copied.stdout)
  assert.equal(report.blobCount, 7)
  assert.equal(report.files.length, 8)
  for (const hash of Object.values(f.hashes)) assert.deepEqual(await readFile(join(f.destination, 'blobs/sha256', hash)), await readFile(join(f.source, 'blobs/sha256', hash)))
  assert.equal(f.invoke(true).status, 0)
}))

test('Harmony accepts legacy manifests without optional View fields', async () => fixture(async f => {
  delete f.manifest.viewScripts
  delete f.manifest.viewCompilation
  await f.save()
  const copied = f.invoke()
  assert.equal(copied.status, 0, copied.stderr)
  assert.equal(JSON.parse(copied.stdout).blobCount, 4)
}))

test('harmony schema v3 renderer profiles are verified before destination replacement', async () => fixture(async f => {
  f.manifest.schemaVersion = 3
  f.manifest.routes = [{ path: 'page' }]
  f.manifest.rendering = { version: '1.0', default: 'skia', pages: { page: 'skyline-compat' } }
  await f.save()
  const copied = f.invoke()
  assert.equal(copied.status, 0, copied.stderr)
  assert.equal(f.invoke(true).status, 0)
  const before = await readFile(join(f.destination, 'manifest.json'))
  for (const rendering of [null, { version: '1.0', default: 'native', pages: {} },
    { version: '1.0', default: 'skia', pages: { missing: 'webview' } },
    { version: '1.0', default: 'skia', pages: {}, unknown: true }]) {
    f.manifest.rendering = rendering
    await f.save()
    const rejected = f.invoke()
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /rendering/)
    assert.deepEqual(await readFile(join(f.destination, 'manifest.json')), before)
  }
}))

for (const [label, reference] of references) {
  for (const failure of ['pointer', 'missing', 'corrupt']) {
    test(`Harmony rejects ${failure} ${label} before replacing destination`, async () => fixture(async f => {
      assert.equal(f.invoke().status, 0)
      const before = await readFile(join(f.destination, 'manifest.json'))
      const [owner, field] = reference(f.manifest)
      const hash = sha256(`${label}:${failure}`)
      owner[field] = failure === 'pointer' ? 'sha256:../bad' : `sha256:${hash}`
      if (failure === 'corrupt') await writeFile(join(f.source, 'blobs/sha256', hash), 'wrong bytes')
      await f.save()
      const rejected = f.invoke()
      assert.notEqual(rejected.status, 0)
      assert.match(rejected.stderr, failure === 'pointer' ? /SHA-256 pointer/ : failure === 'missing' ? /blob is missing/ : /blob digest mismatch/)
      assert.deepEqual(await readFile(join(f.destination, 'manifest.json')), before)
    }))
  }
}

test('Harmony validates manifest root and prevents overlapping output paths', async () => fixture(async f => {
  f.manifest.modules[0].id = 'tampered'
  await writeFile(join(f.source, 'manifest.json'), canonical(f.manifest))
  const rejected = f.invoke()
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /integrity root mismatch/)
  assert.match(f.invoke(false, f.source).stderr, /separate directories/)
  assert.match(f.invoke(false, join(f.source, 'nested')).stderr, /separate directories/)
}))

test('Harmony rejects malformed present compilation tables', async () => fixture(async f => {
  for (const malformed of [null, {}, [], { modules: null, documents: [] }, { modules: [], documents: {} },
    { modules: [], documents: [{ wxmlAst: `sha256:${f.hashes.template}` }] }]) {
    f.manifest.viewCompilation = malformed
    await f.save()
    const rejected = f.invoke()
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /viewCompilation/)
  }
}))

test('Harmony manifest root uses UTF-8 key order', async () => fixture(async f => {
  f.manifest['😀'] = 'astral'
  f.manifest['\uffff'] = 'BMP'
  await f.save()
  const copied = f.invoke()
  assert.equal(copied.status, 0, copied.stderr)
}))
