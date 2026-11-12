// One production generation across native producers, wrappers and Dev Player.
// Historical receipts keep their original versions and are never rebound here.
import { NATIVE_TARGETS, assertNativeFeatureIdentity } from './sdk-native-features.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { assertDistributionIdentity, verifyDistributionArtifact } from './showcase-policy.mjs';
import { SHOWCASE_NATIVE_FONT, verifyShowcaseNativeFontArtifact } from './showcase-native-font.mjs';

export const SDK_RELEASE_VERSION = '0.1.0-preview.6.0';
const sourceCommitPattern = /^[a-f0-9]{40}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeTargets = NATIVE_TARGETS;

// MSVC emits both a static runtime (.lib) and the DLL's import interface
// (.dll.lib). Only runtime bodies can contain policy identity and font data.
// Link interfaces remain bound by the complete producer hash inventory.
export function isNativeRuntimeLibrary(file) {
  return /(?:^|\/)(?:lib)?weapp_container_sdk\.(?:a|so|dylib|dll|lib)$/.test(file);
}

export function captureNativeSource(root) {
  const query = args => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw Error('Cannot identify native producer source');
    return result.stdout.trim();
  };
  // Windows temp roots can use an 8.3 name while Git reports the long name;
  // native realpath expands those aliases, and relative respects the host's
  // path comparison rules without accepting a nested directory as the root.
  const repositoryRoot = realpathSync.native(query(['rev-parse', '--show-toplevel']));
  if (relative(repositoryRoot, realpathSync.native(root)) !== '') throw Error('Native producer must use its own source repository');
  return {
    sourceCommit: query(['rev-parse', 'HEAD']),
    sourceDirty: Boolean(query(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])),
  };
}

export function assertCleanNativeSource(source, before = source) {
  if (!sourceCommitPattern.test(source?.sourceCommit ?? '') || source.sourceDirty !== false) throw Error('Release native compilation requires clean committed source; dirty status is retained in the failed producer receipt');
  if (source.sourceCommit !== before.sourceCommit || before.sourceDirty !== false) throw Error('Native producer source changed during compilation');
}

/** Accept the actual native build receipt or its lossless nativeIdentity projection. */
export function assertNativeProducer(receipt, target = receipt?.target, expectedDistribution) {
  assertDistributionIdentity(receipt, expectedDistribution);
  const expected = nativeTargets[target];
  if (!expected || receipt?.schemaVersion !== 1 || receipt.sdkVersion !== SDK_RELEASE_VERSION
    || receipt.abiVersion !== 1 || receipt.status !== 'built' || receipt.profile !== 'release'
    || receipt.target !== target || receipt.platform !== expected[0]
    || receipt.sourceDirty !== false || !sourceCommitPattern.test(receipt.sourceCommit ?? '')
    || receipt.exitCode !== undefined && receipt.exitCode !== 0
    || !Array.isArray(receipt.features) || !expected.slice(1).every(feature => receipt.features.includes(feature))) {
    throw Error(`A successful clean ${SDK_RELEASE_VERSION} native producer receipt is required for ${target ?? 'an exact target'}`);
  }
  assertNativeFeatureIdentity(receipt);
  if (!Array.isArray(receipt.artifacts) || !receipt.artifacts.length) throw Error('Native artifact hashes are required');
  if (receipt.sourceAfterBuild !== undefined) assertCleanNativeSource(receipt.sourceAfterBuild, receipt);
  if (receipt.sourceBeforePublication !== undefined) assertCleanNativeSource(receipt.sourceBeforePublication, receipt);
  const files = new Set();
  for (const artifact of receipt.artifacts) {
    if (typeof artifact.file !== 'string' || !artifact.file || isAbsolute(artifact.file)
      || /[\\:\x00-\x1f\x7f]/.test(artifact.file)
      || artifact.file.split('/').some(part => !part || part === '.' || part === '..')
      || files.has(artifact.file) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
      || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) throw Error('Invalid or duplicate native artifact hash/size');
    files.add(artifact.file);
  }
  if (receipt.nativePostProcessing !== undefined) {
    const derivation = receipt.nativePostProcessing, operations = derivation?.operations;
    const original = derivation?.originalReceipt;
    if (receipt.platform !== 'linux' || receipt.distributionProfile !== 'restricted-showcase'
      || derivation.schemaVersion !== 1 || derivation.operation !== 'retained-native-debug-hardening'
      || derivation.compilationExecuted !== false || derivation.originalSourceCommit !== receipt.sourceCommit
      || original?.file !== 'original-producer-receipt.json' || !Number.isSafeInteger(original.bytes) || original.bytes < 1
      || !/^[a-f0-9]{64}$/.test(original.sha256 ?? '') || !Array.isArray(operations) || operations.length !== 1) throw Error('Invalid retained native hardening provenance');
    assertCleanNativeSource(derivation.source);
    const operation = operations[0], final = receipt.artifacts.find(artifact => artifact.file === operation.file);
    if (operation.file !== 'libweapp_container_sdk.a' || operation.schemaVersion !== 1 || operation.operation !== 'strip-debug-static-archive'
      || !final || operation.output?.sha256 !== final.sha256 || operation.output?.bytes !== final.bytes
      || !/^[a-f0-9]{64}$/.test(operation.input?.sha256 ?? '') || !Number.isSafeInteger(operation.input?.bytes) || operation.input.bytes < 1
      || operation.remainingDebugSections !== 0 || operation.linkableSectionsSymbolsAndRelocationsPreserved !== true
      || operation.producerSourcePrefixMatches !== 0 || !Number.isSafeInteger(operation.members) || operation.members < 1
      || !Number.isSafeInteger(operation.removedDebugSections) || operation.removedDebugSections < 0
      || !['strip', 'llvm-strip', 'llvm-strip.exe'].includes(operation.tool?.name) || typeof operation.tool?.version !== 'string') throw Error('Invalid retained native hardening operation');
    if (receipt.originalNativeProducerReceipt !== undefined) {
      const bytes = Buffer.from(receipt.originalNativeProducerReceipt);
      if (bytes.length !== original.bytes || sha(bytes) !== original.sha256) throw Error('Original native receipt bytes do not match the retained provenance');
      const producer = JSON.parse(bytes.toString('utf8'));
      if (producer.nativePostProcessing !== undefined) throw Error('Retained native hardening cannot rebind another derivation');
      assertNativeProducer(producer, target, expectedDistribution);
      const input = producer.artifacts.find(artifact => artifact.file === operation.file);
      if (producer.sourceCommit !== receipt.sourceCommit || input?.sha256 !== operation.input.sha256 || input?.bytes !== operation.input.bytes
        || producer.artifacts.length !== receipt.artifacts.length || producer.artifacts.some(artifact => artifact.file !== operation.file
          && !receipt.artifacts.some(final => final.file === artifact.file && final.bytes === artifact.bytes && final.sha256 === artifact.sha256))) throw Error('Retained native hardening changed its compilation identity or unrelated artifacts');
    }
  }
  return receipt;
}

export function assertNativeProducerSet(receipts, targets, expectedDistribution) {
  if (!Array.isArray(receipts) || !receipts.length || new Set(receipts.map(value => value?.target)).size !== receipts.length
    || targets && (receipts.length !== targets.length || targets.some(target => !receipts.some(value => value?.target === target)))) throw Error('Complete distinct native producer targets are required');
  for (const receipt of receipts) assertNativeProducer(receipt, receipt.target, expectedDistribution);
  if (new Set(receipts.map(value => value.sourceCommit)).size !== 1) throw Error('Native targets must share one clean producer source commit');
  return receipts;
}

export function assertSdkProducer(receipt, status, platform, expectedDistribution) {
  assertDistributionIdentity(receipt, expectedDistribution);
  if (receipt?.schemaVersion !== 1 || receipt.sdkVersion !== SDK_RELEASE_VERSION || receipt.status !== status
    || receipt.sourceDirty !== false || !sourceCommitPattern.test(receipt.sourceCommit ?? '')
    || receipt.profile !== undefined && receipt.profile !== 'release'
    || receipt.exitCode !== undefined && receipt.exitCode !== 0
    || receipt.checks?.some(check => typeof check === 'object' && (check.exitCode !== undefined && check.exitCode !== 0 || ['failed', 'blocked'].includes(check.status)))) throw Error(`A successful clean ${SDK_RELEASE_VERSION} SDK producer receipt is required`);
  assertNativeProducerSet(receipt.native, undefined, expectedDistribution);
  if (platform && receipt.native.some(value => value.platform !== platform)) throw Error('SDK native producer platform does not match the consumer');
  return receipt;
}

export function verifyNativeProducerFiles(directory, receipt, target = receipt?.target, expectedDistribution) {
  assertNativeProducer(receipt, target, expectedDistribution);
  const base = realpathSync(directory);
  if (lstatSync(directory).isSymbolicLink()) throw Error('Native input directory cannot be a symlink');
  for (const artifact of receipt.artifacts) {
    let path = resolve(directory);
    for (const part of artifact.file.split('/')) {
      path = resolve(path, part);
      if (lstatSync(path).isSymbolicLink()) throw Error('Native artifact symlinks are forbidden');
    }
    const rel = relative(base, realpathSync(path));
    const stat = lstatSync(path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !stat.isFile()
      || stat.size !== artifact.bytes || sha(readFileSync(path)) !== artifact.sha256) throw Error(`Native artifact hash/size mismatch: ${artifact.file}`);
    if (receipt.distributionProfile !== undefined && isNativeRuntimeLibrary(artifact.file)) {
      const bytes = readFileSync(path); verifyDistributionArtifact(bytes, receipt);
      if (receipt.distributionProfile === 'restricted-showcase') verifyShowcaseNativeFontArtifact(bytes, SHOWCASE_NATIVE_FONT);
    }
  }
  return receipt;
}
