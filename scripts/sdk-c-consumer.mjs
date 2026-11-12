#!/usr/bin/env node
// Compile and run a relocated consumer using only copied distribution files.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from '../examples/sdk/shared/make-fixture.mjs';
import { cConsumerCompileArguments, stageCConsumerNativeInput } from './lib/sdk-c-consumer-input.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetIndex = process.argv.indexOf('--target');
const target = targetIndex === -1 ? undefined : process.argv[targetIndex + 1];
if (!target || target.startsWith('--')) throw new Error('--target is required');
const apple = target.endsWith('apple-darwin');
if (!apple && target !== 'x86_64-unknown-linux-gnu') throw new Error('Use the desktop CMake consumer for other targets');
if (apple && process.platform !== 'darwin') throw new Error('Apple consumers require macOS');
if (!apple && process.platform !== 'linux') throw new Error('Linux consumers require Linux');
const native = resolve(root, 'artifacts/sdk/native', target);
const validation = resolve(root, 'artifacts/sdk/validation');
mkdirSync(validation, { recursive: true });
const staging = mkdtempSync(resolve(validation, `${target}-c-staging-`));
for (const child of ['include', 'lib', 'bin']) mkdirSync(resolve(staging, child));
const input = stageCConsumerNativeInput({ nativeDirectory: native, contractDirectory: resolve(root, 'sdk/contract/include'), target, destination: staging });
const { receipt, library } = input;
const expected = input.files.find(artifact => artifact.file === library);
copyFileSync(resolve(root, 'crates/container-sdk-ffi/tests/c_consumer.c'), resolve(staging, 'consumer.c'));
const packIntegrity = makeFixture(root, resolve(staging, 'portable-pack'));
const args = cConsumerCompileArguments({ directory: staging, target, sdkVersion: receipt.sdkVersion });
const compile = spawnSync(process.env.CC || 'cc', args, { encoding: 'utf8' });
writeFileSync(resolve(staging, 'compile.log'), `${compile.stdout || ''}${compile.stderr || ''}`);
if (compile.status !== 0) throw new Error(`Consumer compilation failed: ${compile.error?.message || compile.stderr}`);
const installed = staging.replace('-c-staging-', '-c-installed-');
renameSync(staging, installed);
const executable = resolve(installed, 'bin/consumer');
const load = JSON.stringify({ packPath: resolve(installed, 'portable-pack') });
const command = apple && target.startsWith('x86_64') ? 'arch' : executable;
const runtimeArgs = command === 'arch' ? ['-x86_64', executable, load] : [load];
const run = spawnSync(command, runtimeArgs, { cwd: installed, encoding: 'utf8', timeout: 30_000 });
writeFileSync(resolve(installed, 'run.log'), `${run.stdout || ''}${run.stderr || ''}`);
const report = { schemaVersion: 1, target, status: run.status === 0 ? 'passed' : 'failed',
  checks: ['C compilation', 'copied header and library', 'checksum', 'relocation after linking', 'real QuickJS pack', 'immutable frame survives session'],
  packIntegrity, sourceCommit: receipt.sourceCommit, nativeLibrarySha256: expected.sha256,
  nativeReceiptSha256: input.receiptSha256, nativeInputs: input.files,
  architectureExecution: command === 'arch' ? 'Rosetta x86_64' : process.arch,
  exitCode: run.status, signal: run.signal, error: run.error?.message, output: installed };
writeFileSync(resolve(installed, 'validation.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (run.status !== 0) { console.error(run.stderr || run.error); process.exitCode = 1; }
