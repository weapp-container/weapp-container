#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SDK_RELEASE_VERSION } from '../../../scripts/lib/sdk-current-release.mjs';

const playerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function prepare(argv, { root = playerRoot, runner = spawnSync } = {}) {
  const sdk = resolve(root, '../../sdk/flutter');
  const allowed = new Set(['--platform', '--artifact-dir', '--manifest']);
  const options = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || options.has(argv[i])) {
      throw new Error('Usage: node tools/prepare.mjs --platform android|ios|macos|windows|linux [--manifest /reviewed/lock.json] [--artifact-dir /authorized/archives]');
    }
    options.set(argv[i], argv[i + 1]);
  }
  const platform = options.get('--platform');
  if (!['android', 'ios', 'macos', 'windows', 'linux'].includes(platform)) {
    throw new Error('ERR_PLAYER_PLATFORM: select a supported native platform');
  }
  const manifest = resolve(options.get('--manifest') ?? join(sdk, 'runtime-artifacts.lock.json'));
  const lock = JSON.parse(readFileSync(manifest, 'utf8'));
  if (lock.runtimeVersion !== SDK_RELEASE_VERSION || lock.abiVersion !== 1) {
    throw new Error(`ERR_PLAYER_RUNTIME_PIN: ${SDK_RELEASE_VERSION} / ABI 1 artifacts are required. The Player does not substitute an older runtime.`);
  }
  const args = [join(sdk, 'tools/prepare-native.mjs'), '--platform', platform, '--arch',
    ['windows', 'linux'].includes(platform) ? 'x86_64' : 'universal', '--manifest', manifest];
  if (options.has('--artifact-dir')) args.push('--artifact-dir', resolve(options.get('--artifact-dir')));
  const prepared = runner(process.execPath, args, { cwd: sdk, stdio: 'inherit' });
  if (prepared.error) throw prepared.error;
  return prepared.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = prepare(process.argv.slice(2));
}
