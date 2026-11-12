#!/usr/bin/env node
// Run inside the pinned Ubuntu 22.04 build image. All GUI resources belong to
// this invocation; no developer display or unrelated compositor is touched.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from '../examples/sdk/shared/make-fixture.mjs';
import { SDK_RELEASE_VERSION, assertCleanNativeSource, captureNativeSource } from './lib/sdk-current-release.mjs';
import { linuxValidationInput } from './lib/sdk-linux-validation-input.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Run on Linux x64 (the pinned Docker image supports emulation)');
const args = process.argv.slice(2);
const offline = args.includes('--offline') ? ['--offline'] : [];
const output = resolve(root, 'artifacts/sdk/validation/linux-x64');
mkdirSync(output, { recursive: true });
const report = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, status: 'running', startedAt: new Date().toISOString(), checks: [] };
const save = () => writeFileSync(resolve(output, 'validation.json'), `${JSON.stringify(report, null, 2)}\n`);
function run(label, command, commandArgs, env = process.env) {
  console.log(label);
  const result = spawnSync(command, commandArgs, { cwd: root, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const log = `${String(report.checks.length + 1).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`;
  writeFileSync(resolve(output, log), `${result.stdout || ''}${result.stderr || ''}`);
  report.checks.push({ label, command, args: commandArgs, log, exitCode: result.status, signal: result.signal, error: result.error?.message });
  save();
  if (result.error || result.status !== 0) throw new Error(`${label} failed; see ${resolve(output, log)}`);
  return result.stdout;
}
let compositor;
let compositorExit;
let runtimeDirectory;
try {
  report.sourceBefore = captureNativeSource(root);
  assertCleanNativeSource(report.sourceBefore);
  report.sourceCommit = report.sourceBefore.sourceCommit;
  report.distribution = readFileSync('/etc/os-release', 'utf8');
  report.glibc = run('Runtime glibc', 'getconf', ['GNU_LIBC_VERSION']).trim();
  if (report.glibc !== 'glibc 2.35') throw new Error('Baseline builds must run against glibc 2.35');
  if (!args.includes('--skip-build')) {
    run('Build Linux native library', process.execPath, ['scripts/sdk-native-build.mjs', '--target', 'x86_64-unknown-linux-gnu', ...offline]);
  }
  // --skip-build still verifies the exact files and source/feature identity.
  // A backend-only Cargo graph cannot stand in for the produced GLES runtime.
  const input = linuxValidationInput(resolve(root, 'artifacts/sdk/native'), report.sourceBefore);
  report.native = input.native;
  report.nativeReceiptSha256 = input.receiptSha256;
  run('Native dependency licenses', process.execPath, ['scripts/sdk-licenses.mjs', '--target', input.native.target, '--features', input.features, ...offline]);
  if (!args.includes('--skip-contracts')) {
    run('Real engine and storage contracts', 'cargo', ['test', '-p', 'container-sdk', '-p', 'container-sdk-ffi', '--no-default-features', '--features', input.features, '--locked', ...offline]);
  }
  const library = 'artifacts/sdk/native/x86_64-unknown-linux-gnu/libweapp_container_sdk.so';
  const versions = run('ELF symbol versions', 'readelf', ['--version-info', library]);
  const required = [...new Set([...versions.matchAll(/GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g)].map(m => m[0]))];
  if (required.some(version => {
    const [major, minor, patch = 0] = version.slice(6).split('.').map(Number);
    return major > 2 || major === 2 && (minor > 35 || minor === 35 && patch > 0);
  })) throw new Error(`Library exceeds the glibc 2.35 baseline: ${required.join(', ')}`);
  report.requiredGlibcVersions = required;
  run('ELF dynamic dependencies', 'readelf', ['--dynamic', library]);
  const pack = resolve(root, 'artifacts/sdk/fixtures/acceptance-pack');
  report.packIntegrity = makeFixture(root, pack);
  run('Shared acceptance pack contract', 'python3', ['examples/sdk/shared/verify-fixture.py', library, pack, resolve(output, 'fixture-validation.json')]);
  run('Relocated standalone C consumer', process.execPath, ['scripts/sdk-c-consumer.mjs', '--target', 'x86_64-unknown-linux-gnu']);
  run('GTK X11 installed CMake consumer', 'xvfb-run', ['-a', 'env', 'GDK_BACKEND=x11', process.execPath, 'scripts/sdk-desktop-package.mjs', '--target', 'linux-x64', '--verify']);

  runtimeDirectory = mkdtempSync(resolve(tmpdir(), 'weapp-sdk-wayland-'));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory, WAYLAND_DISPLAY: 'weapp-sdk-wayland', GDK_BACKEND: 'wayland' };
  const log = openSync(resolve(output, 'weston.log'), 'w');
  try {
    compositor = spawn('weston', ['--backend=headless-backend.so', '--use-pixman', '--socket=weapp-sdk-wayland', '--idle-time=0', '--width=1024', '--height=768', '--no-config'], { env, stdio: ['ignore', log, log] });
    compositorExit = new Promise(resolveExit => {
      compositor.once('error', error => resolveExit({ error: error.message }));
      compositor.once('exit', (exitCode, signal) => resolveExit({ exitCode, signal }));
    });
  } finally { closeSync(log); }
  const socket = resolve(runtimeDirectory, env.WAYLAND_DISPLAY);
  const deadline = Date.now() + 15_000;
  while (!existsSync(socket) && Date.now() < deadline && compositor.exitCode === null && compositor.signalCode === null) {
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  if (!existsSync(socket) || !statSync(socket).isSocket()) throw new Error('Owned Wayland compositor did not become ready; see weston.log');
  run('GTK Wayland installed consumer', resolve(root, 'artifacts/sdk/desktop/.consumer-linux-x64/desktop_consumer'), [
    pack, resolve(output, 'wayland-result.txt'),
  ], env);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
} finally {
  if (compositor) {
    if (compositor.exitCode === null && compositor.signalCode === null) compositor.kill('SIGTERM');
    const stopped = await Promise.race([compositorExit, new Promise(resolveWait => setTimeout(() => resolveWait(null), 5_000))]);
    if (!stopped) {
      compositor.kill('SIGKILL');
      report.compositorCleanup = await compositorExit;
      report.status = 'failed'; report.cleanupError = 'Owned Weston compositor required SIGKILL'; process.exitCode = 1;
    } else report.compositorCleanup = stopped;
  }
  if (runtimeDirectory) rmSync(runtimeDirectory, { recursive: true, force: true });
  try {
    report.sourceAfter = captureNativeSource(root);
    if (report.status === 'passed') assertCleanNativeSource(report.sourceAfter, report.sourceBefore);
  } catch (error) {
    report.status = 'failed'; report.sourceError = error.message; process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ status: report.status, report: resolve(output, 'validation.json'), error: report.error }, null, 2));
