import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SDK_RELEASE_VERSION } from './sdk-current-release.mjs'
import { assertDistributionIdentity, verifyDistributionArtifact } from './showcase-policy.mjs'

export const HARMONY_RELEASE_FEATURES = ['harmony', 'arkui', 'skia-gpu-gles', 'quickjs-native-harmony']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const packageContext = () => Object.fromEntries([
  ['entry', false, 'src/main/'], ['libentry.so', true, ''],
].map(([name, isSO, entryPath]) => [name, {
  isSO, moduleName: '', bundleName: '', dependencyAlias: '', packageName: name, entryPath, version: '',
}]))
export function parseHarmonyMetadataJson(bytes) {
  // Parse the bounded bytes already read from an ordinary compiler output;
  // reject duplicate keys before canonicalization can discard their content.
  const script = `import json,sys
def unique_object(pairs):
 result={}
 for key,value in pairs:
  if key in result:raise ValueError('duplicate compiler JSON field')
  result[key]=value
 return result
def invalid_constant(value):raise ValueError('non-JSON compiler numeric constant')
value=json.load(sys.stdin,object_pairs_hook=unique_object,parse_constant=invalid_constant)
print(json.dumps(value))`
  const parsed = spawnSync(process.env.PYTHON ?? 'python3', ['-c', script], {
    input: bytes, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  })
  if (parsed.status !== 0 || parsed.error) throw Error(`Invalid compiler JSON metadata: ${parsed.error?.message ?? parsed.stderr.trim().split('\n').at(-1)}`)
  return JSON.parse(parsed.stdout)
}

// Hvigor's documented strip=false + empty exclude list preserves every .so.
// Release optimization belongs to Cargo/CMake; packaging must preserve the
// exact native producer bytes independently of symbol retention.
export function preserveHarmonyNativeLibraries(profile) {
  const result = structuredClone(profile)
  for (const option of [result.buildOption ??= {}, ...(result.buildOptionSet ?? [])]) {
    option.nativeLib ??= {}
    option.nativeLib.debugSymbol = { strip: false, exclude: [] }
  }
  return result
}

export function collectHarmonyGeneratedMetadata(project) {
  const root = resolve(project, 'entry/build/default/intermediates')
  const read = path => {
    const full = resolve(root, path), stat = lstatSync(full)
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 2 * 1024 * 1024, 'Bounded ordinary Harmony generated metadata is required')
    return readFileSync(full)
  }
  const rpc = read('syscap/default/rpcid.sc'), input = parseHarmonyMetadataJson(read('syscap/default/rpcid.json'))
  assert.deepEqual(Object.keys(input).sort(), ['api_version', 'syscap'])
  const context = read('loader/default/pkgContextInfo.json')
  assert.deepEqual(parseHarmonyMetadataJson(context), packageContext(), 'Unreviewed compiler package context fields')
  // Official packing-tool serializes the typed context in this field order.
  // Retain the compiler input digest while binding the expected packaged bytes.
  const packagedContext = Buffer.from(JSON.stringify(packageContext()))
  return [
    { path: 'rpcid.sc', size: rpc.length, sha256: sha(rpc), kind: 'ohos-rpcid-v2', apiVersion: input.api_version, systemCapabilities: input.syscap },
    { path: 'pkgContextInfo.json', size: packagedContext.length, sha256: sha(packagedContext), kind: 'ohos-package-context-v1', inputSha256: sha(context) },
  ]
}
export function assertHarmonyNativeRelease(report, rustLibrary, expectedDistribution) {
  const identity = assertDistributionIdentity(report, expectedDistribution)
  assert.equal(report.schemaVersion, 1); assert.equal(report.sdkVersion, SDK_RELEASE_VERSION)
  assert.equal(report.mode, 'build'); assert.equal(report.profile, 'release'); assert.ok(!report.sourceError)
  assert.match(report.commit, /^[a-f0-9]{40}$/)
  for (const source of [report.sourceBefore, report.sourceAfter]) {
    assert.equal(source?.sourceCommit, report.commit); assert.equal(source.sourceDirty, false)
  }
  const platform = report.platforms?.find(value => value.platform === 'harmony')
  assertDistributionIdentity(platform, identity)
  assert.equal(platform?.status, 'passed'); assert.equal(platform.mode, 'build'); assert.equal(platform.profile, 'release')
  assert.equal(platform.target, 'aarch64-unknown-linux-ohos'); assert.equal(platform.engine, 'quickjs')
  assert.deepEqual(platform.features.split(',').sort(), [...HARMONY_RELEASE_FEATURES, ...(identity.distributionProfile === 'restricted-showcase' ? ['restricted-showcase'] : [])].sort())
  assert.equal(platform.cargo?.status, 'passed'); assert.equal(platform.cargo.exitCode, 0)
  assert.equal(platform.artifact?.exists, true)
  assert.match(platform.artifact.path, /(?:^|\/)aarch64-unknown-linux-ohos\/release\/libcontainer_host_harmony\.so$/)
  const stat = lstatSync(rustLibrary)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 128 * 1024 * 1024, 'Harmony library must be a bounded ordinary file')
  const bytes = readFileSync(rustLibrary)
  assert.ok(bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 183, 'Harmony release library must be AArch64 ELF64')
  assert.equal(platform.artifact.bytes, bytes.length); assert.equal(platform.artifact.sha256, sha(bytes))
  if (report.distributionProfile !== undefined) verifyDistributionArtifact(bytes, identity)
  return { sourceCommit: report.commit, profile: 'release', target: platform.target, features: platform.features.split(','), ...identity, sha256: sha(bytes), bytes: bytes.length }
}

const inspectZip = `import hashlib,json,re,stat,sys,zipfile
configuration=json.load(sys.stdin);expected=configuration['rust'];metadata={}
for item in configuration['metadata']:
 p=item.get('path')
 keys={'path','size','sha256','kind'}|({'apiVersion','systemCapabilities'} if p=='rpcid.sc' else {'inputSha256'})
 if p not in ('rpcid.sc','pkgContextInfo.json') or p in metadata or set(item)!=keys or type(item['size']) is not int or not 0<item['size']<=2*1024**2 or not re.fullmatch('[0-9a-f]{64}',item['sha256']):raise ValueError('unreviewed generated metadata identity')
 if item['kind']!=('ohos-rpcid-v2' if p=='rpcid.sc' else 'ohos-package-context-v1'):raise ValueError('unreviewed generated metadata format')
 if p=='pkgContextInfo.json' and not re.fullmatch('[0-9a-f]{64}',item['inputSha256']):raise ValueError('missing package context compiler input identity')
 metadata[p]=item
def unique_object(pairs):
 result={}
 for key,value in pairs:
  if key in result:raise ValueError('duplicate metadata field')
  result[key]=value
 return result
def check_metadata(p,b):
 item=metadata[p]
 if len(b)!=item['size'] or hashlib.sha256(b).hexdigest()!=item['sha256']:raise ValueError('generated metadata differs from compiler output')
 if p=='pkgContextInfo.json':
  packages={name:{'isSO':native,'moduleName':'','bundleName':'','dependencyAlias':'','packageName':name,'entryPath':entry,'version':''} for name,native,entry in [('entry',False,'src/main/'),('libentry.so',True,'')]}
  value=json.loads(b,object_pairs_hook=unique_object)
  if value!=packages or any(type(value[name]['isSO']) is not bool for name in packages):raise ValueError('unreviewed package context fields')
 else:
  api=item['apiVersion'];caps=item['systemCapabilities']
  if type(api) is not int or not 1<=api<=127 or not isinstance(caps,list) or not 0<len(caps)<=4096 or len(set(caps))!=len(caps):raise ValueError('invalid RPC system capability inventory')
  for capability in caps:
   if not isinstance(capability,str) or not re.fullmatch(r'SystemCapability(?:[.][A-Za-z0-9_]+)+',capability) or len(capability[17:].encode())>=256:raise ValueError('unreviewed RPC system capability')
  # Official syscap_tool RPCID v2: API flag, format version, little-endian
  # count and zero-padded 256-byte capability names without the namespace.
  encoded=bytes([0,api|128,0,2])+len(caps).to_bytes(2,'little')+b''.join(cap[17:].encode().ljust(256,b'\\x00') for cap in caps)
  if b!=encoded:raise ValueError('invalid RPCID v2 compiler metadata')
files=[];seen=set();total=0
with zipfile.ZipFile(sys.argv[1]) as z:
 for item in z.infolist():
  directory=item.is_dir();p=item.filename[:-1] if directory else item.filename
  if p in seen or p.startswith('/') or re.search(r'[\\\\:\\x00-\\x20\\x7f]',p) or any(x in ('','..','.') for x in p.split('/')):raise ValueError('unsafe HAP member')
  seen.add(p);total+=item.file_size
  if len(seen)>30000 or total>512*1024**2 or item.file_size>128*1024**2:raise ValueError('HAP expansion limit')
  mode=(item.external_attr>>16)&0xffff
  if stat.S_ISLNK(mode):raise ValueError('HAP link')
  if any(x in ('.git','.env','source','target') for x in p.split('/')):raise ValueError('private HAP member')
  if directory:
   if item.file_size or not (p in ('ets','libs','libs/arm64-v8a','resources') or p.startswith('resources/')):raise ValueError('unreviewed HAP directory')
   continue
  allowed=p in ('module.json','pack.info','resources.index') or p in metadata or p=='ets/modules.abc' or re.fullmatch(r'libs/arm64-v8a/lib(entry|container_host_harmony|c[+][+]_shared)[.]so',p) or p.startswith('resources/')
  if not allowed or re.search(r'[.](rs|cpp|cc|c|h|hpp|ets|ts|js|mjs|map)$',p,re.I) or any(x in ('.git','.env','source','target') for x in p.split('/')):raise ValueError('unreviewed HAP delivery member')
  b=z.read(item);digest=hashlib.sha256(b).hexdigest()
  if p in metadata:check_metadata(p,b)
  if p=='libs/arm64-v8a/libcontainer_host_harmony.so' and (digest!=expected['sha256'] or len(b)!=expected['bytes']):raise ValueError('packaged Rust library differs')
  if p.startswith('libs/') and (len(b)<64 or b[:6]!=bytes([127,69,76,70,2,1]) or int.from_bytes(b[18:20],'little')!=183):raise ValueError('native member is not AArch64 ELF64')
  files.append({'path':p,'size':len(b),'sha256':digest})
for p in ('module.json','ets/modules.abc','resources.index','libs/arm64-v8a/libentry.so','libs/arm64-v8a/libcontainer_host_harmony.so'):
 if not any(f['path']==p for f in files):raise ValueError('incomplete HAP delivery')
for p in metadata:
 if p not in seen:raise ValueError('missing compiler metadata')
print(json.dumps(sorted(files,key=lambda f:f['path'])))`

export function inspectHarmonyHap(path, expectedRust, { metadata = [], python = process.env.PYTHON ?? 'python3' } = {}) {
  const result = spawnSync(python, ['-c', inspectZip, path], { input: JSON.stringify({ rust: expectedRust, metadata }), encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0 || result.error) throw Error(`HAP delivery closure, architecture or packaged Rust digest verification failed: ${result.error?.message ?? result.stderr.trim().split('\n').at(-1)}`)
  return JSON.parse(result.stdout)
}
