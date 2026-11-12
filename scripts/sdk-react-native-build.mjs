#!/usr/bin/env node
// The standalone SDK owns TypeScript/codegen/package work and release-pin checks.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sdkDistribution } from './lib/sdk-distribution.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function parse(args, valueNames, flagNames) {
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
export function packageArguments(args, repository = root) {
  const distributionOptions = ['--distribution-profile', '--showcase-policy', '--showcase-policy-sha256'];
  const { values } = parse(args, ['--ios', '--android', '--out', '--manifest', '--manifest-sha256', '--artifact-dir', ...distributionOptions], []);
  const { wrapperArgs } = sdkDistribution(values);
  const sdk = resolve(repository, 'sdk/react-native');
  const forwarded = ['--ios', resolve(values.get('--ios') ?? resolve(sdk, 'native/ios')),
    '--android', resolve(values.get('--android') ?? resolve(sdk, 'native/android')),
    '--out', resolve(values.get('--out') ?? resolve(repository, 'artifacts/sdk/react-native'))];
  for (const name of ['--manifest', '--manifest-sha256', '--artifact-dir']) if (values.has(name)) {
    forwarded.push(name, name === '--manifest-sha256' ? values.get(name) : resolve(values.get(name)));
  }
  if (distributionOptions.some(name => values.has(name))) forwarded.push(...wrapperArgs);
  return forwarded;
}
export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(`Usage: node scripts/sdk-react-native-build.mjs [--ios <pinned iOS SDK installation>]
  [--android <pinned Android SDK installation>] [--out <directory>]
  [--manifest <reviewed release lock>] [--manifest-sha256 <exact digest>]
  [--artifact-dir <authorized offline archives>]
  [--distribution-profile full|restricted-showcase] [--showcase-policy <JSON>] [--showcase-policy-sha256 <hex>]
First prepare exact release pins with sdk/react-native/tools/prepare-native.mjs for android and ios.
Defaults: sdk/react-native/native/{ios,android}; output core artifacts/sdk/react-native.
Pass the same explicit manifest and archive directory used by preparation.
Legacy unpinned build directories are rejected by the standalone package tool. No Rust build or publication occurs here.`);
    return;
  }
  const sdk = resolve(root, 'sdk/react-native');
  run(resolve(sdk, 'tools/package.mjs'), packageArguments(args), sdk);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
