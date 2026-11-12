import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { packageArguments } from './sdk-react-native-build.mjs';

test('RN parent wrapper forwards an explicit release lock, independent digest and offline archives unchanged', () => {
  const sha256 = 'a'.repeat(64);
  assert.deepEqual(packageArguments(['--ios', '/inputs/ios', '--android', '/inputs/android', '--out', '/new/package',
    '--manifest', '/release/preview6.json', '--manifest-sha256', sha256, '--artifact-dir', '/release/archives'], '/repo'),
  ['--ios', '/inputs/ios', '--android', '/inputs/android', '--out', '/new/package',
    '--manifest', '/release/preview6.json', '--manifest-sha256', sha256, '--artifact-dir', '/release/archives']);
});

test('RN parent defaults address prepared vendor installations; absent pins are never replaced', () => {
  assert.deepEqual(packageArguments([], '/repo'), ['--ios', '/repo/sdk/react-native/native/ios', '--android', '/repo/sdk/react-native/native/android', '--out', '/repo/artifacts/sdk/react-native']);
  const relative = packageArguments(['--manifest', 'release.json', '--artifact-dir', 'archives'], '/repo');
  assert.deepEqual(relative.slice(-4), ['--manifest', resolve('release.json'), '--artifact-dir', resolve('archives')]);
  for (const args of [['--manifest'], ['--manifest', 'a', '--manifest', 'b'], ['--artifact-dir', '--out'], ['--unknown', 'x']]) {
    assert.throws(() => packageArguments(args, '/repo'));
  }
});

test('RN parent keeps restricted identity explicit and rejects incomplete or conflicting identities', () => {
  const digest = 'b'.repeat(64);
  assert.deepEqual(packageArguments(['--distribution-profile', 'restricted-showcase', '--showcase-policy-sha256', digest], '/repo').slice(-4),
    ['--distribution-profile', 'restricted-showcase', '--showcase-policy-sha256', digest]);
  for (const args of [
    ['--distribution-profile', 'restricted-showcase'],
    ['--showcase-policy-sha256', digest],
    ['--distribution-profile', 'full', '--showcase-policy-sha256', digest],
  ]) assert.throws(() => packageArguments(args, '/repo'), /distribution|policy/i);
});
