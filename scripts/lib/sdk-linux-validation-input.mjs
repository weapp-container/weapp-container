import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertCleanNativeSource, verifyNativeProducerFiles } from './sdk-current-release.mjs';

/** Bind all later Linux validation commands to the actual compiled runtime. */
export function linuxValidationInput(nativeRoot, expectedSource) {
  assertCleanNativeSource(expectedSource);
  const target = 'x86_64-unknown-linux-gnu', directory = resolve(nativeRoot, target);
  const bytes = readFileSync(resolve(directory, 'build.json'));
  const native = verifyNativeProducerFiles(directory, JSON.parse(bytes), target);
  assertCleanNativeSource(native, expectedSource);
  if (!native.artifacts.some(artifact => artifact.file === 'libweapp_container_sdk.so')) {
    throw Error('Linux validation requires an inventoried dynamic runtime');
  }
  return { native, features: native.features.join(','), receiptSha256: createHash('sha256').update(bytes).digest('hex') };
}
