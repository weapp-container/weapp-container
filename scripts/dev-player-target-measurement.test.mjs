import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const fixture = resolve(root, 'examples/apps/player-correctness-app');
const ids = ['increment', 'save', 'custom', 'normal', 'back', 'tab', 'scroll', 'fault'].map(id => `p0-${id}`);

function harness() {
  let now = 0, nextTimer = 0;
  let geometry = { window: { windowWidth: 320, windowHeight: 385, pixelRatio: 1.5,
    screenWidth: 320, screenHeight: 533, statusBarHeight: 24, screenTop: 72,
    deviceOrientation: 'portrait' },
    capsule: { left: 224, right: 312, top: 32, bottom: 64, width: 88, height: 32 } };
  const timers = new Map(), intervals = new Map(), deferred = [], plan = [], owners = [];
  const app = { globalData: { runMarker: 'measurement-run', sequence: 0, instances: 0,
    retired: null, journal: { schemaVersion: 1, events: [], geometries: [] } } };
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    getApp: () => app,
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, at: now + delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { intervals.set(++nextTimer, callback); return nextTimer; },
    clearInterval(id) { intervals.delete(id); },
    wx: {
      getWindowInfo: () => structuredClone(geometry.window),
      getMenuButtonBoundingClientRect: () => structuredClone(geometry.capsule),
      getStorageSync: () => 0,
      createSelectorQuery() {
        let callback;
        return {
          in(page) { owners.push(page); return this; },
          selectAll(selector) { assert.equal(selector, '.p0-target'); return this; },
          boundingClientRect(value) { callback = value; return this; },
          exec() {
            const action = plan.shift() || { kind: 'ok' };
            const width = geometry.window.windowWidth;
            const rects = ids.map((id, index) => ({ id, left: index % 2 ? width / 2 : 12,
              top: 58 + Math.floor(index / 2) * 36, width: width * 0.48 - 24, height: 32 }));
            if (action.kind === 'throw') throw action.error;
            if (action.kind === 'reject') return { then(_ok, rejected) { rejected(action.error); } };
            if (action.kind === 'defer') deferred.push(() => callback(rects));
            else if (action.kind !== 'never') callback(action.rects || rects);
            if (action.kind === 'callback-then-reject') return { then(_ok, rejected) { rejected(action.error); } };
            return undefined; // Official exec need not return a Promise.
          },
        };
      },
    },
  });
  vm.runInContext(readFileSync(resolve(fixture, 'shared/page.js'), 'utf8')
    .replace('export function createPage', 'function createPage'), context);
  return {
    plan, owners, deferred, timers, intervals,
    page() {
      const page = context.createPage('home');
      page.setData = function(patch, callback) { Object.assign(this.data, structuredClone(patch)); callback?.call(this); };
      page.onLoad({});
      return page;
    },
    geometry: () => structuredClone(geometry),
    landscape() {
      geometry.window = { ...geometry.window, windowWidth: 533, windowHeight: 172,
        screenWidth: 533, screenHeight: 320, deviceOrientation: 'landscape' };
      geometry.capsule = { ...geometry.capsule, left: 437, right: 525 };
    },
    advance(ms) {
      const until = now + ms;
      let remaining = 1000;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(--remaining > 0, 'scheduler must remain bounded');
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = until;
    },
  };
}

test('onShow remeasures a hidden portrait page using its accepted landscape geometry', () => {
  const h = harness(), page = h.page(); page.onShow(); page.onReady();
  const first = structuredClone(page.data.targetGeometry);
  page.onHide(); assert.equal(page.data.targetGeometry, null);
  h.landscape(); page.onShow();
  assert.equal(page.data.targetGeometry.geometry.window.windowWidth, 533);
  assert.ok(page.data.targetGeometry.measurementSequence > first.measurementSequence);
  assert.deepEqual(page.data.targetGeometry.geometry, h.geometry());
  assert.ok(h.owners.every(owner => owner === page), 'every query uses official .in(this)');
});

test('old callbacks cannot publish across hide, unload, or a newer measurement token', () => {
  for (const mode of ['hide', 'unload', 'replacement', 'hide-and-show']) {
    const h = harness(), page = h.page(); h.plan.push({ kind: 'defer' }); page.onShow();
    if (mode === 'hide') page.onHide();
    else if (mode === 'hide-and-show') { page.onHide(); h.landscape(); page.onShow(); }
    else if (mode === 'unload') page.onUnload();
    else { h.landscape(); page.onResize({}); }
    const expected = structuredClone(page.data.targetGeometry);
    h.deferred[0]();
    assert.deepEqual(page.data.targetGeometry, expected, mode);
  }
});

test('official void exec and deferred callback remain supported without a Promise API', () => {
  const h = harness(), page = h.page(); h.plan.push({ kind: 'defer' }); page.onShow();
  assert.equal(page.data.targetGeometry, null);
  h.advance(16); h.deferred[0]();
  assert.equal(page.data.targetGeometry.instance, page.data.instance);
  assert.equal(page.data.targetError, null);
  assert.equal(h.timers.size, 0);
});

test('only typed presentation-not-ready retries after 16ms with a fixed short budget', () => {
  const h = harness(), page = h.page();
  h.plan.push({ kind: 'reject', error: { code: 'ERR_RENDER', message: 'selector query awaits presentation' } });
  page.onShow(); assert.equal(h.owners.length, 1); assert.equal(page.data.targetGeometry, null);
  h.advance(15); assert.equal(h.owners.length, 1);
  h.advance(1); assert.equal(h.owners.length, 2);
  assert.equal(page.data.targetError, null); assert.ok(page.data.targetGeometry);
});

test('unsupported, foreign render errors and untyped messages are recorded once without retry', () => {
  for (const error of [
    { code: 'ERR_UNSUPPORTED_CAPABILITY', message: 'unsupported selector' },
    { code: 'ERR_RENDER', message: 'corrupt frame' },
    { message: 'selector query awaits presentation' },
  ]) {
    const h = harness(), page = h.page(); h.plan.push({ kind: 'reject', error }); page.onShow();
    h.advance(1000);
    assert.equal(h.owners.length, 1);
    assert.equal(page.data.targetGeometry, null);
    assert.ok(page.data.targetError);
    assert.equal(page.data.events.map(JSON.parse).filter(event => event.event === 'targets.error').length, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('repeated presentation errors exhaust a finite attempt count and never spin', () => {
  const h = harness(), page = h.page();
  for (let i = 0; i < 100; i++) h.plan.push({ kind: 'reject', error: { code: 'ERR_RENDER', message: 'selector query awaits presentation' } });
  page.onShow(); h.advance(1000);
  assert.equal(h.owners.length, 8);
  assert.equal(page.data.targetGeometry, null);
  assert.equal(page.data.targetError.code, 'ERR_TARGET_MEASUREMENT_TIMEOUT');
  assert.equal(h.timers.size, 0);
});

test('absent callback expires instead of manufacturing a successful measurement', () => {
  const h = harness(), page = h.page(); h.plan.push({ kind: 'never' }); page.onShow();
  h.advance(249); assert.equal(page.data.targetError, null);
  h.advance(1); assert.equal(page.data.targetError.code, 'ERR_TARGET_MEASUREMENT_TIMEOUT');
  assert.equal(page.data.targetGeometry, null);
  assert.equal(h.owners.length, 1);
});

test('geometry changing before callback cannot relabel old rectangles as the new viewport', () => {
  const h = harness(), page = h.page(); h.plan.push({ kind: 'defer' }); page.onShow();
  h.landscape(); h.deferred[0]();
  assert.equal(page.data.targetGeometry, null);
  assert.equal(page.data.targetError.code, 'ERR_TARGET_GEOMETRY_CHANGED');
});

test('target metadata and timer values do not recursively cause another measurement', () => {
  const h = harness(), page = h.page(); page.onShow(); page.onReady();
  const geometry = structuredClone(page.data.targetGeometry), count = h.owners.length;
  for (const callback of h.intervals.values()) callback();
  page.increment({ detail: { x: 20, y: 30 } });
  assert.deepEqual(page.data.targetGeometry, geometry);
  assert.equal(h.owners.length, count);
});

test('invalid rectangle batches and synchronous errors are explicit failures, never retried', () => {
  for (const action of [{ kind: 'ok', rects: [] }, { kind: 'ok', rects: ids.map(id => ({ id, left: 1, top: 1, width: NaN, height: 32 })) },
    { kind: 'throw', error: { code: 'ERR_UNSUPPORTED_CAPABILITY', message: 'Selector unavailable' } }]) {
    const h = harness(), page = h.page(); h.plan.push(action); page.onShow(); h.advance(1000);
    assert.equal(h.owners.length, 1);
    assert.ok(page.data.targetError); assert.equal(page.data.targetGeometry, null);
  }
});

test('late Promise failure after a successful callback cannot erase its committed measurement', () => {
  const h = harness(), page = h.page();
  h.plan.push({ kind: 'callback-then-reject', error: { code: 'ERR_RENDER', message: 'selector query awaits presentation' } });
  page.onShow(); h.advance(1000);
  assert.ok(page.data.targetGeometry); assert.equal(page.data.targetError, null);
  assert.equal(h.owners.length, 1); assert.equal(h.timers.size, 0);
});

test('fixed control layout profile has explicit source constraints independent of changing text values', () => {
  const css = readFileSync(resolve(fixture, 'app.wxss'), 'utf8');
  // Intentional style changes must revisit the fixed-layout profile contract.
  const styles = readdirSync(fixture, { recursive: true }).filter(path => path.endsWith('.wxss')).sort();
  assert.deepEqual(styles, ['app.wxss', 'pages/custom/index.wxss']);
  assert.equal(createHash('sha256').update(css).digest('hex'), 'ce0727d3f29ff57d1424123a5ee6f7c5e33da68505b9b3db81e334cfe8f024dc');
  assert.equal(createHash('sha256').update(readFileSync(resolve(fixture, styles[1]))).digest('hex'), '2058f374751b67b798b70a087cb24a1175409c77a8a836890277b60307f18ac9');
  for (const name of ['heading', 'status']) assert.match(css, new RegExp(`\\.${name}\\s*\\{[^}]*height:\\s*24px`));
  assert.match(css, /\.p0-control\s*\{[^}]*width:\s*48%[^}]*height:\s*32px/);
  assert.match(css, /\.controls\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/);
  for (const name of ['home', 'custom', 'detail', 'settings', 'scroll']) {
    const wxml = readFileSync(resolve(fixture, `pages/${name}/index.wxml`), 'utf8');
    const controls = wxml.match(/<view class="controls">([\s\S]*?)<\/view>/)[1];
    assert.deepEqual([...controls.matchAll(/id="([^"]+)"/g)].map(value => value[1]), ids);
    assert.doesNotMatch(controls, /\{\{|wx:(?:if|for)/);
  }
});
