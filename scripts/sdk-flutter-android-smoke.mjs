#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const serial = option('--serial');
if (!serial || serial.startsWith('--')) throw new Error('--serial must identify an existing device');
const artifacts = resolve(option('--artifacts', join(root, 'artifacts/sdk/flutter')));
const out = resolve(option('--out', join(artifacts, 'android-device'))); mkdirSync(out, { recursive: true });
const sdk = process.env.ANDROID_HOME || join(os.homedir(), 'Library/Android/sdk');
const adb = process.env.ADB || join(sdk, 'platform-tools/adb');
const apk = resolve(option('--apk', join(artifacts, 'consumer/build/app/outputs/flutter-apk/app-debug.apk')));
const name = 'dev.weapp.weapp_sdk_consumer';
const log = []; let installed = false;
let machine; const machineEvents = [], machineLog = [], ownedForwards = [];
let machineExit;
const uiDump = '/sdcard/weapp-flutter-hot-restart.xml';
function command(argv, optional = false) {
  const result = spawnSync(adb, ['-s', serial, ...argv], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  log.push({ argv, status: result.status, stdout: result.stdout, stderr: result.stderr });
  if (!optional && (result.error || result.status !== 0)) throw new Error(`adb failed: ${result.error?.message || result.stderr}`);
  return result;
}
function report() {
  const value = command(['shell', 'run-as', name, 'cat', 'files/sdk-flutter-report.json'], true);
  if (value.status !== 0) return undefined;
  try { return JSON.parse(value.stdout); } catch { return undefined; }
}
async function waitFor(predicate) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    const value = report();
    if (value?.status === 'failed') throw new Error(`Flutter acceptance failed: ${value.error}`);
    if (value && predicate(value)) return value;
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('Flutter acceptance timed out');
}
async function untilValue(read, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read(); if (value) return value;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('Flutter machine operation timed out');
}
function machineRequest(id, method, params) {
  const message = { id, method, params };
  machineLog.push(`SEND ${JSON.stringify(message)}`);
  machine.stdin.write(`${JSON.stringify([message])}\n`);
  return untilValue(() => machineEvents.find(value => value.id === id));
}
function forwards() { return command(['forward', '--list']).stdout.trim().split('\n').filter(Boolean); }
async function hotRestart(ready) {
  const beforeForwards = new Set(forwards());
  const flutter = option('--flutter', process.env.FLUTTER || 'flutter');
  const argv = ['attach', '-d', serial, '--machine', '--no-dds', '--no-devtools', '--app-id', name];
  machineLog.push(`COMMAND ${JSON.stringify([flutter, ...argv])}`);
  machine = spawn(flutter, argv, { cwd: join(artifacts, 'consumer'), stdio: ['pipe', 'pipe', 'pipe'] });
  machineExit = new Promise(resolveExit => machine.once('exit', (code, signal) => resolveExit({ code, signal })));
  for (const stream of [machine.stdout, machine.stderr]) createInterface({ input: stream }).on('line', line => {
    machineLog.push(line);
    try { const values = JSON.parse(line); if (Array.isArray(values)) machineEvents.push(...values); } catch {}
  });
  const start = await untilValue(() => machineEvents.find(value => value.event === 'app.start'));
  await untilValue(() => machineEvents.find(value => value.event === 'app.started'));
  ownedForwards.push(...forwards().filter(value => !beforeForwards.has(value)));
  const debug = await untilValue(() => machineEvents.find(value => value.event === 'app.debugPort'));
  const vmUrl = new URL(debug.params.wsUri); vmUrl.protocol = 'http:'; vmUrl.pathname = vmUrl.pathname.replace(/\/ws$/, '/getVM');
  const isolate = async () => {
    const response = await fetch(vmUrl); if (!response.ok) throw new Error(`VM service HTTP ${response.status}`);
    const value = await response.json(); return value.result.isolates.find(entry => !entry.isSystemIsolate && entry.name === 'main').id;
  };
  const beforeIsolate = await isolate(), beforePid = command(['shell', 'pidof', name]).stdout.trim();
  const g = ready.geometry;
  const point = (x, y) => [Math.round((g.viewOrigin.x + x * g.viewSize.width / g.windowWidth) * g.pixelRatio), Math.round((g.viewOrigin.y + y * g.viewSize.height / g.windowHeight) * g.pixelRatio)];
  command(['shell', 'input', 'tap', ...point(g.tap.x, g.tap.y).map(String)]);
  const before = await untilValue(() => {
    command(['shell', 'uiautomator', 'dump', uiDump]);
    const xml = command(['shell', 'cat', uiDump]).stdout;
    writeFileSync(join(out, 'before-hot-restart.xml'), xml);
    for (const match of xml.matchAll(/content-desc=(["'])(.*?)\1/g)) {
      try {
        const value = JSON.parse(match[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
        if (value.stage === 'ready-for-input' && value.tapCount === 1) return value;
      } catch {}
    }
  });
  // A newly written ready report must come from the restarted Dart program.
  command(['shell', 'run-as', name, 'rm', 'files/sdk-flutter-report.json']);
  const response = await machineRequest(1, 'app.restart', { appId: start.params.appId, fullRestart: true, pause: false });
  if (response.error || response.result?.code !== 0) throw new Error(`Actual hot restart failed: ${JSON.stringify(response)}`);
  const restarted = await waitFor(value => value.stage === 'ready-for-input');
  const afterIsolate = await isolate(), afterPid = command(['shell', 'pidof', name]).stdout.trim();
  if (beforeIsolate === afterIsolate || beforePid !== afterPid) throw new Error('Hot restart must replace the Dart isolate inside the same Android process');
  result.hotRestart = { status: 'passed', beforeIsolate, afterIsolate, processId: beforePid, beforeTapCount: before.tapCount, response };
  return restarted;
}
let result = { schemaVersion: 1, status: 'failed', serial, cleanupErrors: [] };
try {
  if (!existsSync(apk)) throw new Error(`Missing APK: ${apk}`);
  if (command(['get-state']).stdout.trim() !== 'device') throw new Error('Device is not online');
  if (command(['shell', 'pm', 'path', name], true).stdout.trim()) throw new Error(`Refusing to overwrite existing ${name}`);
  command(['install', '-t', apk]); installed = true;
  result.abi = command(['shell', 'getprop', 'ro.product.cpu.abi']).stdout.trim();
  result.api = Number(command(['shell', 'getprop', 'ro.build.version.sdk']).stdout.trim());
  command(['shell', 'am', 'start', '-W', '-n', `${name}/.MainActivity`]);
  let ready = await waitFor(value => value.stage === 'ready-for-input');
  if (args.includes('--hot-restart')) ready = await hotRestart(ready);
  const geometry = ready.geometry;
  const { viewOrigin, viewSize, pixelRatio, windowWidth, windowHeight } = geometry;
  if (!viewOrigin || !viewSize || !(pixelRatio > 0 && windowWidth > 0 && windowHeight > 0)) throw new Error('Missing measured input geometry');
  const point = (x, y) => [Math.round((viewOrigin.x + x * viewSize.width / windowWidth) * pixelRatio), Math.round((viewOrigin.y + y * viewSize.height / windowHeight) * pixelRatio)];
  const screen = spawnSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 32 * 1024 * 1024, timeout: 10000 });
  if (screen.status !== 0) throw new Error('Screenshot capture failed');
  writeFileSync(join(out, 'first-frame.png'), screen.stdout);
  command(['shell', 'input', 'tap', ...point(geometry.tap.x, geometry.tap.y).map(String)]);
  const scroll = geometry.scroll;
  command(['shell', 'input', 'swipe', ...point(scroll.left + scroll.width / 2, scroll.top + scroll.height * .8).map(String), ...point(scroll.left + scroll.width / 2, scroll.top + scroll.height * .2).map(String), '300']);
  const final = await waitFor(value => value.stage === 'complete');
  if (result.hotRestart && final.tapCount !== 2) throw new Error(`Hot restart did not restore the tap storage value: ${final.tapCount}`);
  if (result.hotRestart) result.hotRestart.restoredTapCount = final.tapCount;
  result = { ...result, ...final, apk, apkSha256: createHash('sha256').update(readFileSync(apk)).digest('hex'), targetKind: serial.startsWith('emulator-') ? 'emulator' : 'physical-device' };
} catch (error) { result.error = error.stack; process.exitCode = 1; }
finally {
  if (machine) {
    try {
      const start = machineEvents.find(value => value.event === 'app.start');
      if (machine.exitCode === null && start) await machineRequest(2, 'app.stop', { appId: start.params.appId });
      if (machine.exitCode === null) {
        const finished = await Promise.race([machineExit, new Promise(resolveWait => setTimeout(() => resolveWait(false), 10000))]);
        if (!finished) { machine.kill('SIGTERM'); await machineExit; }
      }
      for (const forward of ownedForwards) if (forwards().includes(forward)) command(['forward', '--remove', forward.split(/\s+/)[1]]);
      if (ownedForwards.some(value => forwards().includes(value))) throw new Error('Owned Flutter VM forward remains');
      command(['shell', 'rm', '-f', uiDump]);
    } catch (error) { result.cleanupErrors.push(error.message); result.status = 'failed'; process.exitCode = 1; }
    writeFileSync(join(out, 'flutter-machine.log'), machineLog.join('\n') + '\n');
    writeFileSync(join(out, 'flutter-machine-events.json'), JSON.stringify(machineEvents, null, 2) + '\n');
  }
  if (installed) {
    try {
      command(['shell', 'am', 'force-stop', name]); command(['uninstall', name]);
      if (command(['shell', 'pm', 'path', name], true).stdout.trim()) throw new Error('Owned package remains installed');
    } catch (error) { result.cleanupErrors.push(error.message); result.status = 'failed'; process.exitCode = 1; }
  }
  writeFileSync(join(out, 'commands.json'), JSON.stringify(log, null, 2) + '\n');
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
