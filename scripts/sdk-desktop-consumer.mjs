#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeFixture } from '../examples/sdk/shared/make-fixture.mjs';
import { SDK_RELEASE_VERSION, assertSdkProducer } from './lib/sdk-current-release.mjs';
import { installDesktopConsumerArchive, prepareDesktopConsumerHarness } from './lib/sdk-desktop-consumer-harness.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[index + 1];
}
const allowed = ['--sdk', '--manifest', '--artifact-dir', '--consumer-source', '--arch', '--out'];
for (let index = 0; index < args.length; index += 2) {
  if (!allowed.includes(args[index]) || args.indexOf(args[index]) !== index) throw Error('Unknown or duplicate desktop consumer option');
  option(args[index]);
}
const source = option('--sdk'), manifest = option('--manifest'), artifactDirectory = option('--artifact-dir');
if (Boolean(source) === Boolean(manifest)) throw new Error('Select exactly one --manifest <pinned archive manifest> or --sdk <existing desktop SDK directory>');
if (artifactDirectory && !manifest) throw new Error('--artifact-dir requires --manifest');
const consumerSource = option('--consumer-source', resolve(root, 'sdk/desktop'));
const architecture = option('--arch', process.arch);
if (!['arm64', 'x64'].includes(architecture)) throw new Error('--arch must be arm64 or x64');
if (process.platform !== 'darwin' && architecture !== process.arch) throw new Error('Non-Apple consumers must execute the native host architecture');
const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : undefined;
if (!platform) throw new Error('Desktop consumer requires macOS, Windows or Linux');
if (platform !== 'macos' && architecture !== 'x64') throw new Error('Windows/Linux archive consumers require the supported x64 host architecture');
const validation = resolve(option('--out', resolve(root, 'artifacts/sdk/validation'))); mkdirSync(validation, { recursive: true });
const work = mkdtempSync(resolve(validation, `desktop-${process.platform}-${architecture}-`));
const staged = resolve(work, 'sdk-original'), installed = resolve(work, 'sdk-relocated');
const report = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, status: 'running', architecture, execution: process.platform === 'darwin' && process.arch !== architecture ? 'Rosetta x86_64' : `${process.platform}-${process.arch}`,
  environment: { platform, osRelease: release(), hostArchitecture: process.arch, node: process.version },
  scope: 'Public C/C++ embedding lifecycle fixture. New host-service API, physical hardware and merchant acceptance require their own evidence.', checks: [] };
const save = () => writeFileSync(resolve(work, 'validation.json'), `${JSON.stringify(report, null, 2)}\n`);
function run(label, command, argv) {
  const result = spawnSync(command, argv, { cwd: work, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  const log = `${report.checks.length + 1}-${label}.log`;
  writeFileSync(resolve(work, log), `${result.stdout || ''}${result.stderr || ''}`);
  report.checks.push({ label, command, args: argv, exitCode: result.status, signal: result.signal, error: result.error?.message, log }); save();
  if (result.error || result.status !== 0) throw new Error(`${label} failed; see ${resolve(work, log)}`);
}
try {
  let input = source;
  if (manifest) {
    report.input = await installDesktopConsumerArchive({ manifestPath: resolve(manifest), artifactDirectory, platform, workDirectory: work, installDirectory: staged });
    input = staged;
  } else report.input = { kind: 'existing-sdk-directory', scope: 'Directory relocation only; this is not fresh archive installation evidence.' };
  const receipt = JSON.parse(readFileSync(resolve(input, 'package.json'), 'utf8'));
  if (!['verified', 'packaged'].includes(receipt.status) || receipt.sdkVersion !== report.sdkVersion) throw new Error('A successfully packaged SDK receipt is required');
  assertSdkProducer(receipt, receipt.status, platform);
  for (const item of receipt.artifacts) {
    if (createHash('sha256').update(readFileSync(resolve(input, item.file))).digest('hex') !== item.sha256) throw new Error(`Distribution checksum mismatch: ${item.file}`);
  }
  report.sourceCommit = receipt.sourceCommit; report.artifacts = receipt.artifacts;
  if (source) cpSync(resolve(source), staged, { recursive: true });
  renameSync(staged, installed);
  report.relocation = { from: staged, to: installed };
  const harness = resolve(work, 'consumer-harness');
  report.consumer = prepareDesktopConsumerHarness({ sourceRoot: consumerSource, receipt, destination: harness });
  report.packIntegrity = makeFixture(root, resolve(work, 'portable-pack'));
  const build = resolve(work, 'build');
  const apple = process.platform === 'darwin' ? [`-DCMAKE_OSX_ARCHITECTURES=${architecture === 'x64' ? 'x86_64' : 'arm64'}`, '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0'] : [];
  run('configure', 'cmake', ['-S', harness, '-B', build, `-DCMAKE_PREFIX_PATH=${installed}`, '-DCMAKE_BUILD_TYPE=Release', ...apple]);
  run('build-without-rust', 'cmake', ['--build', build, '--config', 'Release', '--parallel', '4']);
  const binary = resolve(build, process.platform === 'win32' ? 'Release/desktop_consumer.exe' : 'desktop_consumer');
  const runtimeInput = [resolve(work, 'portable-pack'), resolve(work, 'consumer-result.txt')];
  if (process.platform === 'darwin' && architecture === 'x64') run('execute', 'arch', ['-x86_64', binary, ...runtimeInput]);
  else run('execute', binary, runtimeInput);
  const result = readFileSync(resolve(work, 'consumer-result.txt'));
  if (!result.toString().startsWith('PASS installed C/C++ consumers;')) throw Error('Desktop consumer did not provide its completed lifecycle result');
  report.consumerResult = { file: 'consumer-result.txt', sha256: createHash('sha256').update(result).digest('hex') };
  report.cleanup = { workloadProcess: 'exited-successfully', nativeSessions: 'closed-by-reviewed-consumer', validationFiles: 'retained-for-audit' };
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }
report.finishedAt = new Date().toISOString(); save();
console.log(JSON.stringify({ status: report.status, report: resolve(work, 'validation.json'), error: report.error }, null, 2));
