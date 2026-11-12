import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';
import { sanitizeInspectorSnapshot } from './device-dev-server.mjs';

const root = resolve(import.meta.dirname, '..');
const fixture = resolve(root, 'examples/apps/player-correctness-app');
function harness() {
  let nextTimer = 0;
  const timers = new Map();
  const timeouts = new Map();
  const app = { globalData: { runMarker: 'fixture-run', sequence: 0, instances: 0, retired: null, journal: { schemaVersion: 1, events: [], geometries: [] } } };
  let geometry;
  const storage = new Map();
  const context = vm.createContext({
    getApp: () => app,
    setInterval(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(callback) { timeouts.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timeouts.delete(id); },
    wx: {
      getWindowInfo: () => structuredClone(geometry.window),
      getMenuButtonBoundingClientRect: () => structuredClone(geometry.capsule),
      getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
      navigateTo() {}, navigateBack() {}, switchTab() {},
      createSelectorQuery() {
        let callback, page;
        return { in(value) { page = value; return this; }, selectAll() { return this; },
          boundingClientRect(value) { callback = value; return this; },
          exec() {
            const ids = ['increment', 'save', 'custom', 'normal', 'back', 'tab', 'scroll', 'fault'].map(id => 'p0-' + id);
            if (page.data.kind === 'scroll') ids.push('p0-scroll-region');
            callback(ids.map((id, index) => ({ id, left: index % 2 ? geometry.window.windowWidth / 2 : 12,
              top: 58 + Math.floor(index / 2) * 36, width: geometry.window.windowWidth * 0.48 - 24, height: 32 })));
          } };
      },
    },
  });
  vm.runInContext(readFileSync(resolve(fixture, 'shared/page.js'), 'utf8').replace('export function createPage', 'function createPage'), context);
  function measure(kind, orientation = 'portrait') {
    const portrait = orientation === 'portrait';
    geometry = {
      window: { windowWidth: portrait ? 393 : 851, windowHeight: portrait ? kind === 'custom' ? 800 : 700 : kind === 'custom' ? 350 : 290,
        screenWidth: portrait ? 393 : 851, screenHeight: portrait ? 851 : 393, screenTop: kind === 'custom' ? 24 : 68,
        statusBarHeight: 24, pixelRatio: 3, deviceOrientation: orientation,
        safeArea: { left: 0, top: 24, right: portrait ? 393 : 851, bottom: portrait ? 827 : 369, width: portrait ? 393 : 851, height: portrait ? 803 : 345 } },
      capsule: { left: portrait ? 300 : 758, top: 28, right: portrait ? 385 : 843, bottom: 60, width: 85, height: 32 },
    };
  }
  function page(kind) {
    const page = context.createPage(kind);
    page.setData = function(patch, callback) { Object.assign(this.data, structuredClone(patch)); if (callback) callback.call(this); };
    page.onLoad({ test: 'p0' }); page.onShow(); page.onReady();
    return page;
  }
  function inspect(...pages) {
    return sanitizeInspectorSnapshot({ pages: pages.map((page, index) => ({ id: index + 1, route: `pages/${page.data.kind}/index`, data: structuredClone(page.data) })) });
  }
  return { app, timers, measure, page, inspect, geometry: () => structuredClone(geometry) };
}

function backAndCheck(h, departing, home, orientation = 'landscape') {
  const sequence = h.app.globalData.sequence;
  const oldGeometry = h.geometry();
  departing.back(); departing.onUnload();
  h.measure('home', orientation); home.onShow();
  const destinationGeometry = h.geometry();
  const events = home.data.journal.events.map(value => JSON.parse(value)).filter(value => value[0] > sequence);
  const exited = events.filter(value => value[1] === departing.data.kind && value[2] === departing.data.instance);
  assert.deepEqual(exited.map(value => value[3]), ['navigateBack', 'onUnload']);
  const shown = events.filter(value => value[1] === 'home' && value[2] === home.data.instance && value[3] === 'onShow');
  assert.equal(shown.length, 1); assert.ok(shown[0][0] > exited[1][0]);
  assert.deepEqual(JSON.parse(home.data.journal.geometries[exited[1][4]]), oldGeometry);
  assert.deepEqual(JSON.parse(home.data.journal.geometries[shown[0][4]]), destinationGeometry);
  const retired = home.data.lastRetired;
  const unload = retired.events.map(value => JSON.parse(value)).filter(value => value.sequence > sequence && value.event === 'onUnload');
  assert.equal(retired.kind, departing.data.kind); assert.equal(unload.length, 1);
  assert.deepEqual(JSON.parse(retired.geometries[unload[0].geometry]), oldGeometry);
  assert.deepEqual(retired.first, departing.data.first);
}

test('correctness fixture preserves first/full lifecycle geometry and global callback history through ten rotations/navigation cycles', () => {
  const h = harness(); h.measure('home'); const home = h.page('home');
  const first = structuredClone(home.data.first);
  const firstGeometry = home.data.geometries[first.geometry];
  for (let round = 0; round < 10; round++) {
    home.increment({ detail: { x: 24, y: 64 } }); home.custom(); home.onHide();
    h.measure('custom'); const custom = h.page('custom');
    assert.deepEqual(JSON.parse(custom.data.geometries[custom.data.first.geometry]), h.geometry());
    h.inspect(home, custom);
    h.measure('custom', 'landscape'); custom.onResize({ size: { windowWidth: 851, windowHeight: 350 } });
    backAndCheck(h, custom, home);
    home.normal(); home.onHide(); h.measure('detail', 'landscape'); const detail = h.page('detail');
    h.inspect(home, detail);
    backAndCheck(h, detail, home);
    h.measure('home'); home.onResize({ size: { windowWidth: 393, windowHeight: 700 } });
    assert.deepEqual(home.data.first, first); assert.equal(home.data.geometries[first.geometry], firstGeometry);
    h.inspect(home);
  }
  assert.equal(home.data.count, 10);
  assert.equal(h.timers.size, 1, 'unloaded page intervals are released');
  const tuples = home.data.journal.events.map(value => JSON.parse(value));
  assert.ok(tuples.length > 200, 'journal retains all pages, not only latest geometry');
  assert.equal(tuples.filter(value => value[3] === 'onUnload').length, 20);
  assert.ok(tuples.every((value, index) => index === 0 || tuples[index - 1][0] < value[0]));
  assert.ok(Buffer.byteLength(JSON.stringify(h.inspect(home))) < 48 * 1024, 'real inspector budget is enforced by its actual sanitizer');
});

test('View fault is explicit, while fixture timers/storage remain AppService work', () => {
  const h = harness(); h.measure('home'); const home = h.page('home');
  assert.equal(home.data.triggerViewFault, false);
  home.increment({ detail: {} }); home.save();
  home.fault(); assert.equal(home.data.triggerViewFault, true);
  for (const callback of h.timers.values()) callback();
  assert.equal(home.data.ticks, 1);
  home.onHide(); home.onUnload();
  const next = h.page('home'); assert.equal(next.data.count, 0); assert.equal(next.data.stored, 1);
  assert.match(readFileSync(resolve(fixture, 'shared/probe.wxs'), 'utf8'), /if \(enabled\) \{ while \(true\)/);
});

test('Android harness dry description has no device dependency and rejects physical targets before execution', () => {
  const script = resolve(root, 'scripts/dev-player-p0-android.py');
  const described = spawnSync('python3', [script, '--describe'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(described.status, 0, described.stderr);
  assert.equal(JSON.parse(described.stdout).defaultCycles, 10);
  const refused = spawnSync('python3', [script, '--execute', '--serial', 'a-physical-device', '--avd', 'owned-test',
    '--device-id', 'test', '--admin', 'http://127.0.0.1:51791', '--out', '/must-not-be-created', '--apk-sha256', 'a'.repeat(64)],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /physical devices are refused/);
});

test('Android actual evidence validators reject stale presentation, self-normalized coordinates and unrelated faults', () => {
  const result = spawnSync('python3', [resolve(root, 'scripts/dev-player-p0-android.test.py')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 53 tests/);
});

test('Android native witness rejects ambiguous views, transforms, invalid bounds and stale R8 mappings', () => {
  const result = spawnSync('python3', [resolve(root, 'scripts/dev-player-p0-native-view.test.py')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 34 tests/);
});


test('Android navigateBack evidence binds unload/show to old/new geometry without synthetic hide', () => {
  const result = spawnSync('python3', [resolve(root, 'scripts/dev-player-p0-back-lifecycle.test.py')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 25 tests/);
});
