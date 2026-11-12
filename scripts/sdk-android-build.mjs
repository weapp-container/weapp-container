#!/usr/bin/env node
// Private core orchestration; the independently versioned SDK builds its wrapper.
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
  console.log(`Usage: node scripts/sdk-android-build.mjs [--out <directory>] [--native-root <directory>]
  [--licenses-root <directory>] [--pack <portable pack>] [--target-dir <Cargo output>]
  [--skip-native] [--skip-licenses] [--offline]
  [--distribution-profile full|restricted-showcase] [--showcase-policy <JSON>] [--showcase-policy-sha256 <hex>]
  [--showcase-font <reviewed TTF>] [--showcase-font-license <reviewed OFL>]
Defaults: core artifacts/sdk/{native,licenses,android}; fixture from sdk/contract.
Only this private core orchestrator invokes Rust. sdk/android/tools/build.mjs consumes verified inputs.`);
  process.exit(0);
}
const { values, flags } = parse(['--distribution-profile', '--showcase-policy', '--showcase-policy-sha256', '--showcase-font', '--showcase-font-license', '--out', '--native-root', '--licenses-root', '--pack', '--target-dir'], ['--skip-native', '--skip-licenses', '--offline']);
const { expectedDistribution, producerArgs, wrapperArgs, fontArgs } = sdkDistribution(values);
const native = resolve(values.get('--native-root') ?? resolve(root, 'artifacts/sdk/native'));
const licenses = resolve(values.get('--licenses-root') ?? resolve(root, 'artifacts/sdk/licenses'));
const out = resolve(values.get('--out') ?? resolve(root, 'artifacts/sdk/android'));
const sdk = resolve(root, 'sdk/android');
const targets = ['aarch64-linux-android', 'x86_64-linux-android'];
const offline = flags.has('--offline') ? ['--offline'] : [];
for (const target of targets) {
  if (!flags.has('--skip-native')) run(resolve(root, 'scripts/sdk-native-build.mjs'), ['--target', target, '--profile', 'release', '--out', native, ...producerArgs,
    ...(values.has('--target-dir') ? ['--target-dir', resolve(values.get('--target-dir'))] : []), ...offline]);
  if (!flags.has('--skip-licenses')) run(resolve(root, 'scripts/sdk-licenses.mjs'), ['--target', target,
    '--features', ['quickjs-native-android', 'skia-gpu-gles', ...(expectedDistribution.distributionProfile === 'restricted-showcase' ? ['restricted-showcase'] : [])].join(','), '--out', resolve(licenses, target), ...fontArgs, ...offline]);
}
releaseInputs(native, targets, expectedDistribution);
const pack = resolve(values.get('--pack') ?? resolve(root, 'artifacts/sdk/fixtures/acceptance-pack'));
if (!values.has('--pack')) run(resolve(root, 'sdk/contract/fixtures/make-acceptance-pack.mjs'), ['--out', pack]);
run(resolve(sdk, 'tools/build.mjs'), [...wrapperArgs, '--native-root', native, '--licenses-root', licenses, '--out', out, '--pack', pack, ...offline], sdk);
assertSdkProducer(JSON.parse(readFileSync(resolve(out, 'distribution.json'), 'utf8')), 'passed', 'android', expectedDistribution);
