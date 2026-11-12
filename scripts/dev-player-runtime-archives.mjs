#!/usr/bin/env node
// Private release preparation only. Uses the contract's existing strict installer.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectArtifact } from '../sdk/contract/tools/runtime-artifacts.mjs';
import { SDK_RELEASE_VERSION, assertNativeProducer, assertNativeProducerSet, verifyNativeProducerFiles } from './lib/sdk-current-release.mjs';
import { gitSource, reviewedSdkSource } from './lib/sdk-reviewed-sources.mjs';
import { assertDistributionIdentity, distributionIdentity } from './lib/showcase-policy.mjs';
import { SHOWCASE_NATIVE_FONT } from './lib/showcase-native-font.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = SDK_RELEASE_VERSION;
// This generation contains newly compiled runtime and wrapper producers.
const nativeVersion = SDK_RELEASE_VERSION;
const archiveVersion = identity => identity.distributionProfile === 'restricted-showcase'
  ? `${version}-showcase.${identity.policySha256.slice(0, 12)}` : version;
const androidMavenPrefix = 'com/sonofmagic/weapp/weapp-container-android/';
const androidMavenFiles = new Set([
  ...['-sources.jar', '.aar', '.module', '.pom'].map(extension => `${androidMavenPrefix}${version}/weapp-container-android-${version}${extension}`),
  `${androidMavenPrefix}maven-metadata.xml`,
].flatMap(file => ['', '.md5', '.sha1', '.sha256', '.sha512'].map(checksum => file + checksum)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha(JSON.stringify(value));
const inside = (base, path) => { const value = relative(base, path); return !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`); };
const present = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const matrix = {
  macos: { sdk: 'desktop/macos-universal', sdkPlatform: 'macos-universal', receipt: 'package.json', status: 'verified', component: 'desktop-sdk', targets: [['aarch64-apple-darwin', 'arm64'], ['x86_64-apple-darwin', 'x86_64']] },
  windows: { sdk: 'desktop/windows-x64', sdkPlatform: 'windows-x64', receipt: 'package.json', status: 'verified', component: 'desktop-sdk', targets: [['x86_64-pc-windows-msvc', 'x86_64']] },
  linux: { sdk: 'desktop/linux-x64', sdkPlatform: 'linux-x64', receipt: 'package.json', status: 'verified', component: 'desktop-sdk', targets: [['x86_64-unknown-linux-gnu', 'x86_64']] },
  ios: { sdk: 'ios/WeappContainer', receipt: 'build.json', status: 'built', component: 'ios-sdk', targets: [['aarch64-apple-ios', 'arm64-device'], ['aarch64-apple-ios-sim', 'arm64-simulator'], ['x86_64-apple-ios', 'x86_64-simulator']] },
  android: { sdk: 'android', receipt: 'distribution.json', status: 'passed', component: 'android-sdk', targets: [['aarch64-linux-android', 'arm64-v8a'], ['x86_64-linux-android', 'x86_64']] },
};
const sourceRoots = { android: resolve(root, 'sdk/android'), ios: resolve(root, 'sdk/ios'), desktop: resolve(root, 'sdk/desktop') };
const iosPublicDocuments = Object.freeze(['docs/EMBEDDING.md', 'docs/window-metrics.md']);
function wrapperInput(base, name, expected, provenance = 'reviewed-sdk-source') {
  return input(base, name, { sha256: expected.sha256, bytes: expected.size }, provenance);
}
function nativeLibraryNames(platform) {
  return platform === 'windows' ? ['weapp_container_sdk.dll.lib', 'weapp_container_sdk.dll'] : ['libweapp_container_sdk.a', `libweapp_container_sdk.${platform === 'android' || platform === 'linux' ? 'so' : 'dylib'}`];
}
function nativeArtifactAllowed(platform, name) {
  if (/^(?:weapp_container_sdk(?:_gl)?\.h|platform-notices\/[A-Za-z0-9._-]+)$/.test(name)) return true;
  if (nativeLibraryNames(platform).includes(name)) return true;
  return platform === 'windows' && name === 'weapp_container_sdk.lib' || platform === 'android' && name === 'libc++_shared.so';
}
function safe(name) {
  if (typeof name !== 'string' || !name || name.length > 4096 || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..') || /[\\:\x00-\x1f\x7f]/.test(name)) throw Error('Unsafe archive input path');
  if (/(^|\/)(\.git|\.env[^/]*|node_modules|target|consumer|build|cache|\.gradle)(\/|$)|\.(?:rs|c|cpp|cc|dart|js|ts|tsx)$/i.test(name)) throw Error(`Core source, consumer or cache is forbidden: ${name}`);
  return name;
}
function input(base, name, expected, provenance = 'archive-inventory') {
  safe(name);
  const path = resolve(base, name), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !inside(realpathSync(base), realpathSync(path))) throw Error(`Input must be an ordinary contained file: ${name}`);
  const bytes = readFileSync(path), actual = sha(bytes);
  if (expected && (!/^[a-f0-9]{64}$/.test(expected.sha256 ?? '') || actual !== expected.sha256 || expected.bytes !== undefined && expected.bytes !== stat.size)) throw Error(`Producer artifact hash/size mismatch: ${name}`);
  return { file: name, path, size: stat.size, sha256: actual, executable: Boolean(stat.mode & 0o111), provenance };
}
function json(base, name) { const file = input(base, name); return { file, value: JSON.parse(readFileSync(file.path, 'utf8')) }; }
function generated(file, value, provenance) {
  const content = JSON.stringify(value, null, 2) + '\n';
  return { file, content, size: Buffer.byteLength(content), sha256: sha(content), executable: false, provenance };
}
function contractFiles(contractRoot) {
  const license = input(contractRoot, 'LICENSE');
  const headers = ['weapp_container_sdk.h', 'weapp_container_sdk_gl.h'].map(file => ({ file, input: input(contractRoot, `include/${file}`) }));
  const revision = spawnSync('git', ['-C', contractRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (revision.status !== 0 || !/^[a-f0-9]{40}$/.test(revision.stdout.trim())) throw Error('A concrete public SDK contract source identity is required');
  const inputSources = ['LICENSE', ...headers.map(({ file }) => `include/${file}`)];
  const status = spawnSync('git', ['-C', contractRoot, 'status', '--porcelain=v1', '--untracked-files=all', '--', ...inputSources], { encoding: 'utf8' });
  if (status.status !== 0 || status.stdout.trim()) throw Error('Public contract license/header inputs must match their committed source');
  const notice = generated('SDK-CONTRACT-NOTICE.json', { schemaVersion: 1, repository: 'weapp-container/sdk-contract', sourceCommit: revision.stdout.trim(),
    inputSourcePaths: inputSources, inputSourcesDirty: false,
    license: 'Apache-2.0', licenseFile: 'SDK-CONTRACT-LICENSE', licenseSha256: license.sha256,
    publicHeaders: headers.map(({ file, input: value }) => ({ file, sha256: value.sha256 })),
    scope: 'Apache-2.0 applies only to the identified public C ABI headers. This generated attribution is not an upstream NOTICE. Runtime binaries remain under RUNTIME-LICENSE; dependency notices retain their own licenses.' }, 'public-contract-attribution');
  return { files: [{ ...license, file: 'SDK-CONTRACT-LICENSE', provenance: 'public-contract-license' }, notice], headers };
}
function clean(receipt, status, native = false, expectedVersion = native ? nativeVersion : version, expectedDistribution) {
  assertDistributionIdentity(receipt, expectedDistribution);
  if (receipt.schemaVersion !== 1 || receipt.sdkVersion !== expectedVersion || receipt.status !== status || receipt.sourceDirty !== false || !/^[a-f0-9]{40}$/.test(receipt.sourceCommit ?? '') || receipt.exitCode !== undefined && receipt.exitCode !== 0) throw Error(`A successful clean ${SDK_RELEASE_VERSION} producer receipt is required`);
  if (native) assertNativeProducer(receipt, receipt.target, expectedDistribution);
  if (receipt.profile !== undefined && receipt.profile !== 'release') throw Error('Release producer profile is required');
  if (receipt.checks?.some(check => typeof check === 'object' && (check.exitCode !== undefined && check.exitCode !== 0 || ['failed', 'blocked'].includes(check.status)))) throw Error('Producer contains a failed check');
}
function walk(base, directory) {
  const files = [];
  function visit(name) {
    const path = resolve(base, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error(`Links are forbidden: ${name}`);
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) visit(name ? `${name}/${child}` : child);
    else files.push(input(base, name));
  }
  visit(directory); return files;
}
function licenseDirectory(base, target, nativeReceipt) {
  const metadata = json(base, 'licenses.json'), data = metadata.value;
  if (data.schemaVersion !== 1 || !Array.isArray(data.packages) || !data.packages.length) throw Error('Invalid license inventory');
  if (target !== undefined && data.target !== target) throw Error('Native license target does not match its runtime');
  if (nativeReceipt?.distributionProfile === 'restricted-showcase' && (data.source?.sourceCommit !== nativeReceipt.sourceCommit
    || data.source?.sourceDirty !== false || JSON.stringify([...(data.features ?? [])].sort()) !== JSON.stringify([...nativeReceipt.features].sort()))) {
    throw Error('Restricted runtime licenses require its exact source and feature graph');
  }
  if (nativeReceipt?.distributionProfile === 'restricted-showcase') {
    if (Object.keys(data.nativeFont ?? {}).length !== Object.keys(SHOWCASE_NATIVE_FONT).length
      || Object.entries(SHOWCASE_NATIVE_FONT).some(([key, value]) => data.nativeFont?.[key] !== value)
      || !data.packages.some(pkg => pkg.kind === 'embedded-native-font' && pkg.license === 'OFL-1.1'
        && pkg.files?.some(file => file.path === 'noto-sans-sc/LICENSE.OFL.txt' && file.sha256 === SHOWCASE_NATIVE_FONT.licenseSha256))) {
      throw Error('Restricted runtime licenses require the exact embedded native font and OFL inventory');
    }
  }
  const accepted = new Set(['licenses.json', 'README.txt', 'README.md']);
  for (const pkg of data.packages) for (const record of pkg.files ?? []) {
    if (!/^(?:licen[sc]e|copying|copyright|notice|unlicense)(?:[._-].*)?$/i.test(basename(record.path))) throw Error('License inventory contains a non-license source/input');
    input(base, record.path, record, 'license-inventory'); accepted.add(record.path);
  }
  const files = walk(base, '');
  if (files.some(file => !accepted.has(file.file))) throw Error('Unlisted file in license directory');
  return files;
}
function licenseFiles(base, additionalNotices = []) {
  const files = walk(base, 'licenses');
  const inventories = files.filter(file => file.file.endsWith('/licenses.json') || file.file === 'licenses/licenses.json');
  if (!inventories.length) throw Error('Third-party license inventory is required');
  const accepted = new Set(additionalNotices.map(name => input(base, name).path));
  for (const file of inventories) {
    for (const checked of licenseDirectory(dirname(file.path))) accepted.add(checked.path);
  }
  if (files.some(file => !accepted.has(file.path))) throw Error('Unlisted file outside license inventories');
  return files;
}
function plan(component, platform, arch, files, producer, identity) {
  const identities = new Set();
  for (const file of files) { safe(file.file); if (identities.has(file.file)) throw Error('Duplicate archive input'); identities.add(file.file); }
  return { component, platform, arch, ...(arch === 'universal' ? { architectures: matrix[platform].targets.map(([, value]) => value) } : {}),
    ...identity, fileName: `${component}-${archiveVersion(identity)}-${platform}-${arch}.tar.gz`, files: files.sort((a, b) => a.file.localeCompare(b.file)), producer };
}
export function prepareArchivePlans({ runtimeRoot, platforms, contractRoot = resolve(root, 'sdk/contract'), sdkSourceRoots = sourceRoots, expectedDistribution, runtimeOnly = false }) {
  const identity = distributionIdentity(expectedDistribution);
  if (!Array.isArray(platforms) || !platforms.length || new Set(platforms).size !== platforms.length || platforms.some(value => !Object.hasOwn(matrix, value))) throw Error('Select distinct --platform macos|ios|android|windows|linux values; absent platforms cannot be advertised');
  if (typeof runtimeOnly !== 'boolean') throw Error('runtimeOnly must be boolean');
  const base = resolve(runtimeRoot), plans = [], contract = contractFiles(contractRoot), nativeReceipts = [];
  for (const platform of platforms) {
    const spec = matrix[platform], sdk = resolve(base, spec.sdk), producer = runtimeOnly ? null : json(sdk, spec.receipt);
    if (producer) clean(producer.value, spec.status, false, version, identity);
    if (producer && spec.sdkPlatform && producer.value.platform !== spec.sdkPlatform) throw Error(`An actual ${spec.sdkPlatform} distribution is required`);
    const reviewed = producer ? reviewedSdkSource(platform, producer.value, sdkSourceRoots) : null;
    if (producer && producer.value.native?.length !== spec.targets.length) throw Error('Incomplete SDK native target receipts');
    if (producer) assertNativeProducerSet(producer.value.native, spec.targets.map(([target]) => target), identity);
    const nativeProvenance = [];
    for (const [target, arch] of spec.targets) {
      const directory = resolve(base, 'native', target), receipt = json(directory, 'build.json'); clean(receipt.value, 'built', true, nativeVersion, identity);
      nativeReceipts.push(receipt.value);
      const embedded = runtimeOnly ? receipt.value : producer.value.native.find(value => value.target === target); clean(embedded ?? {}, 'built', true, nativeVersion, identity);
      if (receipt.value.distributionProfile !== undefined) verifyNativeProducerFiles(directory, receipt.value, target, identity);
      if (receipt.value.target !== target || receipt.value.platform !== platform || embedded.sourceCommit !== receipt.value.sourceCommit || digest(embedded.artifacts) !== digest(receipt.value.artifacts)) throw Error('SDK/native producer identities disagree');
      if (!Array.isArray(receipt.value.artifacts) || !receipt.value.artifacts.length) throw Error('Native artifact hashes are required');
      for (const required of nativeLibraryNames(platform)) {
        if (!receipt.value.artifacts.some(value => value.file === required)) throw Error(`Native runtime artifact is missing: ${target}/${required}`);
      }
      const checked = receipt.value.artifacts.map(record => {
        if (!nativeArtifactAllowed(platform, record.file)) throw Error('Native input is outside the release whitelist');
        return input(directory, record.file, record, 'native-producer');
      });
      for (const header of contract.headers) {
        const file = checked.find(value => value.file === header.file);
        if (header.file === 'weapp_container_sdk.h' && !file || file && file.sha256 !== header.input.sha256) throw Error('Native public header does not match the reviewed SDK contract');
      }
      const omitted = platform === 'android' ? 'libweapp_container_sdk.a' : platform === 'ios' ? 'libweapp_container_sdk.dylib' : platform === 'windows' ? 'weapp_container_sdk.lib' : undefined;
      const files = checked.filter(file => file.file !== omitted);
      const exact = records => records.map(({ file, bytes, sha256 }) => {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('Exact producer artifact byte sizes are required');
        return { file, bytes, sha256 };
      });
      const distribution = generated('runtime-distribution.json', { schemaVersion: 1, sdkVersion: receipt.value.sdkVersion, abiVersion: 1, target, ...identity,
        sourceCommit: receipt.value.sourceCommit, sourceDirty: false, producerReceipt: { file: 'build.json', sha256: receipt.file.sha256 },
        selectedArtifacts: exact(receipt.value.artifacts.filter(file => file.file !== omitted)), omittedArtifacts: exact(receipt.value.artifacts.filter(file => file.file === omitted)) }, 'producer-artifact-selection');
      files.push(input(directory, 'RUNTIME-LICENSE'), { ...receipt.file, provenance: 'producer-receipt' }, distribution, ...contract.files);
      const licenses = resolve(base, 'licenses', target);
      // Reuse the license inventory validator without copying unrelated target directories.
      for (const file of licenseDirectory(licenses, target, receipt.value)) files.push({ ...file, file: `licenses/${file.file}` });
      nativeProvenance.push({ target, sourceCommit: receipt.value.sourceCommit, receiptSha256: receipt.file.sha256 });
      plans.push(plan('runtime', platform, arch, files, { sourceCommit: receipt.value.sourceCommit, receiptSha256: receipt.file.sha256 }, identity));
    }
    if (runtimeOnly) continue;
    let files;
    if (platform === 'ios') {
      if (!producer.value.artifacts?.length) throw Error('iOS distribution hashes are required');
      // Public embedding guidance belongs to the SDK source closure. A producer
      // hash alone cannot authorize either changed text or another docs path.
      for (const path of iosPublicDocuments) reviewed.readSource(path);
      files = producer.value.artifacts.map(record => {
        if (!reviewed.wrappers.has(record.file) && !iosPublicDocuments.includes(record.file) && !/^(Frameworks\/WeappContainerNative\.xcframework\/(?:Info\.plist|ios-arm64(?:_x86_64-simulator)?\/(?:libweapp_container_sdk\.a|Headers\/(?:module\.modulemap|weapp_container_sdk\.h)))$|licenses\/|(?:CONTRACT\.md|LICENSE|ORIGIN\.json|Package\.swift|README\.md|RUNTIME-LICENSE|WeappContainer\.podspec)$)/.test(record.file)) throw Error('iOS wrapper is outside release whitelist');
        const checked = input(sdk, record.file, record, 'sdk-producer');
        if (reviewed.records.has(record.file)) wrapperInput(sdk, record.file, reviewed.records.get(record.file));
        if (record.file.endsWith('/Headers/weapp_container_sdk.h') && checked.sha256 !== contract.headers.find(value => value.file === 'weapp_container_sdk.h').input.sha256) throw Error('iOS framework header does not match the reviewed SDK contract');
        return checked;
      });
      if ([...reviewed.wrappers.keys()].some(path => !files.some(file => file.file === path))) throw Error('iOS reviewed wrapper closure is incomplete');
      if (iosPublicDocuments.some(path => !files.some(file => file.file === path))) throw Error('iOS reviewed public documentation closure is incomplete');
      licenseFiles(sdk);
    } else if (platform === 'android') {
      if (!producer.value.mavenArtifacts?.length) throw Error('Android Maven artifact hashes are required');
      files = producer.value.mavenArtifacts.map(record => {
        if (!androidMavenFiles.has(record.file)) throw Error('Android Maven file is outside release whitelist');
        return { ...input(resolve(sdk, 'maven'), record.file, record, 'sdk-producer'), file: `maven/${record.file}` };
      });
      if (!files.some(file => file.file.endsWith(`-${version}.aar`))) throw Error('Android AAR is missing');
      if (!files.some(file => file.file.endsWith(`-${version}-sources.jar`))) throw Error('Android reviewed wrapper sources are missing');
      // Notices are inside the verified AAR; retain standalone native notices too.
      files.push(...plans.filter(value => value.platform === platform && value.component === 'runtime').flatMap(value => value.files.filter(file => file.file.startsWith('licenses/')).map(file => ({ ...file, file: `licenses/${value.arch}/${file.file.slice(9)}` }))));
      files.push(input(resolve(base, 'native'), 'RUNTIME-LICENSE'));
    } else {
      if (!producer.value.artifacts?.length) throw Error('Desktop library hashes are required');
      for (const record of producer.value.artifacts) input(sdk, record.file, record, 'sdk-producer');
      files = ['include', 'lib', ...(platform === 'windows' ? ['bin'] : []), 'share/weapp-container/licenses/native'].flatMap(directory => walk(sdk, directory));
      for (const name of ['LICENSE', 'README.md', 'RUNTIME-LICENSE']) files.push(input(sdk, `share/weapp-container/${name}`));
      files.push(input(sdk, 'share/weapp-container/licenses/nlohmann-json-LICENSE.MIT'));
      for (const file of files) {
        const library = platform === 'windows' ? /^(?:lib\/weapp_container_(?:sdk\.dll|desktop)\.lib|bin\/weapp_container_sdk\.dll)$/ : /^lib\/libweapp_container_(?:sdk|desktop)\.a$/;
        if (!reviewed.wrappers.has(file.file) && !library.test(file.file) && !/^(include\/weapp_container_sdk(?:_gl)?\.h$|lib\/cmake\/WeappContainerDesktop\/[A-Za-z0-9._-]+\.cmake$|share\/weapp-container\/(?:LICENSE$|README\.md$|RUNTIME-LICENSE$|licenses\/nlohmann-json-LICENSE\.MIT$|licenses\/native\/))/.test(file.file)) throw Error(`Desktop file is outside release whitelist: ${file.file}`);
        if (reviewed.wrappers.has(file.file)) wrapperInput(sdk, file.file, reviewed.wrappers.get(file.file));
        const contractHeader = contract.headers.find(value => `include/${value.file}` === file.file);
        if (contractHeader && file.sha256 !== contractHeader.input.sha256) throw Error('Desktop public header does not match the reviewed SDK contract');
        if (producer.value.artifacts.some(record => record.file === file.file)) file.provenance = 'sdk-producer';
        else if (library.test(file.file)) throw Error('Desktop library is missing its producer hash');
      }
      if ([...reviewed.wrappers.keys()].some(path => !files.some(file => file.file === path))) throw Error('Desktop reviewed wrapper closure is incomplete');
      for (const name of ['sdk', 'desktop']) {
        const library = `lib/${platform === 'windows' ? '' : 'lib'}weapp_container_${name}${platform === 'windows' && name === 'sdk' ? '.dll' : ''}.${platform === 'windows' ? 'lib' : 'a'}`;
        if (!files.some(file => file.file === library)) throw Error(`Desktop library is missing: ${library}`);
      }
      if (platform === 'windows') {
        const runtime = files.find(value => value.file === 'bin/weapp_container_sdk.dll');
        const expected = producer.value.artifacts.find(value => value.file === runtime?.file);
        if (!runtime || !expected || runtime.sha256 !== expected.sha256) throw Error('Desktop runtime DLL is missing or differs from the SDK producer');
      }
      if (!files.some(file => file.file.endsWith('/RUNTIME-LICENSE')) || !files.some(file => file.file.endsWith('/licenses.json'))) throw Error('Desktop runtime license/notices are missing');
      licenseFiles(resolve(sdk, 'share/weapp-container'), ['licenses/nlohmann-json-LICENSE.MIT']);
    }
    files.push({ ...producer.file, provenance: 'producer-receipt' }, reviewed.inventory, ...contract.files);
    const sdkPlan = plan(spec.component, platform, spec.targets.length > 1 ? 'universal' : spec.targets[0][1], files, { sourceCommit: producer.value.sourceCommit, receiptSha256: producer.file.sha256, sourceInventorySha256: reviewed.inventory.sha256, native: nativeProvenance,
      scope: 'Producer artifacts and exact committed public wrapper sources checked; all exported bytes independently hashed. Remaining metadata/license bytes are archive-inventory-bound.' }, identity);
    if (platform === 'android') {
      sdkPlan.androidSources = [...reviewed.wrappers.values()].map(record => ({ file: record.path.slice('library/src/main/java/'.length), bytes: record.size, sha256: record.sha256 }));
      sdkPlan.androidNotices = androidSdkNotices(reviewed);
      sdkPlan.androidRuntimeNotices = plans.filter(value => value.platform === platform && value.component === 'runtime').flatMap(value => {
        const target = spec.targets.find(([, arch]) => arch === value.arch)[0];
        return value.files.filter(file => file.file.startsWith('licenses/')).map(file => ({ file: `assets/weapp-container/licenses/${target}/${file.file.slice(9)}`, bytes: file.size, sha256: file.sha256 }));
      });
      const runtimeLicense = input(resolve(base, 'native'), 'RUNTIME-LICENSE');
      sdkPlan.androidRuntimeNotices.push({ file: 'assets/weapp-container/RUNTIME-LICENSE', bytes: runtimeLicense.size, sha256: runtimeLicense.sha256 });
    }
    plans.push(sdkPlan);
  }
  // Each platform's architecture set is checked against one producer source
  // above. Independently released platform families retain their own exact
  // source commits in provenance instead of rebinding them to one revision.
  if (runtimeOnly) assertNativeProducerSet(nativeReceipts, undefined, identity);
  return plans;
}

const createTar = `import gzip,hashlib,io,json,re,sys,tarfile,zipfile
from pathlib import Path
job=json.load(sys.stdin)
entries=0
expanded=0
def reject(code,member=''):
 print(json.dumps({'code':code,'member':str(member)[:512]}),file=sys.stderr)
 raise ValueError(code)
def inspect_zip(source,kind,depth=0):
 global entries,expanded
 if depth>2: raise ValueError('Nested ZIP depth exceeded')
 expected={file['file']:file for file in job.get('androidSources',[])}
 notices={file['file']:file for file in job.get('androidNotices',[])}
 runtime_notices={file['file']:file for file in job.get('androidRuntimeNotices',[])}
 seen=set()
 with zipfile.ZipFile(source) as zipped:
  for item in zipped.infolist():
   name=item.filename
   if name in seen: reject('ERR_ARCHIVE_ANDROID_MEMBER',name)
   seen.add(name)
   entries+=1;expanded+=item.file_size
   if entries>100000 or expanded>1024**3: raise ValueError('Nested ZIP limits exceeded')
   if name.endswith(('.rs','.c','.cpp','.cc','.dart','.js','.ts','.tsx')) or '..' in name.split('/') or name.startswith('/') or '\\\\' in name or any(part in ('.git','target','node_modules','.env','consumer','.gradle') for part in name.split('/')): reject('ERR_ARCHIVE_SOURCE_MEMBER',name)
   if item.is_dir(): continue
   public='com/sonofmagic/weapp/container/sdk/'
   if kind=='sources':
    allowed=name=='META-INF/MANIFEST.MF' or name in expected
    if name in expected:
     content=zipped.read(item);record=expected[name]
     if len(content)!=record['bytes'] or hashlib.sha256(content).hexdigest()!=record['sha256']: reject('ERR_ARCHIVE_ANDROID_SOURCE_HASH',name)
   elif kind=='classes':
    allowed=name.startswith(public) and name.endswith('.class') or name=='META-INF/MANIFEST.MF' or name.startswith('META-INF/') and name.endswith('.kotlin_module')
   else:
    allowed=name in ('R.txt','AndroidManifest.xml','classes.jar','proguard.txt','META-INF/com/android/build/gradle/aar-metadata.properties') or re.fullmatch(r'jni/(arm64-v8a|x86_64)/lib(weapp_container_sdk|weapp_container_android|c[+][+]_shared)[.]so',name) or name in notices or name in runtime_notices
    if not runtime_notices:
     allowed=allowed or name=='assets/weapp-container/RUNTIME-LICENSE' or re.fullmatch(r'assets/weapp-container/licenses/(aarch64-linux-android|x86_64-linux-android)/.+',name) and (name.rsplit('/',1)[-1] in ('licenses.json','README.txt','README.md') or re.fullmatch(r'(?i)(licen[sc]e|copying|copyright|notice|unlicense)([._-].*)?',name.rsplit('/',1)[-1]))
    record=notices.get(name) or runtime_notices.get(name)
    if record:
     content=zipped.read(item)
     if len(content)!=record['bytes'] or hashlib.sha256(content).hexdigest()!=record['sha256']: reject('ERR_ARCHIVE_ANDROID_NOTICE_HASH',name)
   if not allowed: reject('ERR_ARCHIVE_ANDROID_MEMBER',name)
   if name.endswith(('.jar','.zip','.aar')):
    if item.file_size>64*1024**2: raise ValueError('Nested ZIP byte limit exceeded')
    if kind!='aar' or name!='classes.jar': reject('ERR_ARCHIVE_NESTED_MEMBER',name)
    inspect_zip(io.BytesIO(zipped.read(item)),'classes',depth+1)
  if kind=='sources' and set(expected)-seen: reject('ERR_ARCHIVE_ANDROID_SOURCE_CLOSURE',sorted(set(expected)-seen)[0])
  if kind=='aar' and (set(notices)|set(runtime_notices))-seen: reject('ERR_ARCHIVE_ANDROID_NOTICE_CLOSURE',sorted((set(notices)|set(runtime_notices))-seen)[0])
if job.get('inspectOnly'):
 for file in job['files']:
  p=Path(file['path']);inspect_zip(p,'aar' if p.suffix=='.aar' else 'sources')
 sys.exit(0)
with open(job['archive'],'xb') as raw:
 with gzip.GzipFile(fileobj=raw,mode='wb',mtime=0,filename='') as compressed:
  with tarfile.open(fileobj=compressed,mode='w',format=tarfile.PAX_FORMAT) as archive:
   for file in job['files']:
    if 'content' in file:
     content=file['content'].encode('utf-8');info=tarfile.TarInfo(file['file']);info.size=len(content);info.mode=0o644
     archive.addfile(info,io.BytesIO(content));continue
    p=Path(file['path'])
    if p.suffix in ('.jar','.aar'): inspect_zip(p,'aar' if p.suffix=='.aar' else 'sources')
    info=tarfile.TarInfo(file['file']);info.size=p.stat().st_size;info.mode=0o755 if file['executable'] else 0o644
    with p.open('rb') as source: archive.addfile(info,source)
`;
function toolFailure(result) {
  const permitted = new Set(['ERR_ARCHIVE_SOURCE_MEMBER', 'ERR_ARCHIVE_ANDROID_MEMBER', 'ERR_ARCHIVE_NESTED_MEMBER', 'ERR_ARCHIVE_ANDROID_SOURCE_HASH', 'ERR_ARCHIVE_ANDROID_SOURCE_CLOSURE', 'ERR_ARCHIVE_ANDROID_NOTICE_HASH', 'ERR_ARCHIVE_ANDROID_NOTICE_CLOSURE']);
  for (const line of String(result.stderr ?? '').slice(0, 16 * 1024).split('\n')) {
    try {
      const value = JSON.parse(line);
      if (permitted.has(value.code) && typeof value.member === 'string') {
        const member = value.member.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[REDACTED]')
          .replace(/(?:token|password|secret|authorization)[=:][^\s/]+/gi, '[REDACTED]')
          .replace(/[^\x20-\x7e]/g, '?').slice(0, 384);
        return `${value.code}: ${member}`;
      }
    } catch { /* Python stderr is diagnostic data; only a known structured code is displayed. */ }
  }
  return `ERR_ARCHIVE_TOOL_EXIT_${Number.isInteger(result.status) ? result.status : 'SPAWN'}`;
}
function androidSdkNotices(reviewed) {
  return [...reviewed.records.values()].filter(record => ['LICENSE', 'THIRD-PARTY-NOTICES.md'].includes(record.path) || record.path.startsWith('licenses/')).map(record => {
    reviewed.readSource(record.path);
    return { file: `assets/weapp-container/${record.path === 'LICENSE' ? record.path : `sdk-dependencies/${record.path}`}`, bytes: record.size, sha256: record.sha256 };
  });
}
export function verifyAndroidArchiveInputs(paths, { python = process.env.PYTHON ?? 'python3', sourceRoot = sourceRoots.android } = {}) {
  if (!Array.isArray(paths) || !paths.length) throw Error('Explicit Android archive paths are required');
  const files = paths.map(path => {
    const absolute = resolve(path), stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || !/(?:\.aar|-sources\.jar)$/.test(absolute)) throw Error('Ordinary AAR or sources.jar inputs are required');
    return { path: absolute };
  });
  const sourceCommit = gitSource(sourceRoot, ['rev-parse', 'HEAD']).toString().trim();
  const inventory = gitSource(sourceRoot, ['show', `${sourceCommit}:SOURCE-INVENTORY.json`]);
  const reviewed = reviewedSdkSource('android', { sourceCommit, sourceInventorySha256: sha(inventory) }, { android: sourceRoot });
  const androidSources = [...reviewed.wrappers.values()].map(record => ({ file: record.path.slice('library/src/main/java/'.length), bytes: record.size, sha256: record.sha256 }));
  const androidNotices = androidSdkNotices(reviewed);
  const result = spawnSync(python, ['-c', createTar], { input: JSON.stringify({ inspectOnly: true, files, androidSources, androidNotices }), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) throw Error(`Android archive inspection failed: ${toolFailure(result)}`);
  return { status: 'passed', files: files.length, scope: 'Read-only ZIP member closure; no production archive generated' };
}
// mkdir and hard-link creation are exclusive operations. An output appearing
// after validation, including a dangling symlink, can never be overwritten.
export function publishVerifiedArchives(staged, out) {
  const names = readdirSync(staged).sort();
  const marker = 'runtime-artifacts.lock.json';
  if (!names.includes(marker) || names.some(name => !lstatSync(resolve(staged, name)).isFile())) throw Error('Only verified archive files may be published');
  const linked = []; let owned;
  try {
    mkdirSync(out); owned = lstatSync(out);
    for (const name of [...names.filter(value => value !== marker), marker]) {
      if (!sameFile(lstatSync(out), owned)) throw Error('Output directory changed during publication');
      const source = resolve(staged, name), destination = resolve(out, name);
      linkSync(source, destination); linked.push({ destination, identity: lstatSync(source) });
    }
  } catch (error) {
    if (owned && present(out) && sameFile(lstatSync(out), owned)) {
      for (const file of linked) if (present(file.destination) && sameFile(lstatSync(file.destination), file.identity)) unlinkSync(file.destination);
      try { rmdirSync(out); } catch (cleanupError) { error.message += `; output preserved because cleanup failed: ${cleanupError.code}`; }
    }
    throw error;
  }
}
export async function buildRuntimeArchives({ runtimeRoot = resolve(root, 'artifacts/dev-player/runtime'), platforms, outDirectory, python = process.env.PYTHON ?? 'python3', contractRoot = resolve(root, 'sdk/contract'), sdkSourceRoots = sourceRoots, expectedDistribution, runtimeOnly = false }) {
  const identity = distributionIdentity(expectedDistribution);
  const plans = prepareArchivePlans({ runtimeRoot, platforms, contractRoot, sdkSourceRoots, expectedDistribution: identity, runtimeOnly });
  let out = resolve(outDirectory);
  if (present(out) || inside(resolve(runtimeRoot), out)) throw Error('Output must be a new independent directory outside producer inputs');
  mkdirSync(dirname(out), { recursive: true });
  out = resolve(realpathSync(dirname(out)), basename(out));
  if (inside(realpathSync(runtimeRoot), out)) throw Error('Output parent resolves inside producer inputs');
  const staged = resolve(dirname(out), `.${out.split(sep).at(-1)}-${randomUUID()}`); mkdirSync(staged);
  const restricted = identity.distributionProfile === 'restricted-showcase';
  const manifest = { schemaVersion: 1, runtimeVersion: version, abiVersion: 1, ...(restricted ? identity : {}), source: { repository: 'weapp-container/weapp-container', releaseTag: `runtime-v${version}` }, artifacts: [] };
  const provenance = { schemaVersion: 1, sdkVersion: version, ...identity, privacy: 'private', status: 'prepared-not-published', artifacts: [], limitations: 'Producer/hash and offline-install verification only. No installation, GPU, device, performance or release publication claim.' };
  try {
    for (const planned of plans) {
      const archive = resolve(staged, planned.fileName);
      const result = spawnSync(python, ['-c', createTar], { input: JSON.stringify({ archive, files: planned.files, androidSources: planned.androidSources, androidNotices: planned.androidNotices, androidRuntimeNotices: planned.androidRuntimeNotices }), encoding: 'utf8', maxBuffer: 1024 * 1024 });
      if (result.status !== 0 || result.error) throw Error(`Archive creation failed: ${planned.fileName}: ${toolFailure(result)}`);
      for (const file of planned.files) {
        if (file.content !== undefined) { if (sha(file.content) !== file.sha256 || Buffer.byteLength(file.content) !== file.size) throw Error('Generated archive metadata changed'); }
        else input(dirname(file.path), file.path.split(sep).at(-1), file);
      }
      const entry = { component: planned.component, platform: planned.platform, arch: planned.arch, ...(planned.architectures ? { architectures: planned.architectures } : {}), fileName: planned.fileName, size: lstatSync(archive).size, sha256: sha(readFileSync(archive)) };
      manifest.artifacts.push(entry);
      // The public full installer intentionally rejects the additional restricted
      // identity. After checking that identity here, use its bounded file/target
      // validator on an explicit projection only for private unpack verification.
      assertDistributionIdentity(manifest, identity);
      const { distributionProfile, policySha256, ...contractManifest } = manifest;
      contractManifest.source = { ...manifest.source, releaseTag: `runtime-v${version}` };
      contractManifest.artifacts = manifest.artifacts.map(({ distributionProfile, policySha256, ...artifact }) => artifact);
      const selected = selectArtifact(contractManifest, { version, component: entry.component, platform: entry.platform, arch: entry.arch });
      const destination = resolve(staged, `.verify-${randomUUID()}`);
      const checked = spawnSync(python, [resolve(contractRoot, 'tools/unpack-runtime.py'), '--archive', archive, '--destination', destination, '--sha256', selected.sha256, '--identity-json', JSON.stringify({ runtimeVersion: version, abiVersion: 1, component: entry.component, platform: entry.platform, arch: entry.arch })], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      if (checked.status !== 0 || checked.error) throw Error(`Contract unpack verification failed: ${entry.fileName}`);
      const unpacked = JSON.parse(readFileSync(resolve(destination, '.runtime-install.json'), 'utf8')).files.filter(value => value.sha256);
      if (unpacked.length !== planned.files.length || planned.files.some(file => !unpacked.some(value => value.path === file.file && value.size === file.size && value.sha256 === file.sha256))) throw Error('Extracted bytes differ from the complete archive inventory');
      rmSync(destination, { recursive: true });
      provenance.artifacts.push({ ...entry, producer: planned.producer, inventory: planned.files.map(({ path, content, ...file }) => file), contractVerification: { status: 'passed', verifierSha256: sha(readFileSync(resolve(contractRoot, 'tools/unpack-runtime.py'))) } });
    }
    writeFileSync(resolve(staged, 'runtime-artifacts.lock.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(resolve(staged, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    writeFileSync(resolve(staged, 'SHA256SUMS'), manifest.artifacts.map(value => `${value.sha256}  ${value.fileName}\n`).join(''));
    publishVerifiedArchives(staged, out); return { outDirectory: out, manifest, provenance };
  } finally { rmSync(staged, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = { platforms: [] };
    if (args.includes('--help')) process.stdout.write(`Prepare private ${SDK_RELEASE_VERSION} runtime archives: --platform macos|ios|android|windows|linux (repeatable) --out <new-directory> [--runtime-root directory] [--runtime-only] [--distribution-profile restricted-showcase --policy-sha256 <hex>]\nNo build, device access, publication or SDK worktree changes.\n`);
    else {
      for (let i = 0; i < args.length; i += 2) {
        if (args[i] === '--runtime-only') { if (options.runtimeOnly) throw Error('Duplicate archive option'); options.runtimeOnly = true; i--; continue; }
        if (!['--platform', '--out', '--runtime-root', '--distribution-profile', '--policy-sha256'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Unknown or missing archive option');
        if (args[i] === '--platform') options.platforms.push(args[i + 1]);
        else { const name = ({ '--out': 'outDirectory', '--runtime-root': 'runtimeRoot', '--distribution-profile': 'distributionProfile', '--policy-sha256': 'policySha256' })[args[i]]; if (options[name]) throw Error('Duplicate archive option'); options[name] = args[i + 1]; }
      }
      if (!options.outDirectory) throw Error('--out is required');
      const result = await buildRuntimeArchives({ ...options, expectedDistribution: distributionIdentity(options) }); process.stdout.write(JSON.stringify({ status: 'prepared-not-published', outDirectory: result.outDirectory, artifacts: result.manifest.artifacts.length }) + '\n');
    }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
