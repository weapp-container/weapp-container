import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createBuildPlan, parseArgs } from './build-web-wasm.mjs';
import { assertNativeProducer } from './lib/sdk-current-release.mjs';
import { nativeBuildPlan, parseNativeBuildArgs, assertNativeFeatureIdentity } from './lib/sdk-native-features.mjs';
import { normalizeShowcasePolicy, loadDistributionInput, verifyDistributionInput,
  assertDistributionIdentity, verifyDistributionArtifact } from './lib/showcase-policy.mjs';

test('showcase policy is bounded, canonical and cannot be selected implicitly', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'showcase-policy-')); t.after(() => rmSync(root, { recursive:true, force:true }));
  const path = resolve(root, 'policy.json');
  const value = { schemaVersion:1, allowedPackRoots:['b'.repeat(64), 'a'.repeat(64)], allowedApis:['wx.timer','wx.canIUse'] };
  writeFileSync(path, JSON.stringify(value, null, 2));
  const input = loadDistributionInput({ distributionProfile:'restricted-showcase', showcasePolicy:path });
  assert.deepEqual(input.policy.allowedPackRoots, ['a'.repeat(64),'b'.repeat(64)]);
  assert.match(input.policySha256, /^[a-f0-9]{64}$/);
  assertDistributionIdentity(input, input);
  assert.throws(() => assertDistributionIdentity(input), /mismatch/);
  for (const patch of [{ allowedApis:[] }, { allowedPackRoots:[] }, { schemaVersion:2 }, { allowedApis:['wx.timer','wx.timer'] },
    { allowedApis:['wx.request()'] }, { allowedPackRoots:['A'.repeat(64)] }, { extra:'not admitted' }]) {
    assert.throws(() => normalizeShowcasePolicy({ ...value, ...patch }));
  }
  for (const options of [{ showcasePolicy:path }, { distributionProfile:'restricted-showcase' },
    { distributionProfile:'restricted-showcase',showcasePolicy:path,profile:'dev' },
    { distributionProfile:'restricted-showcase',showcasePolicy:path,viewDiagnostics:'cpu' }]) assert.throws(() => loadDistributionInput(options));
  const marker = Buffer.from(`wasm-prefix\0weapp-container-distribution:restricted-showcase:${input.policySha256}\0end`);
  assert.equal(verifyDistributionArtifact(marker, input).markerVerified, true);
  assert.throws(() => verifyDistributionArtifact(marker, {}));
  assert.throws(() => verifyDistributionArtifact(marker, { ...input,policySha256:'c'.repeat(64) }));
  writeFileSync(path, JSON.stringify({ ...value, allowedApis:['wx.canIUse'] }));
  assert.throws(() => verifyDistributionInput(input), /changed/);
});

test('web and native producers select exact restricted features and provenance', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'showcase-producer-')); t.after(() => rmSync(root, { recursive:true, force:true }));
  const policy = resolve(root, 'policy.json');
  writeFileSync(policy, readFileSync(new URL('../crates/container-runtime/tests/fixtures/showcase-policy.json', import.meta.url)));
  const raw = parseArgs(['--pack',resolve(root,'pack'),'--out-dir',resolve(root,'out'),'--llvm-bin','/llvm',
    '--distribution-profile','restricted-showcase','--showcase-policy',policy]);
  const web = createBuildPlan(raw);
  assert.equal(web.distributionProfile, 'restricted-showcase'); assert.equal(web.policySha256.length, 64);
  assert.deepEqual(web.features, ['wasm','quickjs-native','restricted-showcase']);
  assert.ok(web.cargoArgs.includes('wasm,quickjs-native,restricted-showcase'));
  const full = createBuildPlan({ ...raw,distributionProfile:'full',showcasePolicy:undefined });
  assert.deepEqual(full.features, ['wasm','quickjs-native']); assert.equal(full.policySha256, null);
  assert.throws(() => createBuildPlan({ ...raw,showcasePolicy:undefined }));
  const native = nativeBuildPlan('aarch64-apple-darwin','off','restricted-showcase');
  assert.ok(native.features.includes('restricted-showcase'));
  assert.throws(() => parseNativeBuildArgs(['--distribution-profile','restricted-showcase']));
  assert.throws(() => parseNativeBuildArgs(['--showcase-policy',policy]));
  assert.throws(() => nativeBuildPlan('aarch64-apple-darwin','cpu','restricted-showcase'));
  const receipt = { schemaVersion:1,sdkVersion:'0.1.0-preview.6.0',abiVersion:1,target:'aarch64-apple-darwin',
    platform:'macos',viewDiagnostics:'off',features:[...native.features],profile:'release',status:'built',
    sourceCommit:'a'.repeat(40),sourceDirty:false,artifacts:[{file:'libweapp_container_sdk.a',bytes:100,sha256:'b'.repeat(64)}],
    distributionProfile:web.distributionProfile,policySha256:web.policySha256 };
  assertNativeFeatureIdentity(receipt);
  assertNativeProducer(receipt,receipt.target,web);
  assert.throws(() => assertNativeProducer(receipt), /mismatch/);
  assert.throws(() => assertNativeFeatureIdentity({ ...receipt,features:receipt.features.filter(value=>value!=='restricted-showcase') }));
});
