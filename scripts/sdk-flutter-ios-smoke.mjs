#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProject } from '../examples/sdk/flutter/ios-ui/make-project.mjs';
import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); if (index < 0) return fallback; if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error(`${name} requires a value`); return args[index + 1]; }
const application = option('--app'), device = option('--device');
const hostLifecycle = args.includes('--host-lifecycle');
const hotRestart = args.includes('--hot-restart');
if (hotRestart && hostLifecycle) throw Error('--hot-restart uses the public controller consumer');
const reportName = hostLifecycle ? 'sdk-flutter-host-lifecycle.json' : 'sdk-flutter-report.json';
if (!application || !device) throw Error('--app ABSOLUTE_RUNNER_APP --device BOOTED_SIMULATOR_ID are required');
const id = randomBytes(5).toString('hex');
const output = resolve(option('--out', resolve(root, 'artifacts/sdk/flutter/ios-validation', id)));
const workspace = resolve(output, 'ui-runner'); mkdirSync(workspace, { recursive: true });
const testBundle = `org.weappcontainer.fluttervalidation.${id}.tests`;
const receipt = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, flutterVersion: '3.47.7', status: 'running', scope: hostLifecycle ? 'host-lifecycle' : 'public-controller', startedAt: new Date().toISOString(), checks: [], resources: [{ kind: 'simulator', id: device, created: false }], cleanup: [] };
const save = () => writeFileSync(resolve(output, 'validation.json'), JSON.stringify(receipt, null, 2) + '\n');
function applicationFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return applicationFiles(path);
    const file = relative(resolve(application), path);
    if (entry.isSymbolicLink()) return [{ file, symlink: readlinkSync(path) }];
    if (!entry.isFile()) throw Error(`Unexpected application bundle entry: ${path}`);
    const bytes = readFileSync(path);
    return [{ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
  });
}
let active, interrupted = false, installed = false, bundle;
let machine, machineExit, machineError;
const machineEvents = [], machineLog = [];
async function untilValue(read, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (interrupted) throw Error('Interrupted');
    if (machineError) throw machineError;
    const value = await read(); if (value) return value;
    await new Promise(done => setTimeout(done, 150));
  }
  throw Error('Flutter hot restart operation timed out');
}
async function machineRequest(id, method, params) {
  const value = { id, method, params }; machineLog.push(`SEND ${JSON.stringify(value)}`);
  machine.stdin.write(`${JSON.stringify([value])}\n`);
  return untilValue(() => machineEvents.find(value => value.id === id));
}
async function closeMachine() {
  if (!machine) return;
  if (machine.exitCode === null && machine.signalCode === null) {
    machine.stdin.end();
    const exited = await Promise.race([machineExit, new Promise(done => setTimeout(() => done(false), 10000))]);
    if (!exited) { machine.kill('SIGTERM'); await machineExit; }
  }
  receipt.cleanup.push({ resource: 'flutter-attach-machine', status: 'exited', pid: machine.pid, exitCode: machine.exitCode, signalCode: machine.signalCode });
  writeFileSync(resolve(output, 'flutter-machine.log'), machineLog.join('\n') + '\n');
  writeFileSync(resolve(output, 'flutter-machine-events.json'), JSON.stringify(machineEvents, null, 2) + '\n');
  machine = undefined;
}
async function performHotRestart() {
  const consumer = resolve(option('--consumer', resolve(application, '../../../..')));
  if (!existsSync(resolve(consumer, 'pubspec.yaml'))) throw Error('--hot-restart requires --consumer pointing to the matching Dart consumer sources');
  const launch = await run('xcrun', ['simctl', 'launch', device, bundle], 'hot-restart-launch');
  const processId = launch.text.match(/:\s*(\d+)\s*$/m)?.[1];
  if (!processId) throw Error('simctl did not return the installed consumer PID');
  const container = (await run('xcrun', ['simctl', 'get_app_container', device, bundle, 'data'], 'hot-restart-container')).text.trim();
  const report = resolve(container, 'Library/Application Support', reportName);
  const ready = () => {
    if (!existsSync(report)) return undefined;
    let value; try { value = JSON.parse(readFileSync(report, 'utf8')); } catch { return undefined; }
    if (value.status === 'failed') throw Error(value.error || 'Consumer failed before hot restart');
    return value.stage === 'ready-for-input' && value.geometry ? value : undefined;
  };
  const before = await untilValue(ready);
  writeFileSync(resolve(output, 'before-hot-restart.json'), JSON.stringify(before, null, 2) + '\n');
  await run('xcrun', ['simctl', 'io', device, 'screenshot', resolve(output, 'before-hot-restart.png')], 'hot-restart-screenshot');
  const flutter = option('--flutter', process.env.FLUTTER || 'flutter');
  const argv = ['attach', '-d', device, '--machine', '--no-dds', '--no-devtools', '--app-id', bundle];
  machineLog.push(`COMMAND ${JSON.stringify([flutter, ...argv])}`);
  machine = spawn(flutter, argv, { cwd: consumer, stdio: ['pipe', 'pipe', 'pipe'] });
  machineExit = new Promise(done => { machine.once('exit', (code, signal) => done({ code, signal })); machine.once('error', error => { machineError = error; done({ error: error.message }); }); });
  for (const stream of [machine.stdout, machine.stderr]) createInterface({ input: stream }).on('line', line => {
    machineLog.push(line);
    try { const value = JSON.parse(line); if (Array.isArray(value)) machineEvents.push(...value); } catch {}
  });
  const start = await untilValue(() => machineEvents.find(value => value.event === 'app.start'));
  await untilValue(() => machineEvents.find(value => value.event === 'app.started'));
  const debug = await untilValue(() => machineEvents.find(value => value.event === 'app.debugPort'));
  const url = new URL(debug.params.wsUri); url.protocol = 'http:'; url.pathname = url.pathname.replace(/\/ws$/, '/getVM');
  const vm = async () => { const response = await fetch(url, { signal: AbortSignal.timeout(10000) }); if (!response.ok) throw Error(`VM HTTP ${response.status}`); return (await response.json()).result; };
  const beforeVm = await vm(), beforeIsolate = beforeVm.isolates.find(value => !value.isSystemIsolate && value.name === 'main')?.id;
  if (!beforeIsolate || String(beforeVm.pid) !== processId) throw Error('VM service does not describe the launched iOS process');
  rmSync(report);
  const restart = await machineRequest(1, 'app.restart', { appId: start.params.appId, fullRestart: true, pause: false });
  if (restart.error || restart.result?.code !== 0) throw Error(`Actual tool hot restart failed: ${JSON.stringify(restart)}`);
  const after = await untilValue(ready), afterVm = await vm();
  const afterIsolate = afterVm.isolates.find(value => !value.isSystemIsolate && value.name === 'main')?.id;
  if (!afterIsolate || afterIsolate === beforeIsolate || String(afterVm.pid) !== processId) throw Error('Hot restart must replace the Dart main isolate in the same iOS process');
  writeFileSync(resolve(output, 'after-hot-restart.json'), JSON.stringify(after, null, 2) + '\n');
  receipt.hotRestart = { status: 'passed', processId, beforeIsolate, afterIsolate, response: restart, beforeStage: before.stage, afterStage: after.stage, beforeChecks: before.checks, afterChecks: after.checks };
  const detach = await machineRequest(2, 'app.detach', { appId: start.params.appId });
  if (detach.error || detach.result !== true) throw Error(`Flutter detach failed: ${JSON.stringify(detach)}`);
  receipt.hotRestart.detach = detach;
  await closeMachine(); save();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; active?.kill('SIGTERM'); });
async function run(command, argv, name, allowFailure = false) {
  if (interrupted && !allowFailure) throw Error('Interrupted');
  const log = createWriteStream(resolve(output, `${name}.log`));
  let text = '';
  const child = spawn(command, argv, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] }); active = child;
  child.stdout.on('data', data => { text += data; log.write(data); });
  child.stderr.on('data', data => { text += data; log.write(data); });
  const timeout = setTimeout(() => child.kill('SIGTERM'), name === 'ui-test' ? 240_000 : 120_000);
  let status;
  try { status = await new Promise((done, reject) => { child.once('error', reject); child.once('close', code => done(code ?? 1)); }); }
  finally { clearTimeout(timeout); active = undefined; log.end(); }
  if (status !== 0 && !allowFailure) throw Error(`${name} failed (${status}): ${text.slice(-5000)}`);
  return { status, text };
}
try {
  const info = JSON.parse((await run('plutil', ['-convert', 'json', '-o', '-', resolve(application, 'Info.plist')], 'application-info')).text);
  bundle = info.CFBundleIdentifier;
  if (typeof bundle !== 'string' || !bundle.startsWith('dev.weapp.')) throw Error('Expected a dedicated dev.weapp SDK consumer application');
  const devices = JSON.parse((await run('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], 'simulators')).text);
  if (!Object.values(devices.devices).flat().some(value => value.udid === device && value.state === 'Booted' && value.isAvailable)) throw Error('Requested simulator is not booted and available');
  const probe = await run('xcrun', ['simctl', 'get_app_container', device, bundle, 'app'], 'existing-application', true);
  if (probe.status === 0) throw Error(`Refusing to overwrite an existing application: ${bundle}`);
  receipt.bundle = bundle;
  const files = applicationFiles(resolve(application));
  writeFileSync(resolve(output, 'application-files.json'), JSON.stringify(files, null, 2) + '\n');
  receipt.applicationBundleSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  receipt.applicationFiles = 'application-files.json';
  receipt.applicationExecutableSha256 = createHash('sha256').update(readFileSync(resolve(application, info.CFBundleExecutable))).digest('hex');
  const framework = resolve(application, 'Frameworks/Flutter.framework/Flutter');
  if (existsSync(framework)) receipt.flutterEngineSha256 = createHash('sha256').update(readFileSync(framework)).digest('hex');
  const source = readFileSync(resolve(root, 'examples/sdk/flutter/ios-ui', hostLifecycle ? 'HostLifecycleUITests.swift' : 'ConsumerUITests.swift'), 'utf8').replaceAll('__SDK_BUNDLE_ID__', bundle).replaceAll('__SDK_ACTIVATE_EXISTING__', hotRestart ? 'true' : 'false');
  writeFileSync(resolve(workspace, 'ConsumerUITests.swift'), source);
  const project = makeProject(workspace, testBundle);
  await run('xcrun', ['simctl', 'install', device, resolve(application)], 'install'); installed = true;
  receipt.resources.push({ kind: 'application', id: bundle, created: true }, { kind: 'test-runner', id: `${testBundle}.xctrunner`, created: true }); save();
  if (hotRestart) await performHotRestart();
  await run('xcodebuild', ['-project', project, '-scheme', 'FlutterSDKTests', '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-destination', `platform=iOS Simulator,id=${device}`, 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES', '-derivedDataPath', resolve(output, 'derived'), '-parallel-testing-enabled', 'NO', '-collect-test-diagnostics', 'never', '-enablePerformanceTestsDiagnostics', 'NO', '-resultBundlePath', resolve(output, 'Consumer.xcresult'), 'test'], 'ui-test');
  const tests = JSON.parse((await run('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', resolve(output, 'Consumer.xcresult')], 'test-summary')).text);
  if (tests.passedTests !== 1 || tests.failedTests !== 0 || tests.skippedTests !== 0) throw Error('Exactly one Flutter XCTest must execute without failures or skips');
  receipt.executedTests = { passed: tests.passedTests, failed: tests.failedTests, skipped: tests.skippedTests };
  const container = (await run('xcrun', ['simctl', 'get_app_container', device, bundle, 'data'], 'application-container')).text.trim();
  const path = resolve(container, 'Library/Application Support', reportName);
  cpSync(path, resolve(output, 'consumer-result.json'));
  const result = JSON.parse(readFileSync(path));
  if (hostLifecycle) {
    if (result.status !== 'passed' || result.stage !== 'complete' || result.checks?.length !== 8 || result.issues?.length !== 0 || result.closed !== true || result.platformViewCount !== 0) throw Error('Flutter host navigation/parent scrolling contract failed');
    receipt.checks.push({ name: 'flutter-ios-host-lifecycle', status: 'passed', evidence: 'real-XCTest-parent-and-embedded-scroll-Navigator-push-pop-and-close', result: 'consumer-result.json' });
  } else {
    if (result.status !== 'passed' || result.stage !== 'complete' || result.checks?.length < 10 || !(result.scrollTop > 0) || !result.timer) throw Error('Flutter consumer did not satisfy the acceptance contract');
    receipt.checks.push({ name: 'flutter-ios-installed-consumer', status: 'passed', evidence: 'real-XCTest-tap-scroll-native-UiKitView-and-public-controller', result: 'consumer-result.json' });
  }
  receipt.status = 'passed';
} catch (error) { receipt.status = 'failed'; receipt.error = error.message; process.exitCode = 1; console.error(error.message); }
finally {
  try { await closeMachine(); } catch (error) { receipt.status = 'failed'; receipt.cleanupError = `Flutter attach cleanup failed: ${error.message}`; process.exitCode = 1; }
  if (installed && !existsSync(resolve(output, 'consumer-result.json'))) {
    const data = await run('xcrun', ['simctl', 'get_app_container', device, bundle, 'data'], 'failure-application-container', true);
    if (data.status === 0) {
      const report = resolve(data.text.trim(), 'Library/Application Support', reportName);
      if (existsSync(report)) cpSync(report, resolve(output, 'consumer-result.json'));
    }
  }
  if (existsSync(resolve(output, 'Consumer.xcresult'))) {
    const exported = await run('xcrun', ['xcresulttool', 'export', 'attachments', '--path', resolve(output, 'Consumer.xcresult'), '--output-path', resolve(output, 'screenshots')], 'export-attachments', true);
    receipt.attachmentExport = exported.status === 0 ? 'screenshots' : 'failed';
  }
  if (installed) for (const app of [`${testBundle}.xctrunner`, bundle]) {
    const present = await run('xcrun', ['simctl', 'get_app_container', device, app, 'app'], `cleanup-probe-${app}`, true);
    if (present.status !== 0) { receipt.cleanup.push({ application: app, status: 'not-installed' }); continue; }
    await run('xcrun', ['simctl', 'terminate', device, app], `cleanup-terminate-${app}`, true);
    const remove = await run('xcrun', ['simctl', 'uninstall', device, app], `cleanup-remove-${app}`, true);
    const probe = await run('xcrun', ['simctl', 'get_app_container', device, app, 'app'], `cleanup-verify-${app}`, true);
    const removed = remove.status === 0 && probe.status !== 0;
    receipt.cleanup.push({ application: app, status: removed ? 'removed-and-verified' : 'failed' });
    if (!removed) { receipt.status = 'failed'; receipt.cleanupError = `Unable to remove owned application ${app}`; process.exitCode = 1; }
  }
  receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ status: receipt.status, receipt: resolve(output, 'validation.json'), error: receipt.error }, null, 2));
