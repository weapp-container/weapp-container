#!/usr/bin/env node
// Headless development evidence only; no official WXS/device/GPU claim.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installSmokeSignals, startDevSimulator } from './simulator-dev-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (args.includes('--help')) {
  console.log('Usage: node scripts/modern-view-browser-smoke.mjs [--simulator-bin path] [--engine quickjs|v8] [--out report.json]');
  process.exit(0);
}
const engine = option('--engine', 'quickjs');
const binary = resolve(option('--simulator-bin', join(root, 'target/debug/weapp-simulator')));
const output = resolve(option('--out', join(root, `artifacts/modern-view-browser/${engine}.json`)));
const owned = await mkdtemp(join(tmpdir(), 'weapp-modern-browser-'));
const project = join(owned, 'project');
const signals = installSmokeSignals();
const cleanupErrors = [];
let simulator, browser, context, failure;
const report = {
  schemaVersion: 1, status: 'failed', kind: 'headless-development-browser', engine,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  generatedAt: new Date().toISOString(),
  workingTree: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim(),
  resources: { browserCreated: false, contextCreated: false, headless: true, pages: 0, port: 0, projectCopy: true },
  checks: {}, limitations: ['not official WXS or DevTools evidence', 'not GPU/device or performance acceptance'],
};
try {
  report.simulatorBinary = await readFile(binary).then(bytes => ({
    path: binary, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
  }));
  report.sourceHashes = Object.fromEntries(await Promise.all([
    'scripts/modern-view-browser-smoke.mjs', 'crates/container-runtime/src/view_execution.rs',
    'crates/container-runtime/src/modern_source_map.rs', 'crates/container-core/src/modern_view.js',
    'crates/container-engine-quickjs/src/view.rs', 'crates/container-engine-v8/src/view.rs',
    'crates/container-simulator/src/dev.rs', 'crates/container-simulator/src/web.rs', 'crates/container-simulator/src/web-ui.html',
    'tools/container-manifest/src/modern-view.ts',
  ].map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])));
  await cp(join(root, 'examples/apps/modern-view-app'), project, { recursive: true,
    filter: source => !['dist', '.weapp-vite', '.weapp-container', 'node_modules'].includes(basename(source)) });
  simulator = await startDevSimulator({ root, project, engine, port: 0, timeoutMs: 120_000,
    launcher: { command: binary, mode: 'simulator' }, signal: signals.signal,
    onOutput: (text, stderr) => (stderr ? process.stderr : process.stdout).write(text) });
  report.resources.port = Number(new URL(simulator.url).port);
  report.resources.url = simulator.url;
  report.resources.simulatorPid = simulator.child.pid;
  const initial = await simulator.waitForState(state => state.status === 'ready' && state.revision > 0, 'initial modern generation');
  assert.equal(initial.renderer, 'skia-raster', 'modern browser text evidence requires Skia CPU raster');
  const { chromium } = await import(pathToFileURL(join(root, 'vendor/weapp-vite/node_modules/playwright/index.mjs')).href);
  browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false });
  report.resources.browserCreated = true;
  report.environment.browser = { name: 'chromium', version: browser.version() };
  context = await browser.newContext();
  report.resources.contextCreated = true;
  const page = await context.newPage();
  report.resources.pages = 1;
  await page.goto(simulator.url, { waitUntil: 'domcontentloaded' });
  const ready = () => page.waitForFunction(() => document.querySelector('#status')?.textContent === 'ready'
    && getComputedStyle(document.querySelector('#overlay')).display === 'none', null, { timeout: 120_000 });
  await ready();
  const pixels = () => page.evaluate(() => {
    const canvas = document.querySelector('#screen');
    const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261, ink = 0;
    for (let index = 0; index < bytes.length; index++) {
      hash = Math.imul(hash ^ bytes[index], 16777619);
      if (index % 4 === 0 && bytes[index] < 120 && bytes[index + 1] < 120 && bytes[index + 2] < 120 && bytes[index + 3] > 0) ink++;
    }
    return { width: canvas.width, height: canvas.height, hash: hash >>> 0, ink };
  });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#screen');
    const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let index = 0; index < bytes.length; index += 4) {
      if (bytes[index] < 120 && bytes[index + 1] < 120 && bytes[index + 2] < 120 && bytes[index + 3] > 0) ink++;
    }
    return ink > 30;
  }, null, { timeout: 120_000 });
  const before = await pixels();
  assert.ok(before.width > 0 && before.height > 0 && before.ink > 30, 'first frame must contain rendered text');
  assert.equal(initial.engine, engine);
  report.checks.initial = { status: 'passed', revision: initial.revision, renderer: initial.renderer, pixels: before };
  const sourcePath = join(project, 'view/format.view.ts');
  const source = await readFile(sourcePath, 'utf8');
  const updated = source.replace('Standard JS: [].constructor === Array', 'Modern update verified');
  assert.notEqual(updated, source);
  await writeFile(sourcePath, updated);
  const reloaded = await simulator.waitForState(state => state.status === 'ready' && state.revision > initial.revision, 'modern-only reload');
  assert.notEqual(reloaded.sessionId, initial.sessionId, 'executable changes must restart the session');
  await ready();
  await page.waitForFunction(revision => document.querySelector('#meta')?.textContent?.includes(String(revision)), reloaded.revision, { timeout: 120_000 });
  let after = await pixels();
  if (after.hash === before.hash) {
    await page.waitForFunction(hash => {
      const canvas=document.querySelector('#screen'), bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      let value=2166136261; for (const byte of bytes) value=Math.imul(value^byte,16777619);
      return (value>>>0)!==hash;
    }, before.hash, { timeout: 120_000 });
    after = await pixels();
  }
  assert.notEqual(after.hash, before.hash);
  report.checks.modernOnlyReload = { status: 'passed', revision: reloaded.revision, pixels: after };
  // A valid program throwing at runtime must report its TS source location,
  // preserve the running session and retain the accepted canvas pixels.
  const throwing = updated.replace('return user?.profile?.name', "throw new Error('view-sourcemap-marker'); return user?.profile?.name");
  await writeFile(sourcePath, throwing);
  const diagnostic = await simulator.waitForState(state => state.diagnostics?.some(item => item.message.includes('view-sourcemap-marker')), 'mapped runtime error');
  assert.equal(diagnostic.sessionId, reloaded.sessionId);
  assert.match(JSON.stringify(diagnostic.diagnostics), /view\/format\.view\.ts:\d+:\d+/);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'error'
    && getComputedStyle(document.querySelector('#overlay')).display !== 'none', null, { timeout: 120_000 });
  assert.equal(await page.locator('#status').textContent(), 'error');
  assert.equal((await pixels()).hash, after.hash, 'rejected generation must preserve accepted pixels');
  const livenessRequestId = 'modern-failure-liveness';
  await page.locator('#bridge').fill(JSON.stringify({
    protocolVersion: '1.0', sessionId: reloaded.sessionId, requestId: livenessRequestId,
    kind: 'request', op: 'diagnostic', payload: {},
  }));
  await page.locator('#send').click();
  await page.waitForFunction(requestId => {
    try {
      const result = JSON.parse(document.querySelector('#bridgeResult').textContent);
      return result.messages?.some(message => message.requestId === requestId && message.payload?.ok === true);
    } catch { return false; }
  }, livenessRequestId, { timeout: 120_000 });
  assert.equal(await page.locator('#status').textContent(), 'error', 'a live bridge must not clear the active runtime error');
  assert.equal((await pixels()).hash, after.hash, 'bridge dispatch must retain the accepted frame');
  report.checks.runtimeFailureAndMap = {
    status: 'passed', surfaceStatus: 'error', bridgeResponsive: true, diagnostics: diagnostic.diagnostics,
  };
  await mkdir(dirname(output), { recursive: true });
  await page.screenshot({ path: output.replace(/\.json$/, '') + '-overlay.png', fullPage: true });
  await writeFile(sourcePath, source);
  await simulator.waitForState(state => state.status === 'ready' && state.revision > reloaded.revision, 'recovery');
  await ready();
  assert.equal(await page.locator('#status').textContent(), 'ready');
  await page.waitForFunction(hash => {
    const canvas = document.querySelector('#screen'), bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let value = 2166136261;
    for (const byte of bytes) value = Math.imul(value ^ byte, 16777619);
    return (value >>> 0) === hash;
  }, before.hash, { timeout: 120_000 });
  await page.screenshot({ path: output.replace(/\.json$/, '') + '.png', fullPage: true });
  report.checks.recovery = { status: 'passed', surfaceStatus: 'ready', pixels: await pixels() };
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.error = { message: error.message, stack: error.stack };
} finally {
  const closed = {};
  for (const [name, close] of [
    ['context', () => context?.close()], ['browser', () => browser?.close()],
    ['simulator', () => simulator?.stop()], ['project', () => rm(owned, { recursive: true, force: true })],
  ]) { try { closed[name] = await close() ?? true; } catch (error) { cleanupErrors.push({ name, message: error.message }); } }
  if (browser?.isConnected()) cleanupErrors.push({ name: 'browser', message: 'owned browser remains connected after close' });
  signals.dispose();
  report.cleanup = { status: cleanupErrors.length ? 'failed' : 'passed', resources: closed, errors: cleanupErrors };
  if (cleanupErrors.length) report.status = 'failed';
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, report: output, checks: Object.keys(report.checks), cleanup: report.cleanup }));
if (failure) throw failure;
if (cleanupErrors.length) throw new Error(`modern browser cleanup failed: ${JSON.stringify(cleanupErrors)}`);
