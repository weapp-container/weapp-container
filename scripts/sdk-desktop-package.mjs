#!/usr/bin/env node
// The standalone desktop SDK links against a reviewed runtime distribution.
import { sdkDistribution } from './lib/sdk-distribution.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNativeProducerSet, assertSdkProducer, verifyNativeProducerFiles } from './lib/sdk-current-release.mjs';
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
function releaseInputs(native, targets, expectedDistribution) {
  const receipts = targets.map(target => {
    const receipt = JSON.parse(readFileSync(resolve(native, target, 'build.json'), 'utf8'));
    return verifyNativeProducerFiles(resolve(native, target), receipt, target, expectedDistribution);
  });
  assertNativeProducerSet(receipts, targets, expectedDistribution);
}
if (args.includes('--help')) {
  console.log(`Usage: node scripts/sdk-desktop-package.mjs [--target macos-universal|macos-arm64|macos-x64|windows-x64|linux-x64]
  [--out <directory>] [--native-root <directory>] [--licenses-root <directory>]
  [--skip-consumer] [--verify] [--pack <portable pack>] [--run-arch <architecture>]
  [--distribution-profile full|restricted-showcase] [--showcase-policy <JSON>] [--showcase-policy-sha256 <hex>]
Defaults: core artifacts/sdk/{native,licenses,desktop}. Native compilation is a separate sdk-native-build.mjs step.
--verify requires a consumer and defaults to the authored sdk/contract acceptance fixture.`);
  process.exit(0);
}
const { values, flags } = parse(['--distribution-profile', '--showcase-policy', '--showcase-policy-sha256', '--target', '--out', '--native-root', '--licenses-root', '--pack', '--run-arch'], ['--skip-consumer', '--verify']);
const { expectedDistribution, wrapperArgs } = sdkDistribution(values);
if (flags.has('--verify') && flags.has('--skip-consumer')) throw new Error('--verify cannot be combined with --skip-consumer');
const platform = values.get('--target') ?? (process.platform === 'darwin' ? 'macos-universal' : process.platform === 'win32' ? 'windows-x64' : 'linux-x64');
const matrix = {
  'macos-universal': ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
  'macos-arm64': ['aarch64-apple-darwin'], 'macos-x64': ['x86_64-apple-darwin'],
  'windows-x64': ['x86_64-pc-windows-msvc'], 'linux-x64': ['x86_64-unknown-linux-gnu'],
};
if (!matrix[platform]) throw new Error(`Unsupported desktop target ${platform}`);
if ((platform.startsWith('macos') && process.platform !== 'darwin') || (platform.startsWith('windows') && process.platform !== 'win32') || (platform.startsWith('linux') && process.platform !== 'linux')) throw new Error('Desktop packaging requires the target platform host');
const native = resolve(values.get('--native-root') ?? resolve(root, 'artifacts/sdk/native'));
const licenses = resolve(values.get('--licenses-root') ?? resolve(root, 'artifacts/sdk/licenses'));
const sdk = resolve(root, 'sdk/desktop');
releaseInputs(native, matrix[platform], expectedDistribution);
const forwarded = [...wrapperArgs, '--target', platform, '--native-root', native, '--licenses-root', licenses,
  '--out', resolve(values.get('--out') ?? resolve(root, 'artifacts/sdk/desktop'))];
if (flags.has('--skip-consumer')) forwarded.push('--skip-consumer');
if (flags.has('--verify')) forwarded.push('--verify');
if (values.has('--run-arch')) forwarded.push('--run-arch', values.get('--run-arch'));
if (values.has('--pack') || flags.has('--verify')) {
  const pack = resolve(values.get('--pack') ?? resolve(root, 'artifacts/sdk/fixtures/acceptance-pack'));
  if (!values.has('--pack')) run(resolve(root, 'sdk/contract/fixtures/make-acceptance-pack.mjs'), ['--out', pack]);
  forwarded.push('--pack', pack);
}
run(resolve(sdk, 'tools/build.mjs'), forwarded, sdk);
assertSdkProducer(JSON.parse(readFileSync(resolve(values.get('--out') ?? resolve(root, 'artifacts/sdk/desktop'), platform, 'package.json'), 'utf8')), flags.has('--verify') ? 'verified' : 'packaged', platform.split('-')[0], expectedDistribution);
