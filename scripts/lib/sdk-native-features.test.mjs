import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NATIVE_TARGETS, parseNativeBuildArgs, nativeBuildPlan, assertNativeFeatureIdentity } from './sdk-native-features.mjs';
import { SDK_RELEASE_VERSION, assertNativeProducer } from './sdk-current-release.mjs';
import { nativeProducerFixture } from '../fixtures/sdk-native-producer.mjs';
import { nativeIdentity as androidIdentity } from '../../sdk/android/tools/native-input.mjs';
import { nativeIdentity as iosIdentity } from '../../sdk/ios/tools/native-input.mjs';
import { nativeIdentity as desktopIdentity } from '../../sdk/desktop/tools/native-input.mjs';

test('strict argument parser defaults off and rejects malformed or repeated options', () => {
  assert.equal(parseNativeBuildArgs([])['--view-diagnostics'], 'off');
  assert.equal(parseNativeBuildArgs([])['--profile'], 'release');
  for (const mode of ['off', 'cpu', 'atrace']) assert.equal(parseNativeBuildArgs(['--view-diagnostics', mode])['--view-diagnostics'], mode);
  for (const args of [['--view-diagnostics'], ['--view-diagnostics', '--offline'], ['--view-diagnostics', ''], ['--view-diagnostics', 'CPU'], ['--view-diagnostics', 'cpu', '--view-diagnostics', 'cpu'], ['--view-diagnostics=cpu'], ['cpu'], ['--offline', '--offline'], ['--target'], ['--profile', 'invalid'], ['--target', 'a', '--target', 'b']]) assert.throws(() => parseNativeBuildArgs(args), Error);
  assert.equal(parseNativeBuildArgs(['--offline', '--profile', 'dev'])['--offline'], true);
  assert.equal(parseNativeBuildArgs(['--llvm-strip', '/reviewed/llvm-strip'])['--llvm-strip'], '/reviewed/llvm-strip');
  for (const args of [['--llvm-strip'], ['--llvm-strip', '--offline'], ['--llvm-strip', 'a', '--llvm-strip', 'b']]) assert.throws(() => parseNativeBuildArgs(args), Error);
});

test('every exact native target has explicit off/cpu plans and only Android accepts atrace', () => {
  for (const [target, [platform, ...base]] of Object.entries(NATIVE_TARGETS)) {
    assert.deepEqual(nativeBuildPlan(target).features, base);
    assert.deepEqual(nativeBuildPlan(target, 'off').features, base);
    assert.deepEqual(nativeBuildPlan(target, 'cpu').features, [...base, 'view-batch-diagnostics']);
    if (platform === 'android') assert.deepEqual(nativeBuildPlan(target, 'atrace').features, [...base, 'view-batch-diagnostics', 'android-view-atrace']);
    else assert.throws(() => nativeBuildPlan(target, 'atrace'), /Android target/);
  }
  assert.throws(() => nativeBuildPlan('unsupported'), /Unsupported/);
  assert.throws(() => nativeBuildPlan('aarch64-linux-android', 'bad'), /off, cpu or atrace/);
});

test('mode and feature provenance survives all native wrapper projections and rejects mislabelling', () => {
  for (const mode of ['off', 'cpu', 'atrace']) {
    const target = 'aarch64-linux-android', plan = nativeBuildPlan(target, mode);
    const receipt = { ...nativeProducerFixture(target), viewDiagnostics: mode, features: [...plan.features] };
    assert.equal(assertNativeFeatureIdentity(receipt).viewDiagnostics, mode);
    for (const project of [androidIdentity, iosIdentity, desktopIdentity]) {
      const projected = project(receipt);
      assert.equal(projected.viewDiagnostics, mode);
      assert.deepEqual(projected.features, plan.features);
      assert.doesNotThrow(() => assertNativeProducer(projected));
    }
    for (const patch of [{ viewDiagnostics: undefined }, { viewDiagnostics: 'invalid' }, { features: [...plan.features, 'unknown-feature'] }, { features: [...plan.features, plan.features[0]] }, { sdkVersion: '0.1.0-preview.5.3' }]) assert.throws(() => assertNativeProducer({ ...receipt, ...patch }));
    if (mode !== 'off') assert.throws(() => assertNativeProducer({ ...receipt, viewDiagnostics: 'off' }));
  }
  assert.equal(SDK_RELEASE_VERSION, JSON.parse(readFileSync(new URL('../../tools/runtime-artifacts/policy.json', import.meta.url))).runtimeVersion);
});

test('diagnostic Cargo features remain opt-in and weakly forward both engine providers', () => {
  const text = name => readFileSync(new URL(`../../crates/${name}/Cargo.toml`, import.meta.url), 'utf8');
  const runtime = text('container-runtime');
  assert.match(runtime, /default = \[\]/);
  for (const engine of ['quickjs', 'v8']) for (const feature of ['view-batch-diagnostics', 'android-view-atrace']) assert.ok(runtime.includes(`"container-engine-${engine}?/${feature}"`));
  for (const [crate, dependency] of [['container-sdk', 'container-runtime'], ['container-sdk-ffi', 'container-sdk']]) {
    const source = text(crate), defaults = source.match(/^default = (.+)$/m)[1];
    assert.doesNotMatch(defaults, /diagnostics|atrace/);
    for (const feature of ['view-batch-diagnostics', 'android-view-atrace']) assert.ok(source.includes(`"${dependency}/${feature}"`));
  }
});
