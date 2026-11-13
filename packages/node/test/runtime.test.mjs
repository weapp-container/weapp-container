import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createContainer } from '@weapp-container/node';
import { packArtifact, disposeArtifact } from '@weapp-container/node/artifact';

let artifact;
before(async () => { artifact = await packArtifact({ projectPath: new URL('./fixture/', import.meta.url).pathname }); });
after(async () => { if (artifact) await disposeArtifact(artifact); });
async function launch(t, options = {}) {
  const container = await createContainer({ pack: artifact.packPath, artifact, ...options });
  t.after(() => container.dispose());
  return container;
}

test('real QuickJS drives View events, bubbling, input and data', async t => {
  const container = await launch(t);
  const page = await container.renderPage('/pages/counter/index');
  await (await page.query('#increment')).tap();
  assert.equal(await page.data('count'), 1);
  assert.equal(await page.data('bubbles'), 1);
  assert.equal((await page.query('#increment')).text, '1');
  await (await page.query('#input')).input('typed');
  assert.equal(await page.data('value'), 'typed');
  assert.equal(await page.data('missing'), undefined);
});

test('controlled Date, timer registration and nested microtasks share one clock', async t => {
  const container = await launch(t, { nowMs: 1000 });
  const page = await container.renderPage('/pages/counter/index');
  assert.deepEqual(await page.callMethod('readClock'), { now: 1000, date: 1000, performance: 0 });
  await page.callMethod('timing');
  await container.flush();
  assert.deepEqual(await page.data('order'), []);
  await container.clock.advanceBy(9);
  assert.deepEqual(await page.data('order'), []);
  await container.clock.advanceBy(1);
  assert.deepEqual(await page.data('order'), ['timer', 'microtask', 'second', 'nested']);
  assert.deepEqual(await page.callMethod('readClock'), { now: 1010, date: 1010, performance: 10 });
});

test('mocked request uses the real asynchronous wx callback pipeline', async t => {
  let calls = 0;
  const container = await launch(t, { host: { 'wx.request': async (payload, { signal }) => {
    assert.equal(payload.url, 'https://example.invalid/count');
    assert.equal(signal.aborted, false);
    calls++;
    return { data: { count: 42 }, statusCode: 200, header: {} };
  } } });
  const page = await container.renderPage('/pages/counter/index');
  await page.callMethod('request');
  assert.equal(await page.data('count'), 42);
  assert.equal(calls, 1);
});

test('unmatched requests fail instead of reaching the network', async t => {
  const container = await launch(t);
  const page = await container.renderPage('/pages/counter/index');
  await assert.rejects(page.callMethod('request'), /No host mock matched wx.request/);
});

test('parallel containers isolate storage, JS state and disposal', async t => {
  const [first, second] = await Promise.all([launch(t), launch(t)]);
  const [one, two] = await Promise.all([first.renderPage('/pages/counter/index'), second.renderPage('/pages/counter/index')]);
  await one.callMethod('increment'); await one.callMethod('remember');
  assert.equal(await one.callMethod('recalled'), 1);
  assert.equal(await two.callMethod('recalled'), '');
  assert.equal(await two.data('count'), 0);
});

test('navigation retains live pages and rejects popped or replaced handles', async t => {
  const container = await launch(t);
  const page = await container.renderPage('/pages/counter/index');
  const node = await page.query('#increment');
  const other = await container.navigateTo('/pages/other/index');
  await container.navigateBack();
  assert.equal(await page.data('count'), 0);
  await assert.rejects(other.data(), { code: 'ERR_STALE_HANDLE' });
  await container.renderPage('/pages/counter/index');
  await assert.rejects(page.data(), { code: 'ERR_STALE_HANDLE' });
  await assert.rejects(node.tap(), { code: 'ERR_STALE_HANDLE' });
});

test('component host overlay runs real methods, properties, slots and events', async t => {
  const container = await launch(t);
  const component = await container.renderComponent('components/counter/index', { properties: { value: 7 }, slots: { default: '<text id="slot">slotted</text>' }, events: ['change'] });
  assert.equal((await component.query('#slot')).text, 'slotted');
  assert.match((await component.query('#component-increment')).text, /7:0/);
  await (await component.query('#component-increment')).tap();
  assert.equal(await component.data('local'), 1);
  assert.deepEqual(await component.emitted(), [{ name: 'change', detail: { value: 1 } }]);
  await component.callMethod('increment');
  assert.equal(await component.data('local'), 2);
  await component.setProperties({ value: 9 });
  assert.match((await component.query('#component-increment')).text, /9:2/);
});

test('uncaught microtasks and console errors fail and remain diagnosable', async t => {
  const container = await launch(t);
  const page = await container.renderPage('/pages/counter/index');
  await assert.rejects(page.callMethod('throwLater'), /guest microtask failed/);
  await assert.rejects(page.callMethod('logError'), /expected console failure/);
  assert.ok(container.diagnostics().length);
});

test('execution limits interrupt infinite guest code and close its process', async t => {
  let aborted = false;
  const container = await launch(t, { turnTimeoutMs: 1000, host: {
    'wx.request': (payload, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
  } });
  const page = await container.renderPage('/pages/counter/index');
  await page.callMethod('request');
  await assert.rejects(page.callMethod('infinite'), /timeout|deadline|execution/i);
  await container.dispose();
  assert.equal(aborted, true);
});

test('flush bounds a self-rescheduling timer chain', async t => {
  const container = await launch(t, { flushBudget: 3 });
  const page = await container.renderPage('/pages/counter/index');
  await assert.rejects(page.callMethod('endlessTimer'), { code: 'ERR_NOT_QUIESCENT' });
});


test('App startup installs asynchronous mocks and synchronous snapshots before business execution', async t => {
  const container = await launch(t, { syncValues: { 'wx.getDeviceInfo': { model: 'test-device' } }, host: {
    'wx.request': async () => ({ data: 'launched', statusCode: 200 }),
  } });
  const page = await container.renderPage('/pages/counter/index', { request: true, device: true });
  assert.deepEqual(await page.callMethod('appData'), { launch: 'launched', device: { model: 'test-device' } });
});

test('late component callbacks cannot affect the next page after unload', async t => {
  let finish, signal;
  const container = await launch(t, { host: { 'wx.request': (payload, context) => {
    signal = context.signal;
    return new Promise(resolve => { finish = resolve; });
  } } });
  const component = await container.renderComponent('components/counter/index');
  await component.callMethod('request');
  assert.equal((await container.flush()).pendingHostCalls.length, 1);
  const page = await container.redirectTo('/pages/counter/index');
  assert.equal(signal.aborted, false);
  finish({ data: {}, statusCode: 200 });
  await container.flush();
  assert.equal(await page.data('count'), 0);
  await assert.rejects(component.data(), { code: 'ERR_STALE_HANDLE' });
});

test('disposal aborts outstanding host calls, waits for handlers and is idempotent', async t => {
  let cancelled = false;
  const container = await launch(t, { host: { 'wx.request': (payload, { signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { cancelled = true; resolve({}); }, { once: true });
  }) } });
  const page = await container.renderPage('/pages/counter/index');
  await page.callMethod('request');
  await Promise.all([container.dispose(), container.dispose()]);
  assert.equal(cancelled, true);
  await assert.rejects(page.data(), { code: 'ERR_CLOSED' });
});


test('explicit RequestTask abort reaches the host cancellation signal', async t => {
  let signal;
  const container = await launch(t, { host: { 'wx.request': (payload, context) => {
    signal = context.signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } } });
  const page = await container.renderPage('/pages/counter/index');
  await page.callMethod('beginAbortableRequest');
  assert.equal(signal.aborted, false);
  await page.callMethod('abortRequest');
  assert.equal(signal.aborted, true);
  assert.equal((await container.flush()).pendingHostCalls.length, 0);
  assert.deepEqual(container.diagnostics().filter(event => event.type === 'error'), []);
});

test('replacing a loaded session aborts old host calls before returning a fresh handle', async t => {
  let aborted = false;
  const container = await launch(t, { host: { 'wx.request': (payload, { signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { aborted = true; resolve({}); }, { once: true });
  }) } });
  const old = await container.renderPage('/pages/counter/index');
  await old.callMethod('request');
  const fresh = await container.renderPage('/pages/counter/index');
  assert.equal(aborted, true);
  assert.equal(await fresh.data('count'), 0);
  await assert.rejects(old.data(), { code: 'ERR_STALE_HANDLE' });
});


test('flush drains nested nextTick frontiers as well as microtasks', async t => {
  const container = await launch(t);
  const page = await container.renderPage('/pages/counter/index');
  await page.callMethod('ticks');
  assert.equal(await page.data('count'), 4);
});
