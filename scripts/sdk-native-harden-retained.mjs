#!/usr/bin/env node
// Derive a hardened release from an immutable, verified original producer.
// Compilation provenance remains the original source; post-processing is explicit.
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCleanNativeSource, captureNativeSource, verifyNativeProducerFiles } from './lib/sdk-current-release.mjs';
import { hardenLinuxStaticArchive } from './lib/sdk-native-hardening.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function hardenRetainedNative({ input, out, strip = 'strip', sourceRoot = root }) {
  input = resolve(input); out = resolve(out);
  const rel = relative(input, out);
  if (existsSync(out) || rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) throw Error('Select a new independent output; original native inputs are never overwritten');
  const source = captureNativeSource(sourceRoot); assertCleanNativeSource(source);
  if (lstatSync(input).isSymbolicLink()) throw Error('Original native directory cannot be a symlink');
  const originalBytes = readFileSync(resolve(input, 'build.json')), original = JSON.parse(originalBytes);
  if (original.platform !== 'linux' || original.target !== 'x86_64-unknown-linux-gnu' || original.distributionProfile !== 'restricted-showcase'
    || original.nativePostProcessing !== undefined) throw Error('Only an original restricted Linux producer can be derived');
  const identity = { distributionProfile: original.distributionProfile, policySha256: original.policySha256 };
  verifyNativeProducerFiles(input, original, original.target, identity);
  const staged = resolve(dirname(out), `.${out.split(sep).at(-1)}-${randomUUID()}`);
  mkdirSync(staged, { recursive: true });
  try {
    for (const artifact of original.artifacts) {
      const destination = resolve(staged, artifact.file); mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(resolve(input, artifact.file), destination);
    }
    for (const name of ['RUNTIME-LICENSE', 'cargo-build.jsonl']) {
      const path = resolve(input, name);
      if (existsSync(path)) { if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw Error('Original metadata must be regular'); copyFileSync(path, resolve(staged, name)); }
      else if (name === 'RUNTIME-LICENSE') throw Error('Original runtime license is required');
    }
    const operation = hardenLinuxStaticArchive(resolve(staged, 'libweapp_container_sdk.a'), { strip, sourcePrefixes: ['/home/runner/', '/Users/', 'D:\\a\\', 'D:/a/'] });
    const final = structuredClone(original);
    final.artifacts = original.artifacts.map(artifact => {
      const bytes = readFileSync(resolve(staged, artifact.file));
      return { ...artifact, bytes: bytes.length, sha256: sha(bytes) };
    });
    const finalSource = captureNativeSource(sourceRoot); assertCleanNativeSource(finalSource, source);
    final.nativePostProcessing = { schemaVersion: 1, operation: 'retained-native-debug-hardening', compilationExecuted: false, source,
      originalSourceCommit: original.sourceCommit,
      originalReceipt: { file: 'original-producer-receipt.json', bytes: originalBytes.length, sha256: sha(originalBytes) },
      operations: [{ file: 'libweapp_container_sdk.a', ...operation }], finishedAt: new Date().toISOString() };
    // Keep the exact original JSON bytes reconstructible without putting its
    // command paths into the public wrapper's nativeIdentity projection.
    final.originalNativeProducerReceipt = originalBytes.toString('utf8');
    writeFileSync(resolve(staged, 'original-producer-receipt.json'), originalBytes, { flag: 'wx' });
    writeFileSync(resolve(staged, 'build.json'), JSON.stringify(final, null, 2) + '\n', { flag: 'wx' });
    verifyNativeProducerFiles(staged, final, final.target, identity);
    verifyNativeProducerFiles(input, original, original.target, identity);
    if (!readFileSync(resolve(input, 'build.json')).equals(originalBytes)) throw Error('Original producer changed during post-processing');
    renameSync(staged, out);
    return { status: 'derived-native-not-recompiled', input, out, originalSourceCommit: original.sourceCommit, postProcessingSourceCommit: source.sourceCommit,
      originalReceiptSha256: sha(originalBytes), finalReceiptSha256: sha(readFileSync(resolve(out, 'build.json'))), operations: final.nativePostProcessing.operations };
  } finally { rmSync(staged, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index]?.slice(2);
      if (!['input', 'out', 'strip'].includes(name) || options[name] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw Error('Usage: --input <original native target directory> --out <new native target directory> [--strip <GNU/LLVM strip>]');
      options[name] = args[index + 1];
    }
    if (!options.input || !options.out) throw Error('Explicit --input and --out are required');
    console.log(JSON.stringify(hardenRetainedNative(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
