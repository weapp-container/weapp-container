import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NATIVE_TARGETS } from './lib/sdk-native-features.mjs';
import { assertNativeProducerSet, verifyNativeProducerFiles } from './lib/sdk-current-release.mjs';
const directory = resolve(process.argv[2] ?? 'artifacts/sdk/native');
const targets = Object.keys(NATIVE_TARGETS);
const receipts = targets.map(target => {
  const path = resolve(directory, target);
  const receipt = JSON.parse(readFileSync(resolve(path, 'build.json')));
  verifyNativeProducerFiles(path, receipt, target, { distributionProfile: 'full', policySha256: null });
  return receipt;
});
assertNativeProducerSet(receipts, targets, { distributionProfile: 'full', policySha256: null });
console.log(`Verified ${receipts.length} native targets from ${receipts[0].sourceCommit}`);
