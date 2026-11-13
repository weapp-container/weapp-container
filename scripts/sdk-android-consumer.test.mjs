import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ANDROID_CONSUMER_FILES, ANDROID_COORDINATE, installAndroidConsumerArchive, inspectAndroidConsumerPackage, prepareAndroidConsumerHarness, sha256, verifyAndroidConsumerDependencies, verifyInstalledAndroidArchive } from './lib/sdk-android-consumer-harness.mjs';
import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs';
import { RUNTIME_REPOSITORY } from '../sdk/contract/tools/runtime-artifacts.mjs';

// Synthetic archive/ELF/Git fixtures. These tests execute the public downloader
// and unpacker, but execute no Gradle, Rust, Android runtime or device.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const json = value => JSON.stringify(value, null, 2) + '\n';
function put(directory, path, bytes) { const target = resolve(directory, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); return target; }
function records(directory, prefix = '') {
  return readdirSync(resolve(directory, prefix), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? records(directory, `${prefix}${entry.name}/`) : [{ path: `${prefix}${entry.name}`, bytes: readFileSync(resolve(directory, prefix, entry.name)) }]);
}
function python(code, args, directory) {
  const result = spawnSync(process.env.PYTHON ?? 'python3', ['-c', code, ...args], { cwd: directory, encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr); return result;
}
function zip(path, files, directory) {
  const request = put(directory, `zip-${readdirSync(directory).length}.json`, json(files.map(({ path, bytes }) => ({ path, base64: Buffer.from(bytes).toString('base64') }))));
  python("import base64,json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for f in json.load(open(sys.argv[2])):z.writestr(f['path'],base64.b64decode(f['base64']))", [path, request], directory);
}
function elf(library, machine, { alignment = 16384, dependency = 'libc.so' } = {}) {
  const strings = Buffer.from(`\0${library}\0${dependency}\0`), bytes = Buffer.alloc(256 + strings.length);
  bytes.set([127,69,76,70,2,1]); bytes.writeUInt16LE(machine,18); bytes.writeBigUInt64LE(64n,32); bytes.writeUInt16LE(56,54); bytes.writeUInt16LE(2,56);
  bytes.writeUInt32LE(1,64); bytes.writeBigUInt64LE(BigInt(bytes.length),96); bytes.writeBigUInt64LE(BigInt(bytes.length),104); bytes.writeBigUInt64LE(BigInt(alignment),112);
  bytes.writeUInt32LE(2,120); bytes.writeBigUInt64LE(176n,128); bytes.writeBigUInt64LE(176n,136); bytes.writeBigUInt64LE(80n,152);
  for (const [index, kind, value] of [[0,5,256],[1,10,strings.length],[2,14,1],[3,1,library.length+2],[4,0,0]]) { bytes.writeBigInt64LE(BigInt(kind),176+index*16); bytes.writeBigUInt64LE(BigInt(value),184+index*16); }
  bytes.set(strings,256); return bytes;
}
function sdkSource(directory, extra = false) {
  mkdirSync(directory);
  const files = new Map([['ORIGIN.json', Buffer.from(json({ sourceCommit: 'f'.repeat(40) }))], ['.gitignore', Buffer.from('/consumer/build/\n')], ['library/src/main/java/com/sonofmagic/weapp/container/sdk/Fixture.kt', Buffer.from('// finite SDK wrapper\n')], ...ANDROID_CONSUMER_FILES.map(path => [`consumer/${path}`, Buffer.from(`finite committed source: ${path}\n`)])]);
  if (extra) files.set('consumer/unreviewed.gradle', Buffer.from('extra source'));
  for (const [path, bytes] of files) put(directory, path, bytes);
  function git(args) { const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', timeout: 10_000 }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
  git(['init', '--quiet']); git(['add', '.']);
  const commit = () => git(['-c', 'user.name=Finite fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'finite source']);
  commit(); const base = git(['rev-parse', 'HEAD']);
  const inventory = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, sourceBaseCommit: base, review: 'finite fixture', historicalOrigin: { path: 'ORIGIN.json', sha256: sha256(files.get('ORIGIN.json')) }, files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256(bytes), mode: '100644' })) };
  const bytes = Buffer.from(json(inventory)); put(directory, 'SOURCE-INVENTORY.json', bytes); git(['add', '.']); commit();
  return { sourceCommit: git(['rev-parse', 'HEAD']), sourceInventorySha256: sha256(bytes), sourceDirty: false, bytes };
}
function fixture(t) {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), 'android-consumer-finite-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceRoot = resolve(directory, 'sdk-source'), source = sdkSource(sourceRoot), payload = resolve(directory, 'payload'); mkdirSync(payload);
  const native = [], binaries = [], aarFiles = [{ path: 'AndroidManifest.xml', bytes: 'finite manifest' }, { path: 'classes.jar', bytes: 'finite compiled class boundary' }, { path: 'assets/weapp-container/LICENSE', bytes: 'finite Apache notice' }, { path: 'assets/weapp-container/native/licenses.json', bytes: 'finite native notices' }];
  for (const [abi, target, machine] of [['arm64-v8a','aarch64-linux-android',183], ['x86_64','x86_64-linux-android',62]]) {
    const artifacts = [];
    for (const library of ['libweapp_container_sdk.so','libweapp_container_android.so','libc++_shared.so']) {
      const bytes = elf(library,machine); aarFiles.push({ path: `jni/${abi}/${library}`, bytes });
      binaries.push({ abi, library, machine, sha256: sha256(bytes), soname: library, needed: ['libc.so'], loadAlignments: [16384] });
      if (library !== 'libweapp_container_android.so') artifacts.push({ file: library, bytes: bytes.length, sha256: sha256(bytes) });
    }
    native.push({ schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, abiVersion: 1, status: 'built', target, platform: 'android', profile: 'release', features: ['quickjs-native-android','skia-gpu-gles'], viewDiagnostics: 'off', sourceCommit: 'a'.repeat(40), sourceDirty: false, artifacts });
  }
  const aarRelative = `com/sonofmagic/weapp/weapp-container-android/${SDK_RELEASE_VERSION}/weapp-container-android-${SDK_RELEASE_VERSION}.aar`;
  const aar = put(payload, `maven/${aarRelative}`, ''); zip(aar, aarFiles, directory);
  const distribution = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, status: 'passed', ...source, bytes: undefined, artifactRoot: 'maven', native, binaries, mavenArtifacts: [{ file: aarRelative, sha256: sha256(readFileSync(aar)) }] };
  put(payload, 'distribution.json', json(distribution)); put(payload, 'SDK-SOURCE-INVENTORY.json', source.bytes); put(payload, 'RUNTIME-LICENSE', 'finite private runtime license');
  const archive = resolve(directory, 'android-sdk-finite.tar.gz');
  python("import pathlib,sys,tarfile\nroot=pathlib.Path(sys.argv[1])\nwith tarfile.open(sys.argv[2],'w:gz') as t:\n for f in sorted(root.rglob('*')):\n  if f.is_file():t.add(f,arcname=f.relative_to(root).as_posix(),recursive=False)", [payload,archive], directory);
  const manifest = { schemaVersion: 1, runtimeVersion: SDK_RELEASE_VERSION, abiVersion: 1, source: { repository: RUNTIME_REPOSITORY, releaseTag: `runtime-v${SDK_RELEASE_VERSION}` }, artifacts: [{ component: 'android-sdk', platform: 'android', arch: 'universal', architectures: ['arm64-v8a','x86_64'], fileName: 'android-sdk-finite.tar.gz', size: readFileSync(archive).length, sha256: sha256(readFileSync(archive)) }] };
  const manifestPath = put(directory, 'manifest.json', json(manifest)), work = resolve(directory, 'work'); mkdirSync(work);
  return { directory, sourceRoot, source, payload, aar, aarFiles, binaries, distribution, manifestPath, work,
    options: { manifestPath, expectedManifestSha256: sha256(readFileSync(manifestPath)), artifactDirectory: directory, workDirectory: work, installDirectory: resolve(work, 'installed') } };
}

test('fresh Android SDK installation uses the public contract and rejects reuse, changed Maven bytes and wrong pins', async t => {
  const f = fixture(t), input = await installAndroidConsumerArchive(f.options), verified = verifyInstalledAndroidArchive(f.options.installDirectory);
  assert.equal(input.installation.reused, false); assert.equal(verified.distribution.sourceCommit, f.source.sourceCommit);
  assert.equal(verified.aarRecord.sha256, sha256(readFileSync(f.aar)));
  await assert.rejects(installAndroidConsumerArchive(f.options), /never-existing/);
  const other = resolve(f.directory, 'other'); mkdirSync(other);
  await assert.rejects(installAndroidConsumerArchive({ ...f.options, workDirectory: other, installDirectory: resolve(other,'installed'), expectedManifestSha256: '0'.repeat(64) }), /manifest pin/);
  writeFileSync(verified.aar, 'modified Maven'); assert.throws(() => verifyInstalledAndroidArchive(f.options.installDirectory), /Installed SDK changed/);
});

test('consumer sources come from the exact committed reviewed closure and exclude dirty files, builds and wrapper sources', t => {
  const f = fixture(t), destination = resolve(f.directory,'consumer');
  put(f.sourceRoot,'consumer/build/ignored.rs','private ignored output'); put(f.sourceRoot,'consumer/build.gradle.kts','dirty checkout source');
  const result = prepareAndroidConsumerHarness({ sourceRoot: f.sourceRoot, receipt: f.distribution, destination });
  assert.equal(result.files.length,8); assert.equal(existsSync(resolve(destination,'build')),false); assert.equal(existsSync(resolve(destination,'library')),false);
  assert.match(readFileSync(resolve(destination,'build.gradle.kts'),'utf8'),/finite committed source/);
  assert.throws(()=>prepareAndroidConsumerHarness({sourceRoot:f.sourceRoot,receipt:{...f.distribution,sourceInventorySha256:'0'.repeat(64)},destination:resolve(f.directory,'bad')}),/inventory hash/);
  const extra = resolve(f.directory,'extra-source'), source = sdkSource(extra,true);
  assert.throws(()=>prepareAndroidConsumerHarness({sourceRoot:extra,receipt:source,destination:resolve(f.directory,'extra-consumer')}),/explicitly reviewed source closure/);
});

test('AAR/APK inspectors bind all original JNI/runtime bytes, notices, architecture, dynamic names and 16 KB segments', t => {
  const f=fixture(t), original=inspectAndroidConsumerPackage({archive:f.aar,kind:'aar',binaries:f.binaries,workDirectory:f.work});
  const expected=original.files.filter(file=>file.path.startsWith('assets/'));
  const base=f.aarFiles.map(file=>({...file,path:file.path.startsWith('jni/')?file.path.replace('jni/','lib/'):file.path})).filter(file=>file.path!=='classes.jar');
  base.push({path:'classes.dex',bytes:'finite dex'});
  const apk=resolve(f.directory,'consumer.apk');zip(apk,base,f.directory);
  assert.equal(inspectAndroidConsumerPackage({archive:apk,kind:'apk',binaries:original.binaries,files:expected,workDirectory:f.work}).binaries.length,6);
  for(const mutation of ['jni','notice','missing','extra','duplicate','alignment','soname']) {
    let files=base.map(file=>({...file})), binaries=structuredClone(original.binaries);
    if(mutation==='jni')files.find(file=>file.path.endsWith('libweapp_container_android.so')).bytes=Buffer.from('stripped or replaced JNI');
    if(mutation==='notice')files.find(file=>file.path.endsWith('/LICENSE')).bytes='modified';
    if(mutation==='missing')files=files.filter(file=>file.path!=='lib/arm64-v8a/libweapp_container_android.so');
    if(mutation==='extra')files.push({path:'lib/arm64-v8a/libunreviewed.so',bytes:elf('libunreviewed.so',183)});
    if(mutation==='duplicate')files.push({...files[0]});
    if(mutation==='alignment'||mutation==='soname') {
      const file=files.find(file=>file.path==='lib/arm64-v8a/libweapp_container_android.so');
      file.bytes=elf('libweapp_container_android.so',183,mutation==='alignment'?{alignment:8192}:{dependency:'/absolute/libc.so'});
      const bound=binaries.find(item=>item.abi==='arm64-v8a'&&item.library==='libweapp_container_android.so');bound.sha256=sha256(file.bytes);bound.bytes=file.bytes.length;
    }
    zip(apk,files,f.directory);assert.throws(()=>inspectAndroidConsumerPackage({archive:apk,kind:'apk',binaries,files:expected,workDirectory:f.work}),/ERR_ANDROID_CONSUMER_PACKAGE/);
  }
});

test('resolved dependencies must select the original installed SDK version/AAR and unchanged external artifact bytes', t => {
  const f=fixture(t), maven=resolve(f.payload,'maven'), bytes=readFileSync(f.aar);
  const base={schemaVersion:1,configuration:'releaseRuntimeClasspath',sdkRepository:maven,sdkRepositoryPolicy:'exclusive-installed-Maven-module',artifacts:[{...ANDROID_COORDINATE,classifier:null,extension:'aar',file:f.aar,size:bytes.length,sha256:sha256(bytes)}]};
  const path=put(f.directory,'dependencies.json',json(base));assert.equal(verifyAndroidConsumerDependencies({receiptPath:path,maven,aarSha256:sha256(bytes)}).artifacts.length,1);
  for(const mutation of ['version','hash','duplicate','repository']) {
    const changed=structuredClone(base);
    if(mutation==='version')changed.artifacts[0].version='0.1.0-preview.5.3';
    if(mutation==='hash')changed.artifacts[0].sha256='0'.repeat(64);
    if(mutation==='duplicate')changed.artifacts.push({...changed.artifacts[0]});
    if(mutation==='repository')changed.sdkRepositoryPolicy='unrestricted';
    writeFileSync(path,json(changed));assert.throws(()=>verifyAndroidConsumerDependencies({receiptPath:path,maven,aarSha256:sha256(bytes)}));
  }
});

test('CLI refuses directory-only inputs and existing output, and retains failed download receipts without calling Gradle', t => {
  const f=fixture(t), cli=resolve(ROOT,'scripts/sdk-android-consumer.mjs');
  for(const args of [['--sdk',f.payload],['--manifest',f.manifestPath,'--out',f.work],['--manifest',f.manifestPath,'--out',f.work,'--out',f.work]]) {
    const result=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10_000});assert.equal(result.status,1);
  }
  const output=resolve(f.directory,'failed-build'), result=spawnSync(process.execPath,[cli,'--manifest',resolve(f.directory,'absent-lock.json'),'--out',output],{encoding:'utf8',timeout:10_000});
  assert.equal(result.status,1);const report=JSON.parse(readFileSync(resolve(output,'validation.json')));assert.equal(report.status,'failed');assert.deepEqual(report.checks,[]);assert.equal(report.deviceExecution,'not-run');assert.equal(report.releaseApk,undefined);
});
