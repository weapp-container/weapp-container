const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const native = require(process.argv[2]);
const hash = value => createHash('sha256').update(value).digest('hex');
const parse = value => JSON.parse(value);
function load(owner, id, appLoggedIn) {
  const app = 'App({});', page = `Page({data:{owner:${JSON.stringify(id)},identity:weappContainer.identity.getState()}});`;
  const modules = [{ id: 'module:app.js', source: app }, { id: 'module:pages/index.js', source: page }];
  const manifest = { schemaVersion: 1, protocolVersion: '1.0', compiler: { name: 'weapp-vite', commit: 'native-owner-probe', platform: 'weapp' },
    app: { appJson: 'app.json', entryModule: 'app.js' }, routes: [{ id: 'route:pages/index', path: 'pages/index', kind: 'page', entryModule: 'pages/index.js' }],
    modules: modules.map((module, index) => ({ id: module.id, sha256: hash(module.source), format: 'commonjs', scope: index ? 'page' : 'app' })),
    capabilities: {}, integrity: { algorithm: 'sha256', root: '' } };
  assert.equal(parse(owner.loadManifestWithConfig(JSON.stringify(manifest), JSON.stringify({ engine: 'quickjs', session_id: id }))).ok, true);
  const configured = parse(owner.hostServices(JSON.stringify({ operation: 'configure', payload: {
    application: { hostAppId: 'host', tenantId: 'tenant', publisherId: 'publisher', appId: id, environment: 'release', version: '1', packRoot: '' },
    account: { principalId: id, epoch: '1' }, apis: ['weappContainer.identity.getState'],
    syncValues: { 'weappContainer.identity.getState': { hostLoggedIn: true, appLoggedIn, profileAuthorized: false, phoneAuthorized: false } },
  } })));
  assert.notEqual(configured.ok, false, JSON.stringify(configured));
  for (const [index, [op, payload]] of [['app.init', { modules }], ['app.lifecycle', { event: 'launch' }], ['page.push', { path: 'pages/index' }]].entries()) {
    const result = parse(owner.dispatch(JSON.stringify({ protocolVersion: '1.0', sessionId: id, requestId: String(index), kind: 'request', op, payload })));
    assert.notEqual(result.ok, false, JSON.stringify(result));
    assert(!result.messages?.some(message => message.op === 'error'), JSON.stringify(result));
  }
  assert.equal(parse(owner.inspectState()).page.data.owner, id);
  assert.equal(parse(owner.inspectState()).page.data.identity.appLoggedIn, appLoggedIn);
}

(async () => {
  let first = native.createOwner();
  const second = native.createOwner();
  try {
    load(first, 'owner-alice', true); load(second, 'owner-bob', false);
    assert.equal(parse(first.inspectState()).sessionId, 'owner-alice');
    const retained = first.inspectState, destroyFirst = first.destroy;
    first = null;
    for (let index = 0; index < 4; ++index) { global.gc(); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(parse(retained()).sessionId, 'owner-alice', 'an extracted method retains its isolated native owner');
    native.destroy(); // Legacy environment owner cannot destroy scoped owners.
    assert.equal(parse(second.inspectState()).sessionId, 'owner-bob');
    destroyFirst();
    assert.equal(parse(retained()).ok, false, 'a destroyed scoped owner cannot resurrect its runtime');
    assert.equal(parse(second.inspectState()).page.data.owner, 'owner-bob');
    second.destroy(); second.destroy();
    assert.equal(parse(second.capabilities()).ok, false);
    console.log(JSON.stringify({ passed: true, classification: 'actual-node-napi-and-rust-quickjs-owner-isolation',
      assertions: ['independent real QuickJS facades', 'independent trusted app/account snapshots', 'independent legacy/scoped lifetimes', 'extracted callback retains owner across GC', 'destroy is terminal and idempotent'],
      graphics: 'not-invoked', harmonyDevice: 'not-run' }));
  } finally { if (first) first.destroy(); second.destroy(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
