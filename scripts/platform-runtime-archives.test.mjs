import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { packContainer } from '../tools/container-manifest/src/index.ts'
import { GLUE_REQUIRED_METHODS, PORTABLE_PACK_VALIDATOR_FILES, WASM_REQUIRED_EXPORTS, WEB_SAMPLE_FILES, inventoryGeneratedPackage, rendererRuntimeConfig, stagePackIndex, stageWorkerProductConfig } from './build-web-wasm.mjs'
import { loadPinnedGeneratedModuleParser, verifyGeneratedModuleClosure, verifyRetainedGeneratedModuleParser } from './generated-package-closure.mjs'
import { buildPlatformArchive, installPlatformArchive, preparePlatformArtifact } from './platform-runtime-archives.mjs'
import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs'
import { assertHarmonyNativeRelease, HARMONY_RELEASE_FEATURES, inspectHarmonyHap } from './lib/harmony-artifact-contract.mjs'
import { collectHarmonyPlatformNotices, verifyHarmonyPlatformNotices } from './harmony-platform-notices.mjs'

// Finite, synthetic producer receipts. No Cargo, Hvigor, browser, native SDK or
// device executes in these format/provenance/lifecycle regression tests.
const ROOT = fileURLToPath(new URL('..', import.meta.url)), hash = b => createHash('sha256').update(b).digest('hex'), json = x => Buffer.from(JSON.stringify(x, null, 2) + '\n')
const put = async (base, path, bytes) => { await mkdir(dirname(resolve(base, path)), { recursive: true }); await writeFile(resolve(base, path), bytes) }
const desc = (path, bytes) => ({ path, sha256: hash(bytes), size: bytes.length })
function wasm() {
  const leb = n => { const b = []; do { const x = n & 127; n >>>= 7; b.push(x | (n ? 128 : 0)) } while (n); return b }
  const section = (id, b) => [id, ...leb(b.length), ...b], e = [...leb(WASM_REQUIRED_EXPORTS.length), ...WASM_REQUIRED_EXPORTS.flatMap(name => [...leb(Buffer.byteLength(name)), ...Buffer.from(name), 0, 0])]
  return Buffer.from([0,97,115,109,1,0,0,0, ...section(1,[1,0x60,0,0]), ...section(3,[1,0]), ...section(7,e), ...section(10,[1,2,0,0x0b])])
}
async function fixture(t, execution = 'worker') {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'platform-artifact-finite-'))); t.after(() => rm(directory, { recursive: true, force: true }))
  const site = resolve(directory, 'producer'); await mkdir(site)
  const paths = [...new Set(['Cargo.toml','Cargo.lock','rust-toolchain.toml','scripts/build-web-wasm.mjs','scripts/generated-package-closure.mjs','examples/hosts/web-wasm/renderer-dependency-pins.json',...PORTABLE_PACK_VALIDATOR_FILES,...WEB_SAMPLE_FILES.map(p => `examples/hosts/web-wasm/${p}`)])].sort(), sourceFiles = {}
  for (const path of paths) { const bytes = await readFile(resolve(ROOT, path)); await put(site, `source/${path}`, bytes); sourceFiles[path] = hash(bytes) }
  const browserFiles = []
  for (const path of WEB_SAMPLE_FILES) { const bytes = await readFile(resolve(site, 'source/examples/hosts/web-wasm', path)); await put(site,path,bytes); browserFiles.push({ ...desc(path,bytes), sourcePath:`examples/hosts/web-wasm/${path}` }) }
  const bytes = wasm(), glue = Buffer.from("export const bytes=new URL('container_host_web_bg.wasm',import.meta.url);export default function init(){};export class WebWasmHost{}\n")
  await put(site,'pkg/container_host_web_bg.wasm',bytes); await put(site,'pkg/container_host_web.js',glue)
  const generated = await inventoryGeneratedPackage(site); generated.retainedStatus = 'passed'
  const parser = await loadPinnedGeneratedModuleParser({ root: ROOT, destination: resolve(site,'validation/generated-module-parser') }), closure = await verifyGeneratedModuleClosure(site,generated,parser)
  await verifyRetainedGeneratedModuleParser(parser.provenance)
  const runtime = rendererRuntimeConfig('software'), runtimeBytes = json(runtime); await put(site,'runtime-config.json',runtimeBytes)
  await packContainer(resolve(ROOT,'fixtures/worker-product-browser'),resolve(site,'portable-pack'),{ compilerCommit:'b'.repeat(40),project:resolve(ROOT,'fixtures/worker-product-browser'),configFile:'dom.container.config.json' })
  const manifest = await readFile(resolve(site,'portable-pack/manifest.json')), manifestValue = JSON.parse(manifest)
  const { syncPortablePack } = await import('./portable-pack.mjs')
  const copied = await syncPortablePack({ source:resolve(site,'portable-pack'),destination:resolve(directory,'checked-pack') })
  const blobs = []
  for (const path of copied.files.filter(p => p.startsWith('blobs/sha256/'))) { const bytes = await readFile(resolve(site,'portable-pack',path)); blobs.push({ sha256:hash(bytes),url:`portable-pack/${path}`,size:bytes.length }) }
  const index = { schemaVersion:1,manifest:'portable-pack/manifest.json',manifestSha256:hash(manifest),integrityRoot:manifestValue.integrity.root,blobs }, packIndex = await stagePackIndex(site,index)
  const config = await stageWorkerProductConfig(site,{ index:packIndex,rendererConfig:runtime })
  const assets = { schemaVersion:1,execution,entry:execution==='worker'?'index.html':'legacy.html',entryModule:execution==='worker'?'worker-app.mjs':'app.mjs',files:browserFiles,generatedFiles:[{path:config.path,sha256:config.sha256,size:config.size},config.startupJson] }, assetsBytes = json(assets)
  await put(site,'browser-assets.json',assetsBytes)
  const report = {schemaVersion:1,status:'passed',buildStatus:'passed',ready:true,scope:'synthetic-static-fixture',plan:{profile:'release',target:'wasm32-unknown-unknown',features:['wasm','quickjs-native'],execution,renderer:'software',entry:assets.entry},commands:[{status:'passed',command:['synthetic-fixture']}],customBuildEnvironment:{},toolchain:{versions:Object.fromEntries(['cargo','rustc','rustdoc','clang','ar','wasmBindgen'].map(k=>[k,`synthetic-${k}`]))},source:{status:'passed',sourceCommit:'a'.repeat(40),workingTreeDirty:false,sourceStable:true,sourceFiles,sourceSha256:hash(JSON.stringify(sourceFiles))},browserAssets:{...assets,status:'passed',retainedStatus:'passed',inventory:desc('browser-assets.json',assetsBytes)},generatedModuleParser:parser.provenance,generatedPackage:generated,generatedModuleClosure:closure,artifacts:{wasm:{path:'pkg/container_host_web_bg.wasm',sha256:hash(bytes),bytes:bytes.length},glue:{path:'pkg/container_host_web.js',sha256:hash(glue),bytes:glue.length,interface:{initializerType:'function',hostType:'function',methods:['constructor',...GLUE_REQUIRED_METHODS]}}},rendererDependencies:{status:'passed',retainedStatus:'passed',files:[],runtimeConfig:{path:'runtime-config.json',sha256:hash(runtimeBytes),bytes:runtimeBytes.length,value:runtime}},pack:index,packIndex}
  const reportBytes = json(report); await put(site,'build-report.json',reportBytes)
  const runtimeLicenseFile = resolve(directory,'LICENSE'), license = Buffer.from('finite runtime license fixture'); await writeFile(runtimeLicenseFile,license)
  const expected = {reportSha256:hash(reportBytes),sourceCommit:report.source.sourceCommit,sourceSha256:report.source.sourceSha256,renderer:'software',execution,runtimeLicenseSha256:hash(license)}
  const licensesDirectory = resolve(directory,'notices'); await put(licensesDirectory,'pkg/LICENSE','finite dependency license')
  await put(licensesDirectory,'licenses.json',json({schemaVersion:1,package:'container-host-web',target:'wasm32-unknown-unknown',features:['wasm','quickjs-native'],source:{sourceCommit:expected.sourceCommit,sourceDirty:false},packages:[{name:'pkg',files:[{path:'pkg/LICENSE',sha256:hash('finite dependency license')}]}]}))
  return {directory,site,report,expected,options:{family:'web',producerDirectory:site,expected,licensesDirectory,runtimeLicenseFile}}
}

test('Worker and direct archives retain exact public closures and install from independent manifest pins without private source',async t=>{
  for(const mode of ['worker','legacy']){
    const f=await fixture(t,mode), output=resolve(f.directory,'archives'), result=await buildPlatformArchive({...f.options,outDirectory:output})
    const coordinate=`web/${mode==='legacy'?'direct':'worker'}/software`, artifact=result.manifest.artifacts[0]
    assert.equal(artifact.coordinate,coordinate);assert.ok(artifact.files.every(f=>! /^(source|commands|raw|validation)\//.test(f.path)))
    assert.ok(artifact.files.some(f=>f.path==='release-receipt.json'));assert.ok(artifact.files.some(f=>f.path==='RUNTIME-LICENSE'))
    assert.equal(result.receipt.source.sourceCommit,f.expected.sourceCommit);assert.ok(result.receipt.archiveTool.files.length)
    const manifestPath=resolve(output,'web-runtime-artifacts.lock.json'), pin=hash(readFileSync(manifestPath)), destination=resolve(f.directory,'installed')
    assert.equal(installPlatformArchive({manifestPath,expectedManifestSha256:pin,artifactDirectory:output,coordinate,destination}).status,'installed-verified')
    assert.equal(existsSync(resolve(destination,'source')),false)
    assert.throws(()=>installPlatformArchive({manifestPath,expectedManifestSha256:'0'.repeat(64),artifactDirectory:output,coordinate,destination:resolve(f.directory,'no-install')}),/manifest pin mismatch/)
    const badManifest=structuredClone(result.manifest);badManifest.artifacts[0].files[0].sha256='0'.repeat(64)
    const badPath=resolve(f.directory,'bad-manifest.json'),badBytes=json(badManifest),badDestination=resolve(f.directory,'rejected-install');await writeFile(badPath,badBytes)
    assert.throws(()=>installPlatformArchive({manifestPath:badPath,expectedManifestSha256:hash(badBytes),artifactDirectory:output,coordinate,destination:badDestination}),/installed closure differs/)
    assert.equal(existsSync(badDestination),false,'a rejected installation must be cleaned')
    await assert.rejects(buildPlatformArchive({...f.options,outDirectory:output}),/EEXIST/)
  }
})
test('Worker cannot be relabelled direct, and dirty/dev/stale or modified products are rejected',async t=>{
  for(const mutation of ['mode','dirty','dev','version','notice','blob']){
    const f=await fixture(t)
    if(mutation==='mode')f.expected.execution='legacy'
    if(['dirty','dev','version'].includes(mutation)){
      if(mutation==='dirty')f.report.source.workingTreeDirty=true;else if(mutation==='dev')f.report.plan.profile='dev';else f.report.sdkVersion='0.1.0-preview.5.3'
      const bytes=json(f.report);await put(f.site,'build-report.json',bytes);f.expected.reportSha256=hash(bytes)
    }
    if(mutation==='notice')await put(f.options.licensesDirectory,'pkg/LICENSE','changed')
    if(mutation==='blob')await put(f.site,f.report.pack.blobs[0].url,'changed')
    await assert.rejects(preparePlatformArtifact(f.options))
  }
})

test('Harmony unsigned archives independently install exact HAP bytes and reject legacy/native/source mismatches', async t => {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'harmony-archive-finite-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const site = resolve(directory, 'producer'); await mkdir(site)
  const native = elf(), nativePath = resolve(directory, 'native.so'), hap = resolve(site, 'finite.hap')
  await writeFile(nativePath, native)
  const made = spawnSync('python3', ['-c', "import sys,zipfile\nb=open(sys.argv[2],'rb').read()\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for p in ('module.json','resources.index','ets/modules.abc'):z.writestr(p,b'finite')\n for p in ('libs/arm64-v8a/libentry.so','libs/arm64-v8a/libcontainer_host_harmony.so'):z.writestr(p,b)", hap, nativePath])
  assert.equal(made.status, 0)
  const sourceCommit = 'a'.repeat(40), nativeRelease = { sourceCommit, profile: 'release', target: 'aarch64-unknown-linux-ohos', features: HARMONY_RELEASE_FEATURES, sha256: hash(native), bytes: native.length, receiptSha256: 'b'.repeat(64) }
  const report = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, status: 'passed', profile: 'release', sourceBefore: { sourceCommit, sourceDirty: false }, sourceAfter: { sourceCommit, sourceDirty: false }, nativeRelease, commands: [{ name: 'hvigor', code: 0 }], protocols: { hostServices: '1.0', nativeBridge: '1.0' }, artifact: { path: hap, sha256: hash(await readFile(hap)), bytes: (await readFile(hap)).length, signing: 'unsigned', members: inspectHarmonyHap(hap, nativeRelease) } }
  const reportBytes = json(report); await put(site, 'build-report.json', reportBytes)
  const runtimeLicenseFile = resolve(directory, 'LICENSE'), license = Buffer.from('finite runtime license'); await writeFile(runtimeLicenseFile, license)
  const licensesDirectory = resolve(directory, 'notices'); await put(licensesDirectory, 'pkg/LICENSE', license)
  await put(licensesDirectory, 'licenses.json', json({ schemaVersion: 1, package: 'container-host-harmony', target: nativeRelease.target, features: HARMONY_RELEASE_FEATURES, source: { sourceCommit, sourceDirty: false }, packages: [{ name: 'pkg', files: [{ path: 'pkg/LICENSE', sha256: hash(license) }] }] }))
  const expected = { sourceCommit, reportSha256: hash(reportBytes), runtimeLicenseSha256: hash(license) }
  const options = { family: 'harmony', producerDirectory: site, expected, licensesDirectory, runtimeLicenseFile }
  const output = resolve(directory, 'archives'), result = await buildPlatformArchive({ ...options, outDirectory: output })
  assert.equal(result.manifest.artifacts[0].coordinate, 'harmony/arm64/unsigned')
  assert.deepEqual(result.manifest.artifacts[0].files.map(f => f.path).filter(p => !p.startsWith('licenses/')), ['application-unsigned.hap', 'release-receipt.json', 'RUNTIME-LICENSE'].sort((a,b)=>a.localeCompare(b)))
  const manifestPath = resolve(output, 'harmony-runtime-artifacts.lock.json'), destination = resolve(directory, 'installed')
  installPlatformArchive({ manifestPath, expectedManifestSha256: hash(await readFile(manifestPath)), artifactDirectory: output, coordinate: 'harmony/arm64/unsigned', destination })
  assert.deepEqual(await readFile(resolve(destination, 'application-unsigned.hap')), await readFile(hap))
  for (const variant of ['profile', 'source', 'native']) {
    const changed = structuredClone(report)
    if (variant === 'profile') changed.profile = 'dev'
    if (variant === 'source') changed.sourceAfter.sourceDirty = true
    if (variant === 'native') changed.nativeRelease.sha256 = '0'.repeat(64)
    const bytes = json(changed); await put(site, 'build-report.json', bytes)
    await assert.rejects(preparePlatformArtifact({ ...options, expected: { ...expected, reportSha256: hash(bytes) } }))
  }
})

function elf(){const b=Buffer.alloc(64);b.set([127,69,76,70,2,1]);b.writeUInt16LE(183,18);return b}
test('Harmony requires clean release native provenance and exact AArch64 bytes',async t=>{
 const directory=await realpath(await mkdtemp(resolve(tmpdir(),'harmony-release-contract-')));t.after(()=>rm(directory,{recursive:true,force:true}))
 const path=resolve(directory,'libcontainer_host_harmony.so'),bytes=elf();await writeFile(path,bytes)
 const report={schemaVersion:1,sdkVersion:SDK_RELEASE_VERSION,mode:'build',profile:'release',commit:'a'.repeat(40),sourceBefore:{sourceCommit:'a'.repeat(40),sourceDirty:false},sourceAfter:{sourceCommit:'a'.repeat(40),sourceDirty:false},platforms:[{platform:'harmony',mode:'build',profile:'release',status:'passed',target:'aarch64-unknown-linux-ohos',engine:'quickjs',features:HARMONY_RELEASE_FEATURES.join(','),cargo:{status:'passed',exitCode:0},artifact:{path:'target/aarch64-unknown-linux-ohos/release/libcontainer_host_harmony.so',exists:true,bytes:bytes.length,sha256:hash(bytes)}}]}
 assert.equal(assertHarmonyNativeRelease(report,path).profile,'release')
 for(const mutation of ['profile','source','features','hash']){const bad=structuredClone(report);if(mutation==='profile')bad.profile='dev';if(mutation==='source')bad.sourceAfter.sourceDirty=true;if(mutation==='features')bad.platforms[0].features='harmony,arkui';if(mutation==='hash')bad.platforms[0].artifact.sha256='0'.repeat(64);assert.throws(()=>assertHarmonyNativeRelease(bad,path))}
 const hap=resolve(directory,'fixture.hap'),make=extra=>spawnSync('python3',['-c',"import sys,zipfile\nb=open(sys.argv[2],'rb').read()\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for p in ('module.json','resources.index','ets/modules.abc'):z.writestr(p,b'finite')\n for p in ('libs/arm64-v8a/libentry.so','libs/arm64-v8a/libcontainer_host_harmony.so'):z.writestr(p,b)\n if len(sys.argv)>3:z.writestr(sys.argv[3],b'private')",hap,path,...(extra?[extra]:[])])
 assert.equal(make().status,0);assert.equal(inspectHarmonyHap(hap,{sha256:hash(bytes),bytes:bytes.length}).length,5)
 for (const member of ['resources/private.rs', '../', 'resources/.git/', 'module.json/']) {
  assert.equal(make(member).status,0);assert.throws(()=>inspectHarmonyHap(hap,{sha256:hash(bytes),bytes:bytes.length}),/closure/)
 }
 assert.equal(make().status,0);assert.throws(()=>inspectHarmonyHap(hap,{sha256:'0'.repeat(64),bytes:bytes.length}),/closure/)
})

test('Harmony archives require the exact SDK C++ runtime notices in a separate verified closure', async t => {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'harmony-platform-notices-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const site = resolve(directory, 'producer'), sdk = resolve(directory, 'sdk'), notices = resolve(directory, 'platform-notices')
  await mkdir(site)
  const native = elf(), cpp = Buffer.concat([elf(), Buffer.alloc(16, 1)]), hap = resolve(site, 'finite.hap')
  const runtimePath = 'native/llvm/lib/aarch64-linux-ohos/libc++_shared.so'
  const sdkMetadata = { apiVersion: '24', displayName: 'Native', meta: { metaVersion: '3.0.0' }, path: 'native', releaseType: 'Release', version: '6.1.1.125' }
  await put(sdk, runtimePath, cpp); await put(sdk, 'native/NOTICE.txt', 'finite complete SDK runtime notice')
  await put(sdk, 'native/oh-uni-package.json', json(sdkMetadata))
  const made = spawnSync('python3', ['-c', `import base64,json,sys,zipfile
v=json.load(sys.stdin)
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for p in ('module.json','resources.index','ets/modules.abc'):z.writestr(p,b'finite')
 for p in ('libs/arm64-v8a/libentry.so','libs/arm64-v8a/libcontainer_host_harmony.so'):z.writestr(p,base64.b64decode(v['native']))
 z.writestr('libs/arm64-v8a/libc++_shared.so',base64.b64decode(v['cpp']))`, hap], { input: JSON.stringify({ native: native.toString('base64'), cpp: cpp.toString('base64') }) })
  assert.equal(made.status, 0)
  const sourceCommit = 'a'.repeat(40), nativeRelease = { sourceCommit, profile: 'release', target: 'aarch64-unknown-linux-ohos', features: HARMONY_RELEASE_FEATURES, sha256: hash(native), bytes: native.length, receiptSha256: 'b'.repeat(64) }
  const report = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, status: 'passed', profile: 'release', sourceBefore: { sourceCommit, sourceDirty: false }, sourceAfter: { sourceCommit, sourceDirty: false }, nativeRelease, sdk: { source: sdk, compileSdk: 24 }, commands: [{ name: 'hvigor', code: 0 }], protocols: { hostServices: '1.0', nativeBridge: '1.0' }, artifact: { path: hap, sha256: hash(await readFile(hap)), bytes: (await readFile(hap)).length, signing: 'unsigned', members: inspectHarmonyHap(hap, nativeRelease) } }
  const reportBytes = json(report), reportSha256 = hash(reportBytes)
  await put(site, 'build-report.json', reportBytes)
  const collected = collectHarmonyPlatformNotices({ producerDirectory: site, sdkDirectory: sdk, outDirectory: notices })
  assert.equal(collected.status, 'collected-verified')
  assert.equal(collected.identity.runtime.sha256, hash(cpp))
  assert.throws(() => collectHarmonyPlatformNotices({ producerDirectory: site, sdkDirectory: sdk, outDirectory: notices }), /EEXIST/)
  const verified = () => verifyHarmonyPlatformNotices({ directory: notices, report, reportSha256, identitySha256: collected.identitySha256 })
  assert.deepEqual([...verified().files.keys()].sort(), ['platform-notices/OHOS-NATIVE-NOTICE.txt', 'platform-notices/OHOS-NATIVE-SDK.json', 'platform-notices/identity.json'].sort())
  const runtimeLicenseFile = resolve(directory, 'LICENSE'), license = Buffer.from('finite runtime license')
  await writeFile(runtimeLicenseFile, license)
  const licensesDirectory = resolve(directory, 'cargo-notices')
  await put(licensesDirectory, 'pkg/LICENSE', license)
  const cargoManifest = json({ schemaVersion: 1, package: 'container-host-harmony', target: nativeRelease.target, features: HARMONY_RELEASE_FEATURES, source: { sourceCommit, sourceDirty: false }, packages: [{ name: 'pkg', files: [{ path: 'pkg/LICENSE', sha256: hash(license) }] }] })
  await put(licensesDirectory, 'licenses.json', cargoManifest)
  const options = { family: 'harmony', producerDirectory: site, expected: { sourceCommit, reportSha256, platformNoticesSha256: collected.identitySha256, runtimeLicenseSha256: hash(license) }, licensesDirectory, platformNoticesDirectory: notices, runtimeLicenseFile }
  await assert.rejects(preparePlatformArtifact({ ...options, platformNoticesDirectory: undefined }), /requires its SDK platform notices/)
  await assert.rejects(preparePlatformArtifact({ ...options, expected: { ...options.expected, platformNoticesSha256: undefined } }), /Independent SDK platform notice identity pin/)
  const output = resolve(directory, 'archives'), built = await buildPlatformArchive({ ...options, outDirectory: output })
  const lockPath = resolve(output, 'harmony-runtime-artifacts.lock.json'), installed = resolve(directory, 'installed')
  installPlatformArchive({ manifestPath: lockPath, expectedManifestSha256: hash(await readFile(lockPath)), artifactDirectory: output, coordinate: built.receipt.coordinate, destination: installed })
  assert.deepEqual(await readFile(resolve(installed, 'platform-notices/OHOS-NATIVE-NOTICE.txt')), await readFile(resolve(sdk, 'native/NOTICE.txt')))
  assert.deepEqual(await readFile(resolve(licensesDirectory, 'licenses.json')), cargoManifest)
  await put(notices, 'OHOS-NATIVE-NOTICE.txt', 'tampered notice')
  assert.throws(verified, /digest\/size mismatch/)
  await put(notices, 'OHOS-NATIVE-NOTICE.txt', 'finite complete SDK runtime notice')
  const identityPath = resolve(notices, 'identity.json'), identityBytes = await readFile(identityPath)
  const rewritten = JSON.parse(identityBytes), changedNotice = Buffer.from('replacement NOTICE with rewritten local hashes')
  await put(notices, 'OHOS-NATIVE-NOTICE.txt', changedNotice)
  rewritten.notice.sha256 = hash(changedNotice); rewritten.notice.size = changedNotice.length
  await writeFile(identityPath, json(rewritten)); assert.throws(verified, /Independent SDK platform notice identity pin mismatch/)
  await put(notices, 'OHOS-NATIVE-NOTICE.txt', 'finite complete SDK runtime notice')
  for (const mutation of ['runtime', 'sdk', 'report', 'unknown']) {
    const identity = JSON.parse(identityBytes)
    if (mutation === 'runtime') identity.runtime.sha256 = '0'.repeat(64)
    if (mutation === 'sdk') identity.sdk.version = '1.0.0.0'
    if (mutation === 'report') identity.producerReportSha256 = '0'.repeat(64)
    if (mutation === 'unknown') identity.sourcePath = '/private/source'
    const changed = json(identity); await writeFile(identityPath, changed)
    assert.throws(() => verifyHarmonyPlatformNotices({ directory: notices, report, reportSha256, identitySha256: hash(changed) }))
  }
  await writeFile(identityPath, identityBytes)
  await put(sdk, runtimePath, Buffer.concat([cpp, Buffer.from('wrong SDK runtime')]))
  assert.throws(() => collectHarmonyPlatformNotices({ producerDirectory: site, sdkDirectory: sdk, outDirectory: resolve(directory, 'wrong-runtime') }), /differs from the packaged HAP bytes/)
  await put(sdk, runtimePath, cpp)
  await put(sdk, 'native/oh-uni-package.json', Buffer.from(JSON.stringify(sdkMetadata).replace('"path":"native"', '"path":"private","path":"native"')))
  assert.throws(() => collectHarmonyPlatformNotices({ producerDirectory: site, sdkDirectory: sdk, outDirectory: resolve(directory, 'duplicate-sdk') }), /duplicate compiler JSON field/)
  await put(notices, 'source.js', 'private')
  assert.throws(verified, /Unreviewed platform notice closure/)
})
