import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalize, sha256 } from '../tools/container-manifest/src/index.mjs'
import { syncIOSPortablePack } from './sync-ios-portable-pack.mjs'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'weapp-ios-pack-'))
  try {
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    await mkdir(join(source, 'blobs/sha256'), { recursive: true })
    const contents = { module: 'App({});', template: '{"version":1,"nodes":[]}', style: '{"version":1,"rules":[]}', viewScript: 'module.exports={read:function(){return 1}}', asset: 'binary-resource' }
    const hashes = {}
    for (const [name, sourceText] of Object.entries(contents)) {
      hashes[name] = sha256(Buffer.from(sourceText))
      await writeFile(join(source, 'blobs/sha256', hashes[name]), sourceText)
    }
    const manifest = {
      schemaVersion: 1, protocolVersion: '1.0', compiler: { name: 'weapp-vite', commit: 'test', platform: 'weapp' },
      app: { appJson: 'app.json', entryModule: 'app.js' },
      modules: [{ id: 'module:app.js', sha256: hashes.module, format: 'commonjs', scope: 'app' }],
      routes: [{ id: 'route:pages/home', path: 'pages/home', kind: 'page', entryModule: 'app.js' }],
      templates: [{ id: 'template:pages/home.wxml', wxmlAst: 'sha256:' + hashes.template, bindings: [] }],
      styles: [{ id: 'style:app.wxss', wxssIr: 'sha256:' + hashes.style, scope: 'app' }],
      viewScripts: [{ id: 'wxs:example', sha256: hashes.viewScript }],
      assets: [{ path: '中文/😀.png', mime: 'application/octet-stream', sha256: hashes.asset, size: Buffer.byteLength(contents.asset) }],
      capabilities: {}, integrity: { algorithm: 'sha256', root: '' },
    }
    manifest.integrity.root = sha256(Buffer.from(canonicalize(manifest)))
    await writeFile(join(source, 'manifest.json'), canonicalize(manifest) + '\n')
    await run({ root, source, destination, manifest, hashes })
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function addCompilation(options) {
  for (const [name, text] of Object.entries({ compiledModule: 'module.exports=__wcWxs0.read([],"constructor")', compiledExpression: '__wcWxs0.read(data,"constructor")' })) {
    options.hashes[name] = sha256(Buffer.from(text))
    await writeFile(join(options.source, 'blobs/sha256', options.hashes[name]), text)
  }
  options.manifest.viewCompilation = {
    compiler: 'weapp-container-wxs', version: '1.0.0', abi: '1.0',
    modules: [{id:'wxs:example',sourceSha256:options.hashes.viewScript,executableSha256:options.hashes.compiledModule,helper:'__wcWxs0'}],
    documents: [{documentId:'pages/home.wxml',wxmlAst:'sha256:'+options.hashes.template,
      expressions:[{source:'data.constructor',shorthand:false,executableSha256:options.hashes.compiledExpression,helper:'__wcWxs0'}]}],
  }
  await writeManifest(options)
}

async function writeManifest(options) {
  options.manifest.integrity.root = ''
  options.manifest.integrity.root = sha256(Buffer.from(canonicalize(options.manifest)))
  await writeFile(join(options.source, 'manifest.json'), canonicalize(options.manifest) + '\n')
}

test('copies and checks every reference, including separate WXS and binary assets', async () => fixture(async options => {
  const report = await syncIOSPortablePack(options)
  assert.equal(report.blobCount, 5)
  assert.equal(report.integrityRoot, options.manifest.integrity.root)
  assert.equal((await syncIOSPortablePack({ ...options, check: true })).mode, 'check')
  assert.deepEqual(await readFile(join(options.destination, 'manifest.json')), await readFile(join(options.source, 'manifest.json')))
}))

test('corrupt input preserves previous complete destination', async () => fixture(async options => {
  await syncIOSPortablePack(options)
  const before = await readFile(join(options.destination, 'manifest.json'))
  await writeFile(join(options.source, 'blobs/sha256', options.hashes.viewScript), 'corrupt')
  await assert.rejects(syncIOSPortablePack(options), /blob SHA-256 mismatch/)
  assert.deepEqual(await readFile(join(options.destination, 'manifest.json')), before)
}))

test('root corruption is rejected before destination writes', async () => fixture(async options => {
  options.manifest.compiler.commit = 'tampered'
  await writeFile(join(options.source, 'manifest.json'), canonicalize(options.manifest))
  await assert.rejects(syncIOSPortablePack(options), /integrity root mismatch/)
  await assert.rejects(readFile(join(options.destination, 'manifest.json')), { code: 'ENOENT' })
}))

test('check rejects extra files and changed blob bytes', async () => fixture(async options => {
  await syncIOSPortablePack(options)
  const extra = join(options.destination, 'stale-blob')
  await writeFile(extra, 'stale')
  await assert.rejects(syncIOSPortablePack({ ...options, check: true }), /inventory differs/)
  await rm(extra)
  await writeFile(join(options.destination, 'blobs/sha256', options.hashes.module), 'changed')
  await assert.rejects(syncIOSPortablePack({ ...options, check: true }), /bytes differ/)
}))

test('rejects nested destination paths', async () => fixture(async options => {
  await assert.rejects(syncIOSPortablePack({ ...options, destination: join(options.source, 'nested') }), /separate directories/)
}))

test('compiled packs copy and check source, WXS executable and WXML executable blobs', async () => fixture(async options => {
  await addCompilation(options)
  const report=await syncIOSPortablePack(options)
  assert.equal(report.blobCount,7)
  for (const name of ['viewScript','compiledModule','compiledExpression']) {
    const path=join('blobs/sha256',options.hashes[name])
    assert.deepEqual(await readFile(join(options.destination,path)),await readFile(join(options.source,path)))
    assert.ok(report.files.includes(path))
  }
  assert.equal((await syncIOSPortablePack({...options,check:true})).mode,'check')
}))

test('missing compiled WXS bytes are rejected before replacing the previous pack', async () => fixture(async options => {
  await addCompilation(options)
  await syncIOSPortablePack(options)
  const before=await readFile(join(options.destination,'manifest.json'))
  await rm(join(options.source,'blobs/sha256',options.hashes.compiledModule))
  await assert.rejects(syncIOSPortablePack(options),{code:'ENOENT'})
  assert.deepEqual(await readFile(join(options.destination,'manifest.json')),before)
}))

test('corrupt compiled expression bytes are rejected before destination writes', async () => fixture(async options => {
  await addCompilation(options)
  await writeFile(join(options.source,'blobs/sha256',options.hashes.compiledExpression),'corrupted executable')
  await assert.rejects(syncIOSPortablePack(options),/blob SHA-256 mismatch/)
  await assert.rejects(readFile(join(options.destination,'manifest.json')),{code:'ENOENT'})
}))

test('malformed compilation hash and collection declarations fail explicitly', async () => fixture(async options => {
  await addCompilation(options)
  options.manifest.viewCompilation.modules[0].executableSha256='../outside'
  await writeManifest(options)
  await assert.rejects(syncIOSPortablePack(options),/viewCompilation.modules.executableSha256 digest/)
  options.manifest.viewCompilation.documents={}
  await writeManifest(options)
  await assert.rejects(syncIOSPortablePack(options),/modules and documents arrays/)
  delete options.manifest.viewCompilation
  await writeManifest(options)
  assert.equal((await syncIOSPortablePack(options)).blobCount,5,'older manifests remain supported')
}))
