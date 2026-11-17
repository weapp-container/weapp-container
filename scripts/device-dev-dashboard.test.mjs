import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('./lib/device-dev/dashboard.html', import.meta.url), 'utf8');
// Execute the shipped inline script against a small DOM/HTTP boundary. Only
// its automatic bootstrap is omitted so tests own the refresh lifecycle.
const source = html.match(/<script>([\s\S]*)<\/script>/)[1]
  .replace('__ADMIN_SECRET__', '"test-owner-secret"').replace(/refresh\(\);\s*$/, '');
function dashboard(handler) {
  const elements = new Map();
  const element = () => ({ textContent: '', value: '', children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; } });
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const context = vm.createContext({
    document: { getElementById: get, createElement: element },
    fetch: async (path, options) => {
      const value = await handler(path, options);
      return { ok: true, json: async () => value };
    },
    setTimeout: (callback, delay) => { if (delay === 200) queueMicrotask(callback); return 0; },
  });
  vm.runInContext(source, context);
  return { get, run: code => vm.runInContext(code, context) };
}
const devices = [
  { id: 'a', name: 'A', platform: 'macos', connected: true, phase: 'started' },
  { id: 'b', name: 'B', platform: 'android', connected: true, phase: 'started' },
];
const state = list => ({ devices: list, history: [], endpoint: 'https://device.test', project: null });
const receipt = id => ({ requestId: id.repeat(32), deviceId: id, projectId: 'project', runId: 'run', generation: '1', status: 'pending' });
const completed = id => ({ ...receipt(id), status: 'completed', snapshot: { pages: [{ id: 1, route: 'home', data: { device: id } }] } });

test('dashboard revalidates a completed snapshot and clears it when reload makes it stale', async () => {
  let result = completed('a'), reads = 0;
  const page = dashboard((path) => {
    if (path === '/state') return state(devices);
    if (path === '/inspect') return receipt('a');
    if (path.startsWith('/inspections/')) { reads++; return result; }
    throw Error('unexpected request');
  });
  await page.run('inspectDevice("a")');
  assert.match(page.get('inspection').textContent, /"device": "a"/);
  result = { ...receipt('a'), status: 'error', error: 'ERR_DEV_STALE_INSPECTION' };
  await page.run('refresh()');
  assert.equal(reads, 2, 'ordinary dashboard refresh checks the completed request again');
  assert.equal(page.get('inspection').textContent, '');
  assert.match(page.get('inspection-status').textContent, /ERR_DEV_STALE_INSPECTION/);
});

test('dashboard disconnect clears completed page data before another snapshot response', async () => {
  let online = true, reads = 0;
  const page = dashboard(path => {
    if (path === '/state') return state(devices.map(d => ({ ...d, connected: online })));
    if (path === '/inspect') return receipt('a');
    if (path.startsWith('/inspections/')) { reads++; return completed('a'); }
    throw Error('unexpected request');
  });
  await page.run('inspectDevice("a")');
  online = false;
  await page.run('refresh()');
  assert.equal(reads, 1);
  assert.equal(page.get('inspection').textContent, '');
  assert.match(page.get('inspection-status').textContent, /ERR_DEV_DISCONNECTED/);
});

test('late validation of an older selected device cannot clear or replace a newer selection', async () => {
  let readsA = 0, finishOldRead, signalOldRead;
  const oldReadStarted = new Promise(resolve => { signalOldRead = resolve; });
  const oldRead = new Promise(resolve => { finishOldRead = resolve; });
  const page = dashboard((path, options) => {
    if (path === '/state') return state(devices);
    if (path === '/inspect') return receipt(JSON.parse(options.body).deviceId);
    if (path.endsWith('a'.repeat(32))) {
      if (++readsA === 2) { signalOldRead(); return oldRead; }
      return completed('a');
    }
    if (path.endsWith('b'.repeat(32))) return completed('b');
    throw Error('unexpected request');
  });
  await page.run('inspectDevice("a")');
  const refreshingOld = page.run('refresh()');
  await oldReadStarted;
  await page.run('inspectDevice("b")');
  finishOldRead({ ...receipt('a'), status: 'error', error: 'ERR_DEV_STALE_INSPECTION' });
  await refreshingOld;
  assert.match(page.get('inspection').textContent, /"device": "b"/);
  assert.match(page.get('inspection-status').textContent, /设备 b/);
});
