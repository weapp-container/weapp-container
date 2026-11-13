import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs';
import { SDK_VERSION, RUNTIME_REPOSITORY, LEGACY_RUNTIME_VERSIONS, selectArtifact } from '../sdk/contract/tools/runtime-artifacts.mjs';
const read = path => readFile(new URL(`../${path}`, import.meta.url));
const json = async path => JSON.parse(await read(path));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('producer policy, source contract, downloader and schema share reviewed identities', async () => {
  const policy = await json('tools/runtime-artifacts/policy.json');
  assert.equal(policy.repository, RUNTIME_REPOSITORY);
  assert.equal(policy.runtimeVersion, SDK_RELEASE_VERSION);
  assert.equal(policy.contractVersion, SDK_VERSION);
  assert.equal(sha(await read('sdk/contract/include/weapp_container_sdk.h')), policy.headerSha256);
  assert.equal(sha(await read('tools/runtime-artifacts/test/fixtures/weapp_container_sdk.h')), policy.headerSha256);
  assert.equal(sha(await read('tools/runtime-artifacts/LICENSE-APACHE-2.0')), policy.contractLicenseSha256);
  assert.deepEqual(await read('tools/runtime-artifacts/manifest.schema.json'), await read('sdk/contract/runtime-artifacts.schema.json'));
  const schema = await json('tools/runtime-artifacts/manifest.schema.json');
  assert.deepEqual(schema.allOf[0].then.properties.runtimeVersion.enum, LEGACY_RUNTIME_VERSIONS);
});
test('all historical SDK locks retain their validated historical repository', async () => {
  for (const sdk of ['contract', 'android', 'ios', 'desktop', 'flutter', 'react-native']) {
    const manifest = await json(`sdk/${sdk}/runtime-artifacts.lock.json`);
    assert.equal(manifest.source.repository, 'weapp-container/runtime-artifacts');
    for (const artifact of manifest.artifacts) selectArtifact(manifest, { version: manifest.runtimeVersion, abiVersion: manifest.abiVersion, ...artifact });
  }
});
test('all SDK published pins match the same complete public runtime release independently of the candidate', async () => {
  const { publishedRuntimeVersion } = await json('tools/runtime-artifacts/policy.json');
  assert.match(publishedRuntimeVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const name = `runtime-artifacts.${publishedRuntimeVersion}.lock.json`;
  const reference = await read(`sdk/contract/${name}`);
  for (const sdk of ['contract', 'android', 'ios', 'desktop', 'flutter', 'react-native']) {
    assert.deepEqual(await read(`sdk/${sdk}/${name}`), reference, `sdk/${sdk} release closure differs`);
  }
  const manifest = JSON.parse(reference);
  assert.equal(manifest.runtimeVersion, publishedRuntimeVersion);
  assert.equal(manifest.abiVersion, 1);
  assert.deepEqual(manifest.source, { repository: RUNTIME_REPOSITORY, releaseTag: `runtime-v${publishedRuntimeVersion}` });
  assert.equal(manifest.artifacts.filter(asset => asset.component === 'runtime').length, 9);
  assert.equal(manifest.artifacts.length, 14);
  for (const artifact of manifest.artifacts) selectArtifact(manifest, { version: publishedRuntimeVersion, abiVersion: 1, ...artifact });
});
