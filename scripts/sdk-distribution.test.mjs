import test from 'node:test';
import assert from 'node:assert/strict';
import { sdkDistribution } from './lib/sdk-distribution.mjs';
import { loadDistributionInput } from './lib/showcase-policy.mjs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const policy = fileURLToPath(new URL('../crates/container-runtime/tests/fixtures/showcase-policy.json', import.meta.url));
test('SDK orchestration derives wrapper policy identity from the actual producer policy', () => {
  const expected = loadDistributionInput({ distributionProfile: 'restricted-showcase', showcasePolicy: policy });
  const value = sdkDistribution(new Map([['--distribution-profile','restricted-showcase'],['--showcase-policy',policy]]));
  assert.deepEqual(value.expectedDistribution, { distributionProfile: 'restricted-showcase', policySha256: expected.policySha256 });
  assert.deepEqual(value.producerArgs, ['--distribution-profile','restricted-showcase','--showcase-policy',policy]);
  assert.deepEqual(value.wrapperArgs, ['--distribution-profile','restricted-showcase','--showcase-policy-sha256',expected.policySha256]);
  assert.throws(() => sdkDistribution(new Map([['--distribution-profile','restricted-showcase'],['--showcase-policy',policy],['--showcase-policy-sha256','f'.repeat(64)]])), /mismatch/);
});
test('SDK orchestration keeps full default and supports independently pinned prebuilt policy identity', () => {
  assert.deepEqual(sdkDistribution(new Map()).expectedDistribution, { distributionProfile: 'full', policySha256: null });
  assert.throws(() => sdkDistribution(new Map([['--distribution-profile','restricted-showcase']])));
  assert.throws(() => sdkDistribution(new Map([['--showcase-policy-sha256','a'.repeat(64)]])));
  assert.equal(sdkDistribution(new Map([['--distribution-profile','restricted-showcase'],['--showcase-policy-sha256','a'.repeat(64)]])).expectedDistribution.policySha256, 'a'.repeat(64));
});
test('Flutter orchestration rejects an incomplete restricted identity before invoking native or Flutter tools', () => {
  const value = spawnSync(process.execPath, [fileURLToPath(new URL('./sdk-flutter-build.mjs', import.meta.url)),
    '--distribution-profile', 'restricted-showcase'], { encoding: 'utf8' });
  assert.notEqual(value.status, 0);
  assert.match(value.stderr, /Invalid distribution profile or policy SHA-256/);
  assert.doesNotMatch(value.stdout, /Running /);
});
