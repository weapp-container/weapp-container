#!/usr/bin/env node
// Packaging is implemented by the standalone Flutter SDK, without core source imports.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs';
import { sdkDistribution } from './lib/sdk-distribution.mjs';
import { assertDistributionIdentity } from './lib/showcase-policy.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function parse(valueNames, flagNames) {
  const values = new Map(), flags = new Set();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (values.has(name) || flags.has(name)) throw new Error(`Duplicate option ${name}`);
    if (valueNames.includes(name)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      values.set(name, value);
    } else if (flagNames.includes(name)) flags.add(name);
    else throw new Error(`Unknown option ${name}; use --help`);
  }
  return { values, flags };
}
function run(script, argv, cwd = root) {
  if (!existsSync(script)) throw new Error(`Missing SDK tool ${script}; initialize the pinned sdk submodules first`);
  const result = spawnSync(process.execPath, [script, ...argv], { cwd, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${script} failed: ${result.error?.message ?? result.status}`);
}
if (args.includes('--help')) {
  console.log(`Usage: node scripts/sdk-flutter-build.mjs [--out <directory>] [--platform android|ios|macos|windows|linux]
  [--flutter <executable>] [--android-ndk-version <version>] [--android-cmake-version <version>]
  [--android-maven <installed Maven directory>] [--android-receipt <receipt>]
  [--ios-sdk <pinned installation>] [--macos-sdk <pinned installation>]
  [--windows-sdk <pinned installation>] [--linux-sdk <pinned installation>]
  [--manifest <reviewed release lock>] [--distribution-profile full|restricted-showcase]
  [--showcase-policy <JSON>] [--showcase-policy-sha256 <hex>]
  [--portable-consumer] [--verbose]
First prepare exact release pins: node sdk/flutter/tools/prepare-native.mjs --platform <platform> --arch <pinned arch>.
Native defaults are sdk/flutter/.runtime/<platform>; output defaults to core artifacts/sdk/flutter.
Unprepared platforms are reported blocked. --skip-packages is rejected after the repository split.`);
  process.exit(0);
}
const pathOptions = ['--android-maven', '--android-receipt', '--ios-sdk', '--macos-sdk', '--windows-sdk', '--linux-sdk', '--manifest'];
const distributionOptions = ['--distribution-profile', '--showcase-policy', '--showcase-policy-sha256'];
const { values, flags } = parse(['--out', '--platform', '--flutter', '--android-ndk-version', '--android-cmake-version', ...pathOptions, ...distributionOptions], ['--portable-consumer', '--verbose', '--skip-packages']);
const { expectedDistribution, wrapperArgs } = sdkDistribution(values);
if (flags.has('--skip-packages')) throw new Error('--skip-packages cannot reuse pre-split distributions; rebuild from the standalone SDK and its pinned installations');
const platform = values.get('--platform');
if (platform && !['android', 'ios', 'macos', 'windows', 'linux'].includes(platform)) throw new Error(`Unsupported platform ${platform}`);
if (platform && flags.has('--portable-consumer')) throw new Error('--portable-consumer cannot be combined with --platform');
const sdk = resolve(root, 'sdk/flutter');
const forwarded = ['--out', resolve(values.get('--out') ?? resolve(root, 'artifacts/sdk/flutter'))];
for (const [name, value] of values) if (name !== '--out' && !distributionOptions.includes(name)) forwarded.push(name, pathOptions.includes(name) || name === '--flutter' && /[\\/]/.test(value) ? resolve(value) : value);
if (distributionOptions.some(name => values.has(name))) forwarded.push(...wrapperArgs);
for (const flag of flags) forwarded.push(flag);
run(resolve(sdk, 'tools/package.mjs'), forwarded, sdk);
const distribution = JSON.parse(readFileSync(resolve(values.get('--out') ?? resolve(root, 'artifacts/sdk/flutter'), 'distribution.json'), 'utf8'));
assertDistributionIdentity(distribution, expectedDistribution);
if (distribution.schemaVersion !== 1 || distribution.version !== SDK_RELEASE_VERSION || distribution.sourceDirty !== false || !/^[a-f0-9]{40}$/.test(distribution.sourceCommit ?? '')) throw new Error(`Standalone Flutter tool did not produce a clean committed ${SDK_RELEASE_VERSION} SDK distribution receipt`);
if (platform && distribution.targets?.[platform]?.status !== 'packaged') throw new Error(`Requested ${platform} SDK is blocked: ${distribution.targets?.[platform]?.reason ?? 'missing receipt'}`);
console.log(JSON.stringify({ status: platform ? 'built' : 'prepared', version: distribution.version,
  runtimeCompilation: 'not-run', targets: distribution.targets }, null, 2));
