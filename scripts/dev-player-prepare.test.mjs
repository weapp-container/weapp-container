import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepare } from '../apps/dev-player/tools/prepare.mjs';
import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs';

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'player-prepare-'));
  const root = join(directory, 'apps/dev-player');
  mkdirSync(root, { recursive: true });
  const sdk = join(directory, 'sdk/flutter');
  mkdirSync(sdk, { recursive: true });
  const manifest = join(directory, 'reviewed.json');
  const write = (path, version, abiVersion = 1) => writeFileSync(path, JSON.stringify({ runtimeVersion: version, abiVersion }));
  try { run({ root, sdk, manifest, write }); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('Player forwards the explicit current lock and offline directory to the strict SDK installer', () => fixture(f => {
  // A stale default lock must not override an explicit reviewed generation.
  f.write(join(f.sdk, 'runtime-artifacts.lock.json'), '0.1.0-preview.4');
  f.write(f.manifest, SDK_RELEASE_VERSION);
  const calls = [];
  const result = prepare(['--platform', 'android', '--manifest', f.manifest, '--artifact-dir', f.sdk], {
    root: f.root, runner: (...args) => { calls.push(args); return { status: 0 }; },
  });
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], [join(f.sdk, 'tools/prepare-native.mjs'), '--platform', 'android', '--arch',
    'universal', '--manifest', resolve(f.manifest), '--artifact-dir', resolve(f.sdk)]);
}));

test('old or mismatched ABI locks fail before an installer can execute', () => fixture(f => {
  for (const [version, abi] of [['0.1.0-preview.4', 1], [SDK_RELEASE_VERSION, 2]]) {
    f.write(join(f.sdk, 'runtime-artifacts.lock.json'), version, abi);
    assert.throws(() => prepare(['--platform', 'ios'], {
      root: f.root, runner: () => assert.fail('incompatible installer ran'),
    }), /ERR_PLAYER_RUNTIME_PIN/);
  }
}));

test('installer failure remains a failure and malformed arguments never invoke it', () => fixture(f => {
  f.write(join(f.sdk, 'runtime-artifacts.lock.json'), SDK_RELEASE_VERSION);
  assert.equal(prepare(['--platform', 'linux'], { root: f.root, runner: () => ({ status: 7 }) }), 7);
  for (const args of [['--platform', 'android', '--manifest'], ['--platform', 'android', '--platform', 'ios']]) {
    assert.throws(() => prepare(args, { root: f.root, runner: () => assert.fail('invalid arguments ran') }), /Usage:/);
  }
}));
