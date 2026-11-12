import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readNative, readNotices, SDK_VERSION } from '../../sdk/android/tools/native-input.mjs';

const targets = ['aarch64-linux-android', 'x86_64-linux-android'];
const libraries = ['libweapp_container_sdk.so', 'libc++_shared.so'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sorted = value => JSON.stringify([...value].sort());

function requireIdentity(receipt, target) {
  if (receipt?.schemaVersion !== 1 || receipt.sdkVersion !== SDK_VERSION || receipt.abiVersion !== 1 ||
      receipt.status !== 'built' || receipt.target !== target || receipt.platform !== 'android' ||
      receipt.profile !== 'release' || !/^[a-f0-9]{40}$/.test(receipt.sourceCommit) ||
      typeof receipt.sourceDirty !== 'boolean' || !Array.isArray(receipt.features) ||
      !['quickjs-native-android', 'skia-gpu-gles'].every(feature => receipt.features.includes(feature))) {
    throw new Error(`A source-bound release Android runtime identity is required for ${target}`);
  }
  if (!Array.isArray(receipt.artifacts)) throw new Error(`Missing native inventory for ${target}`);
  const names = new Set();
  for (const item of receipt.artifacts) {
    if (!item || typeof item.file !== 'string' || !item.file || isAbsolute(item.file) ||
        item.file.includes('\\') || item.file.split('/').some(part => !part || part === '.' || part === '..') ||
        names.has(item.file) || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 0) {
      throw new Error(`Invalid native inventory for ${target}`);
    }
    names.add(item.file);
  }
  for (const library of [...libraries, 'weapp_container_sdk.h']) {
    if (!names.has(library)) throw new Error(`Missing native inventory entry: ${target}/${library}`);
  }
}

/** Select a declared root once. A stale explicit/receipt path must never fall back. */
export function resolveAndroidRecoveryInput({ coreRoot, artifacts, nativeRoot, licensesRoot }) {
  const distributionBytes = readFileSync(resolve(artifacts, 'distribution.json'));
  const distribution = JSON.parse(distributionBytes);
  if (distribution.schemaVersion !== 1 || distribution.sdkVersion !== SDK_VERSION ||
      distribution.status !== 'passed' || !Array.isArray(distribution.native) ||
      distribution.native.length !== targets.length) {
    throw new Error('A passed Android SDK distribution receipt with both target identities is required');
  }
  const identities = new Map();
  for (const receipt of distribution.native) {
    if (!targets.includes(receipt?.target) || identities.has(receipt.target)) {
      throw new Error('Android distribution target inventory must be exact');
    }
    requireIdentity(receipt, receipt.target);
    identities.set(receipt.target, receipt);
  }
  const hasReceiptRoot = Object.hasOwn(distribution, 'nativeRoot');
  if (hasReceiptRoot && (typeof distribution.nativeRoot !== 'string' || !isAbsolute(distribution.nativeRoot))) {
    throw new Error('distribution.nativeRoot must be an explicit absolute directory');
  }
  if (nativeRoot !== undefined && (typeof nativeRoot !== 'string' || !nativeRoot)) {
    throw new Error('--native-root requires a directory');
  }
  const selectedBy = nativeRoot !== undefined ? 'explicit' : hasReceiptRoot ? 'distribution' : 'core-default';
  const selectedRoot = resolve(nativeRoot ?? distribution.nativeRoot ?? resolve(coreRoot, 'artifacts/sdk/native'));
  const hasReceiptLicenses = Object.hasOwn(distribution, 'licensesRoot');
  if (hasReceiptLicenses && (typeof distribution.licensesRoot !== 'string' || !isAbsolute(distribution.licensesRoot))) {
    throw new Error('distribution.licensesRoot must be an explicit absolute directory');
  }
  if (licensesRoot !== undefined && (typeof licensesRoot !== 'string' || !licensesRoot)) {
    throw new Error('--licenses-root requires a directory');
  }
  const licensesSelectedBy = licensesRoot !== undefined ? 'explicit' : hasReceiptLicenses ? 'distribution' : 'core-default';
  const selectedLicenses = resolve(licensesRoot ?? distribution.licensesRoot ?? resolve(coreRoot, 'artifacts/sdk/licenses'));
  const native = [];
  for (const target of targets) {
    // The SDK verifier validates complete producer bytes or the hash-bound exact
    // archive-selection sidecar, including reviewed header and symlink rejection.
    const input = readNative(selectedRoot, target, libraries);
    requireIdentity(input.receipt, target);
    const expected = identities.get(target);
    for (const key of ['schemaVersion', 'sdkVersion', 'abiVersion', 'status', 'target', 'platform',
      'profile', 'sourceCommit', 'sourceDirty']) {
      if (input.receipt[key] !== expected[key]) throw new Error(`Android native/distribution identity mismatch: ${target}/${key}`);
    }
    if (sorted(input.receipt.features) !== sorted(expected.features)) throw new Error(`Android native/distribution feature mismatch: ${target}`);
    const inventory = items => sorted(items.map(item => JSON.stringify([item.file, item.bytes, item.sha256])));
    if (inventory(input.receipt.artifacts) !== inventory(expected.artifacts)) {
      throw new Error(`Android native/distribution inventory mismatch: ${target}`);
    }
    const selectedArtifacts = input.distribution?.selectedArtifacts ?? input.receipt.artifacts;
    // Full receipts also receive size validation (the SDK's legacy path hashes
    // every byte but only archive-selection sidecars enforce byte counts).
    for (const item of selectedArtifacts) {
      if (readFileSync(resolve(input.directory, item.file)).length !== item.bytes) {
        throw new Error(`Android native size mismatch: ${target}/${item.file}`);
      }
    }
    const { notices, runtimeLicense } = readNotices(selectedRoot, selectedLicenses, target);
    const noticesManifest = readFileSync(resolve(notices, 'licenses.json'));
    const noticeInventory = JSON.parse(noticesManifest);
    if (!Array.isArray(noticeInventory.features) || sorted(noticeInventory.features) !== sorted(input.receipt.features)) {
      throw new Error(`Android native/notices feature mismatch: ${target}`);
    }
    native.push({ target, sourceCommit: input.receipt.sourceCommit, sourceDirty: input.receipt.sourceDirty,
      abiVersion: input.receipt.abiVersion, artifacts: input.receipt.artifacts.filter(item => libraries.includes(item.file)),
      noticesManifestSha256: sha256(noticesManifest), runtimeLicenseSha256: sha256(readFileSync(runtimeLicense)) });
  }
  if (native[0].sourceCommit !== native[1].sourceCommit || native[0].sourceDirty !== native[1].sourceDirty) {
    throw new Error('Android target slices must share one producer source identity');
  }
  return { nativeRoot: selectedRoot, selectedBy, licensesRoot: selectedLicenses, licensesSelectedBy,
    distributionSha256: sha256(distributionBytes), native };
}

export function androidRecoveryGradleArguments(input, offline = false) {
  return ['--no-daemon', '--console=plain', ...(offline ? ['--offline'] : []),
    ':library:assembleDebugAndroidTest', `-PweappSdkNativeDir=${input.nativeRoot}`,
    `-PweappSdkLicensesDir=${input.licensesRoot}`];
}

/** Verify --skip-build cannot run an old APK against newly selected evidence. */
export function verifyAndroidRecoveryApk(apk, input) {
  const result = spawnSync('python3', ['-c', `import hashlib,json,sys,zipfile
expected=json.loads(sys.argv[2]); report=[]
with zipfile.ZipFile(sys.argv[1]) as archive:
 for entry in expected:
  name=entry['entry']
  if archive.namelist().count(name)!=1: raise SystemExit('Missing or duplicate pinned APK library: '+name)
  info=archive.getinfo(name)
  if info.file_size!=entry['bytes']: raise SystemExit('Pinned APK library size mismatch: '+name)
  digest=hashlib.sha256()
  with archive.open(info) as library:
   while chunk:=library.read(1048576): digest.update(chunk)
  if digest.hexdigest()!=entry['sha256']: raise SystemExit('Pinned APK library hash mismatch: '+name)
  report.append(entry)
print(json.dumps(report))`, apk, JSON.stringify(input.native.flatMap(receipt => receipt.artifacts.map(item => ({
    entry: `lib/${receipt.target === 'aarch64-linux-android' ? 'arm64-v8a' : 'x86_64'}/${item.file}`,
    bytes: item.bytes, sha256: item.sha256,
  }))))], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim() ?? 'Pinned APK validation failed');
  return JSON.parse(result.stdout);
}
