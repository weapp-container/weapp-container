#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
for (const name of ['contract', 'android', 'ios', 'desktop', 'flutter', 'react-native']) {
  const cwd = resolve(root, 'sdk', name);
  const folder = ['flutter', 'react-native'].includes(name) ? 'tests' : 'test';
  const files = readdirSync(resolve(cwd, folder)).filter(file => file.endsWith('.test.mjs')).sort().map(file => `${folder}/${file}`);
  if (!files.length) throw Error(`No source contract tests found for sdk/${name}`);
  console.log(`Testing sdk/${name}`);
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  failed ||= result.status !== 0;
}
if (failed) process.exitCode = 1;
