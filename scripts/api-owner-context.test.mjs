import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

// Exercise both production bootstraps with their actual shared sources. This
// harness supplies neither a third facade nor a second owner implementation.
function runtime(engine) {
  const realm = createAppServiceTestRealm(engine), { run, scripts } = realm
  const ownerAt = scripts.findIndex(script => script.name === 'api-owner')
  assert.ok(ownerAt >= 0 && ownerAt < scripts.findIndex(script => script.environment), `${engine} must load the shared owner before the facade`)
  run(`
    Page({}); Page({});
    __container_set_current_pages([0, 1], [
      { index: 0, instanceId: 11, route: 'pages/first' },
      { index: 1, instanceId: 12, route: 'pages/second' }
    ]);
    globalThis.firstPage = __container_page_instances['11'];
    globalThis.secondPage = __container_page_instances['12'];
    __container_registration_module_id = 'module:owner-component.js';
    __container_managed_component_modules[__container_registration_module_id] = true;
    globalThis.definition = Component({ methods: {} });
    __container_registration_module_id = null;
    globalThis.component = __container_clone_component_instance(definition, {
      scopeId: 'owner-component', moduleId: 'module:owner-component.js', pageId: 11,
      parentScopeId: null, ownerScopeId: null
    });
  `)
  return realm
}

for (const engine of ['quickjs', 'v8']) {
  test(`${engine}: production wrapper keeps receiver registration private and only captures actual live incarnations`, () => {
    const { run, transports, scripts } = runtime(engine)
    assert.deepEqual(scripts.map(script => script.name), ['timer-tasks', 'api-owner', 'mini-program', 'host-data-mirror', 'host-bridge'])
    assert.equal(run('typeof __receiver_register'), 'undefined')
    assert.equal(run('typeof __receiver_capture'), 'undefined')
    const captured = JSON.parse(transports.captureReceiverIncarnations({ pageId: '11', scopes: ['owner-component'] }))
    assert.match(captured.pageToken, /^[1-9][0-9]*$/); assert.match(captured.scopes['owner-component'], /^[1-9][0-9]*$/)
    run(`__container_page_instances['11'] = Object.assign({}, firstPage)`)
    assert.throws(() => transports.captureReceiverIncarnations({ pageId: '11', scopes: [] }), /native page receiver unavailable/)
  })

  test(`${engine}: strict capture and observer compatibility fallback are separate`, () => {
    const { run, json } = runtime(engine)
    assert.equal(run('__container_capture_api_owner()'), null)
    assert.equal(run('__container_observer_owner() === secondPage'), true)
    assert.equal(run(`__container_run_with_api_owner(firstPage, function() {
      return __container_capture_api_owner() === firstPage && __container_observer_owner() === firstPage;
    })`), true)
    assert.equal(run(`__container_run_with_api_owner({ scopeId: 'legacy' }, function() {
      return __container_capture_api_owner() === null && __container_observer_owner().scopeId === 'legacy';
    })`), true)
    assert.equal(run('__container_capture_api_owner()'), null)
    assert.equal(run('__container_observer_owner() === secondPage'), true)
    run(`__container_run_with_api_owner(component, function() {
      wx.createMediaQueryObserver();
      component.createMediaQueryObserver();
    });`)
    assert.deepEqual(json(`Object.values(__container_observers).map(function(record) {
      return [record.owner === component, record.pageId, record.scopeId];
    })`), [[true, '11', null], [true, '11', 'owner-component']])
  })

  test(`${engine}: strict capture validates live object identity and lifecycle`, () => {
    const { run, json } = runtime(engine)
    assert.deepEqual(json(`(function() {
      const capture = function(owner) { return __container_run_with_api_owner(owner, __container_capture_api_owner) === owner; };
      const checks = [capture(firstPage), capture(component), capture(Object.create(firstPage)), capture(Object.assign({}, component))];
      firstPage.__container_disposed = true;
      checks.push(capture(firstPage));
      delete firstPage.__container_disposed;
      const replacementPage = Object.create(firstPage);
      __container_page_instances['11'] = replacementPage;
      checks.push(capture(firstPage), capture(replacementPage));
      __container_page_instances['11'] = firstPage;
      component.__container_detached_lifecycle = true;
      checks.push(capture(component));
      delete component.__container_detached_lifecycle;
      component.__container_disposed = true;
      checks.push(capture(component));
      delete component.__container_disposed;
      const replacementComponent = __container_clone_component_instance(definition, {
        scopeId: 'owner-component', moduleId: 'module:owner-component.js', pageId: 11,
        parentScopeId: null, ownerScopeId: null
      });
      checks.push(capture(component), capture(replacementComponent));
      delete __container_component_scopes['owner-component'];
      checks.push(capture(replacementComponent));
      return checks;
    })()`), [true, true, false, false, false, false, true, false, false, false, true, false])
    assert.equal(run('__container_capture_api_owner()'), null)
  })

  test(`${engine}: nested contexts restore after throws without binding thunk this`, () => {
    const { run, json } = runtime(engine)
    assert.deepEqual(json(`(function() {
      const trace = [], expected = new Error('nested owner');
      const returned = __container_run_with_api_owner(firstPage, function() {
        'use strict';
        trace.push(this === undefined, __container_capture_api_owner() === firstPage);
        try {
          __container_run_with_api_owner(component, function() {
            trace.push(__container_capture_api_owner() === component);
            throw expected;
          });
        } catch (error) { trace.push(error === expected); }
        trace.push(__container_capture_api_owner() === firstPage);
        return 42;
      });
      trace.push(returned === 42, __container_capture_api_owner() === null);
      return trace;
    })()`), [true, true, true, true, true, true, true])
  })

  test(`${engine}: lifecycle and method wrappers preserve their existing receivers`, () => {
    const { run, json } = runtime(engine)
    run(`
      globalThis.trace = [];
      firstPage.onLoad = function(value) { trace.push(this === firstPage, __container_capture_api_owner() === firstPage, value); };
      component.methods.readOwner = function(value) { trace.push(this === component, __container_capture_api_owner() === component, value); };
      __container_invoke_page_instance(11, 0, 'onLoad', [1]);
      __container_invoke_component(component.__container_component_index, 'readOwner', [2]);
    `)
    assert.deepEqual(json('trace'), [true, true, 1, true, true, 2])
    assert.equal(run('__container_capture_api_owner()'), null)
  })

  test(`${engine}: native and nested custom handlers carry their actual owner and restore after errors`, () => {
    const { run, json } = runtime(engine)
    run(`
      globalThis.trace = [];
      __container_capabilities['Component.triggerEvent'] = 'partial';
      firstPage.receive = function() {
        trace.push(['custom', this === firstPage, __container_capture_api_owner() === firstPage]);
        throw new Error('custom handler');
      };
      firstPage.after = function() { trace.push(['after', this === firstPage, __container_capture_api_owner() === firstPage]); };
      component.onTap = function() {
        trace.push(['native', this === component, __container_capture_api_owner() === component]);
        wx.createMediaQueryObserver();
        this.triggerEvent('change', {});
        trace.push(['restored', __container_capture_api_owner() === component]);
        throw new Error('native handler');
      };
      const records = [{ scopeId: 'owner-component', ownerScopeId: null }];
      const batch = { pageId: 11, eventNodes: [{ key: 'host', parentKey: null,
        ownerScopeId: null, componentScopeId: 'owner-component',
        attributes: { bindchange: 'receive' }, dataset: {}, mark: {} }] };
      __container_publish_component_event_batch(batch, __container_prepare_component_event_batch(batch, records));
      __container_invoke_page_event(0, { type: 'tap', dispatches: [
        { handler: 'onTap', ownerScopeId: 'owner-component', currentTarget: 'target', phase: 'target' },
        { handler: 'after', ownerScopeId: null, currentTarget: 'parent', phase: 'bubble' }
      ] });
    `)
    assert.deepEqual(json('trace'), [['native', true, true], ['custom', true, true], ['restored', true], ['after', true, true]])
    assert.equal(run('__container_errors.length'), 2)
    assert.equal(run('__container_capture_api_owner()'), null)
    assert.deepEqual(json('Object.values(__container_observers).map(record => [record.owner === component, record.scopeId])'), [[true, null]])
    run('__container_unmount_component(component.__container_component_index)')
    assert.equal(run('Object.keys(__container_observers).length'), 0)
  })

  test(`${engine}: observer delivery carries owner while strict callback remains unbound`, () => {
    const { run, json } = runtime(engine)
    run(`
      globalThis.trace = [];
      __container_run_with_api_owner(component, function() {
        wx.createMediaQueryObserver().observe({ minWidth: 1 }, function(value) {
          'use strict';
          trace.push(this === undefined, __container_capture_api_owner() === component, value.matches);
          wx.createMediaQueryObserver();
          throw new Error('observer callback');
        });
      });
      const record = Object.values(__container_observers)[0];
      globalThis.delivered = __container_notify_observers([{ observerId: record.id,
        subscriptionId: Object.keys(record.subscriptions)[0], value: { matches: true } }]);
    `)
    assert.deepEqual(json('trace'), [true, true, true])
    assert.deepEqual(json('delivered'), { delivered: 1, ignored: 0 })
    assert.deepEqual(json('Object.values(__container_observers).map(record => [record.owner === component, record.scopeId])'), [[true, null], [true, null]])
    assert.equal(run('__container_errors.length'), 1)
    assert.equal(run('__container_capture_api_owner()'), null)
  })

  test(`${engine}: pending Promise and async continuations do not retain synchronous context`, async () => {
    const { run, json } = runtime(engine)
    const promise = run(`
      globalThis.trace = [];
      globalThis.release = null;
      __container_run_with_api_owner(firstPage, function() {
        trace.push(__container_capture_api_owner() === firstPage);
        return new Promise(function(resolve) { release = resolve; }).then(function() {
          trace.push(__container_capture_api_owner() === null);
          trace.push(__container_observer_owner() === secondPage);
        });
      });
    `)
    assert.equal(run('__container_capture_api_owner()'), null)
    run('release()')
    await promise
    await run(`__container_run_with_api_owner(component, async function() {
      trace.push(__container_capture_api_owner() === component);
      await 0;
      trace.push(__container_capture_api_owner() === null);
    })`)
    assert.deepEqual(json('trace'), [true, true, true, true, true])
    assert.equal(run('__container_capture_api_owner()'), null)
  })
}


function activeFirst(value) {
  // Keep both real incarnations live while making page 11 the visible owner.
  value.run(`__container_set_current_pages([1, 0], [
    { index: 1, instanceId: 12, route: 'pages/second' },
    { index: 0, instanceId: 11, route: 'pages/first' }
  ]);`)
  return value
}

function domRuntime(engine) {
  const value = activeFirst(runtime(engine))
  value.run(`__container_set_dom_query_contract({ version: '1.0', enabled: true });`)
  return value
}

for (const engine of ['quickjs', 'v8']) {
  test(`${engine}: DOM query contract strictly negotiates version and preserves the prior mode on rejection`, () => {
    const { run, json } = runtime(engine)
    assert.equal(run('__container_dom_query_enabled()'), false)
    run(`__container_set_dom_query_contract({ version: '1.0', enabled: true })`)
    assert.deepEqual(json(`[
      null, [], {}, { version: '2.0', enabled: true }, { version: '1.0', enabled: 1 },
      { version: '1.0' }, { enabled: true }, { version: '1.0', enabled: false, extra: true },
      Object.assign(Object.create({ version: '1.0' }), { enabled: false }),
      Object.defineProperty({ version: '1.0', enabled: false }, 'hidden', { value: 1 }),
      { version: '1.0', enabled: false, [Symbol('extra')]: true },
      { version: '1.0', get enabled() { throw new Error('must not invoke accessor'); } }
    ].map(function(contract) {
      try { __container_set_dom_query_contract(contract); return false; }
      catch (error) { return error.code === 'ERR_PROTOCOL_VERSION' && __container_dom_query_enabled(); }
    })`), Array(12).fill(true))
    run(`__container_set_dom_query_contract({ version: '1.0', enabled: false })`)
    assert.equal(run('__container_dom_query_enabled()'), false)
  })

  test(`${engine}: standalone unowned Skia query keeps its unscoped extension without reserved owner metadata`, async () => {
    const { run, json } = runtime(engine)
    const pending = run(`wx.createSelectorQuery().select('#legacy').boundingClientRect().exec()`)
    const event = json('__container_events.filter(value => value.type === "api.call").pop()')
    assert.equal(Object.hasOwn(event, 'owner'), false)
    assert.equal(event.options.queries[0].scopeId, null)
    run(`__container_resolve_api(${event.id}, [{ id: 'legacy' }], null)`)
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), [{ id: 'legacy' }])
  })

  test(`${engine}: native selector scope requires a real live receiver`, async () => {
    const { run, json } = activeFirst(runtime(engine))
    await assert.rejects(run(`wx.createSelectorQuery().in({ scopeId: 'owner-component' }).select('#forged').boundingClientRect().exec()`), error => error.code === 'ERR_INVALID_REQUEST')
    assert.deepEqual(json('__container_events.filter(value => value.type === "api.call")'), [])
    const pending = run(`wx.createSelectorQuery().in(component).select('#real').boundingClientRect().exec()`)
    const event = json('__container_events.filter(value => value.type === "api.call").pop()')
    assert.deepEqual(event.owner, { pageId: '11', scopeId: 'owner-component' })
    assert.equal(event.options.queries[0].scopeId, 'owner-component')
    run(`__container_resolve_api(${event.id}, [{ id: 'real' }], null)`)
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), [{ id: 'real' }])
  })

  test(`${engine}: DOM builder keeps its active page owner across a different synchronous owner context`, async () => {
    const { run, json } = domRuntime(engine)
    run(`globalThis.query = __container_run_with_api_owner(firstPage, function() {
      return wx.createSelectorQuery();
    });`)
    const pending = run(`__container_run_with_api_owner(secondPage, function() {
      return query.select('#first').boundingClientRect().exec();
    })`)
    const event = json('__container_events.filter(value => value.type === "api.call").pop()')
    assert.deepEqual(event.owner, { pageId: '11', scopeId: null })
    assert.equal(event.options.queries[0].scopeId, null)
    assert.equal(Object.hasOwn(event.options, 'owner'), false)
    run(`__container_resolve_api(${event.id}, [null], null)`)
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), [null])
  })

  test(`${engine}: actual navigation cancels old builders and pending callbacks without retargeting`, async () => {
    const { run, json } = domRuntime(engine)
    const pending = run(`
      globalThis.trace = [];
      globalThis.oldBuilder = __container_run_with_api_owner(firstPage, function() { return wx.createSelectorQuery(); });
      __container_run_with_api_owner(firstPage, function() {
        return wx.createSelectorQuery().select('#pending').boundingClientRect(function() { trace.push('operation'); })
          .exec(function() { trace.push('exec'); });
      });
    `)
    const event = json('__container_events.filter(value => value.type === "api.call").pop()')
    run(`__container_set_current_pages([0, 1], [
      { index: 0, instanceId: 11, route: 'pages/first' },
      { index: 1, instanceId: 12, route: 'pages/second' }
    ]);`)
    await assert.rejects(run(`oldBuilder.select('#hidden').boundingClientRect().exec()`), error => error.code === 'ERR_CANCELLED')
    assert.equal(run('__container_events.filter(value => value.type === "api.call").length'), 1)
    assert.deepEqual(event.owner, { pageId: '11', scopeId: null })
    run(`__container_resolve_api(${event.id}, [null], null)`)
    await assert.rejects(pending, error => error.code === 'ERR_CANCELLED')
    assert.deepEqual(json('trace'), [])
  })

  test(`${engine}: explicit real receiver can establish ownership while fake and cross-page scopes are rejected`, async () => {
    const { run, json } = domRuntime(engine)
    await assert.rejects(run(`wx.createSelectorQuery().select('#ownerless').boundingClientRect().exec()`), error => error.code === 'ERR_CANCELLED')
    for (const receiver of [`{ scopeId: 'owner-component' }`, 'Object.create(component)', `Object.assign({}, firstPage)`]) {
      await assert.rejects(run(`__container_run_with_api_owner(firstPage, function() {
        return wx.createSelectorQuery().in(${receiver}).select('#fake').boundingClientRect().exec();
      })`), error => error.code === 'ERR_INVALID_REQUEST')
      await assert.rejects(run(`wx.createSelectorQuery().in(${receiver}).select('#fake-ownerless').boundingClientRect().exec()`), error => error.code === 'ERR_CANCELLED')
    }
    await assert.rejects(run(`__container_run_with_api_owner(firstPage, function() {
      return wx.createSelectorQuery().in(secondPage).select('#other-page').boundingClientRect().exec();
    })`), error => error.code === 'ERR_INVALID_REQUEST')
    assert.equal(run('__container_events.filter(value => value.type === "api.call").length'), 0)
    const pending = run(`wx.createSelectorQuery().in(component).select('#actual').boundingClientRect().exec()`)
    const event = json('__container_events.filter(value => value.type === "api.call").pop()')
    assert.deepEqual(event.owner, { pageId: '11', scopeId: 'owner-component' })
    assert.equal(event.options.queries[0].scopeId, 'owner-component')
    run(`__container_resolve_api(${event.id}, [false], null)`)
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), [false])
  })

  test(`${engine}: component lifecycle ownership and explicit selector scope are independent`, async () => {
    const { run, json } = domRuntime(engine)
    const pending = run(`__container_run_with_api_owner(component, function() {
      return wx.createSelectorQuery().select('#page-scope').boundingClientRect().exec();
    })`)
    const narrowed = run(`__container_run_with_api_owner(firstPage, function() {
      return wx.createSelectorQuery().in(component).selectAll('.scoped').boundingClientRect().exec();
    })`)
    const events = json('__container_events.filter(value => value.type === "api.call")')
    assert.deepEqual(events.map(value => value.owner), [
      { pageId: '11', scopeId: 'owner-component' }, { pageId: '11', scopeId: null },
    ])
    assert.deepEqual(events.map(value => value.options.queries[0].scopeId), [null, 'owner-component'])
    run(`__container_resolve_api(${events[0].id}, [null], null); __container_resolve_api(${events[1].id}, [[{ id: 'scoped' }]], null);`)
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), [null])
    assert.deepEqual(JSON.parse(JSON.stringify(await narrowed)), [[{ id: 'scoped' }]])
  })

  test(`${engine}: native event reserved owner is never read from user options`, async () => {
    const { run, json } = domRuntime(engine)
    const pending = run(`__container_api_call('wx.test', { owner: { pageId: 'forged', scopeId: 'forged' } })`)
    const event = json('__container_events.filter(value => value.type === "api.call").pop()')
    assert.equal(Object.hasOwn(event, 'owner'), false)
    assert.deepEqual(event.options.owner, { pageId: 'forged', scopeId: 'forged' })
    assert.deepEqual(json('Object.keys(__container_api_pending[1]).sort()'), ['name', 'options', 'reject', 'resolve'])
    run(`__container_resolve_api(${event.id}, {}, null)`)
    await pending
  })

  test(`${engine}: both selector callbacks run under the captured owner without binding this or leaking Promise context`, async () => {
    const { run, json } = domRuntime(engine)
    const pending = run(`
      globalThis.trace = [];
      __container_run_with_api_owner(component, function() {
        return wx.createSelectorQuery().select('#callback').boundingClientRect(function(value) {
          'use strict';
          trace.push(['operation', this === undefined, __container_capture_api_owner() === component, value.id]);
          wx.createMediaQueryObserver();
          globalThis.nestedQuery = wx.createSelectorQuery();
          Promise.resolve().then(function() { trace.push(['microtask', __container_capture_api_owner() === null]); });
        }).exec(function(values) {
          'use strict';
          trace.push(['exec', this === undefined, __container_capture_api_owner() === component, values.length]);
        });
      });
    `)
    const event = json('__container_events.filter(value => value.type === "api.call").pop()')
    run(`__container_resolve_api(${event.id}, [{ id: 'callback' }], null)`)
    await pending
    assert.deepEqual(json('trace'), [['operation', true, true, 'callback'], ['exec', true, true, 1], ['microtask', true]])
    assert.deepEqual(json('Object.values(__container_observers).map(record => [record.owner === component, record.scopeId])'), [[true, null]])
    const nested = run(`nestedQuery.select('#nested').boundingClientRect().exec()`)
    const nestedEvent = json('__container_events.filter(value => value.type === "api.call").pop()')
    assert.deepEqual(nestedEvent.owner, { pageId: '11', scopeId: 'owner-component' })
    run(`__container_resolve_api(${nestedEvent.id}, [null], null)`)
    await nested
    assert.equal(run('__container_capture_api_owner()'), null)
  })

  test(`${engine}: thrown selector callbacks are reported while remaining callbacks keep their owner`, async () => {
    const { run, json } = domRuntime(engine)
    const pending = run(`
      globalThis.trace = [];
      __container_run_with_api_owner(firstPage, function() {
        const query = wx.createSelectorQuery();
        query.select('#first').boundingClientRect(function() { trace.push('first'); throw new Error('callback failed'); });
        query.selectAll('.second').boundingClientRect(function(value) { trace.push(['second', value.length, __container_capture_api_owner() === firstPage]); });
        return query.exec(function() { trace.push(['exec', __container_capture_api_owner() === firstPage]); });
      });
    `)
    const event = json('__container_events.filter(value => value.type === "api.call").pop()')
    run(`__container_resolve_api(${event.id}, [null, []], null)`)
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), [null, []])
    assert.deepEqual(json('trace'), ['first', ['second', 0, true], ['exec', true]])
    assert.equal(run('__container_errors.length'), 1)
    assert.equal(run('__container_capture_api_owner()'), null)
  })

  test(`${engine}: disposal inside a callback cancels all later success callbacks`, async () => {
    const { run, json } = domRuntime(engine)
    const pending = run(`
      globalThis.trace = [];
      __container_run_with_api_owner(component, function() {
        const query = wx.createSelectorQuery();
        query.select('#first').boundingClientRect(function() { trace.push('first'); __container_unmount_component(component.__container_component_index); });
        query.select('#second').boundingClientRect(function() { trace.push('must-not-run'); });
        return query.exec(function() { trace.push('must-not-run-exec'); });
      });
    `)
    const event = json('__container_events.filter(value => value.type === "api.call").pop()')
    run(`__container_resolve_api(${event.id}, [null, null], null)`)
    await assert.rejects(pending, error => error.code === 'ERR_CANCELLED')
    assert.deepEqual(json('trace'), ['first'])
    assert.equal(run('__container_capture_api_owner()'), null)
  })

  test(`${engine}: disposed or replaced owners never execute success callbacks`, async () => {
    const changes = [
      `__container_invoke_page_instance(11, 0, 'onUnload', [])`,
      `__container_invoke_page_instance(11, 0, 'onUnload', []); delete __container_page_instances['11'];
        __container_set_current_pages([1, 0], [{index:1,instanceId:12}, {index:0,instanceId:11}])`,
      `__container_unmount_component(component.__container_component_index)`,
      `__container_clone_component_instance(definition, { scopeId: 'owner-component', moduleId: 'module:owner-component.js', pageId: 11, parentScopeId: null, ownerScopeId: null })`,
      `__container_invoke_page_instance(11, 0, 'onUnload', [])`,
    ]
    for (const [index, change] of changes.entries()) {
      const { run, json } = domRuntime(engine)
      const owner = index < 2 ? 'firstPage' : 'component'
      const pending = run(`
        globalThis.trace = [];
        __container_run_with_api_owner(${owner}, function() {
          return wx.createSelectorQuery().select('#pending').boundingClientRect(function() { trace.push('operation'); })
            .exec(function() { trace.push('exec'); });
        });
      `)
      const event = json('__container_events.filter(value => value.type === "api.call").pop()')
      run(change)
      run(`__container_resolve_api(${event.id}, [null], null)`)
      await assert.rejects(pending, error => error.code === 'ERR_CANCELLED')
      assert.deepEqual(json('trace'), [], `${change}: success callbacks must stay cancelled`)
    }
  })

  test(`${engine}: disposed owners and scopes are rejected before a request is dispatched`, async () => {
    for (const expression of ['wx.createSelectorQuery()', 'wx.createSelectorQuery().in(component)']) {
      const { run, json } = domRuntime(engine)
      const owner = expression.includes('.in(') ? 'firstPage' : 'component'
      run(`globalThis.query = __container_run_with_api_owner(${owner}, function() { return ${expression}; });
        __container_unmount_component(component.__container_component_index);`)
      await assert.rejects(run(`query.select('#disposed').boundingClientRect().exec()`), error => error.code === 'ERR_CANCELLED')
      assert.deepEqual(json('__container_events.filter(value => value.type === "api.call")'), [])
    }
  })

  test(`${engine}: each pending exec keeps its own validated selection snapshot`, async () => {
    const { run, json } = domRuntime(engine)
    run(`globalThis.query = __container_run_with_api_owner(firstPage, function() { return wx.createSelectorQuery().in(component); });`)
    const scoped = run(`query.select('#scoped').boundingClientRect().exec()`)
    const unscoped = run(`query.in(null).select('#page').boundingClientRect().exec()`)
    const events = json('__container_events.filter(value => value.type === "api.call")')
    assert.deepEqual(events.map(value => value.options.queries[0].scopeId), ['owner-component', null])
    assert.deepEqual(events.map(value => value.owner), [{ pageId: '11', scopeId: null }, { pageId: '11', scopeId: null }])
    run(`__container_unmount_component(component.__container_component_index);
      __container_resolve_api(${events[0].id}, [null], null);
      __container_resolve_api(${events[1].id}, [null], null);
    `)
    await assert.rejects(scoped, error => error.code === 'ERR_CANCELLED')
    assert.deepEqual(JSON.parse(JSON.stringify(await unscoped)), [null])
  })

  test(`${engine}: retained references keep their creation scope when the builder later changes scope`, async () => {
    const { run, json } = domRuntime(engine)
    const pending = run(`__container_run_with_api_owner(firstPage, function() {
      const query = wx.createSelectorQuery().in(component);
      const retained = query.select('#retained');
      query.in(null).select('#later').boundingClientRect();
      retained.boundingClientRect();
      return query.exec();
    })`)
    const event = json('__container_events.filter(value => value.type === "api.call").pop()')
    assert.deepEqual(event.options.queries.map(value => [value.selector, value.scopeId]), [['#later', null], ['#retained', 'owner-component']])
    assert.deepEqual(event.owner, { pageId: '11', scopeId: null })
    run(`__container_resolve_api(${event.id}, [null, null], null)`)
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), [null, null])
  })

  test(`${engine}: public page and scope aliases cannot revoke or retarget private selector authority`, async () => {
    const { run, json } = domRuntime(engine)
    const pending = run(`
      globalThis.trace = [];
      __container_run_with_api_owner(component, function() {
        return wx.createSelectorQuery().in(component).select('#actual').boundingClientRect(function(value) {
          trace.push([value.id, __container_api_owner_for_observer() === component]);
        }).exec(function() { trace.push(['exec', __container_api_owner_for_observer() === component]); });
      });
    `)
    const event = json('__container_events.filter(value => value.type === "api.call").pop()')
    run(`firstPage.__container_disposed = true;
      component.__container_disposed = true;
      component.__container_detached_lifecycle = true;
      __container_page_instances['11'] = Object.create(firstPage);
      __container_component_scopes['owner-component'] = Object.create(component);
      __container_current_page_instances = [secondPage];
      __container_resolve_api(${event.id}, [{ id: 'actual' }], null);`)
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), [{ id: 'actual' }])
    assert.deepEqual(event.owner, { pageId: '11', scopeId: 'owner-component' })
    assert.deepEqual(json('trace'), [['actual', true], ['exec', true]])
    assert.equal(run('__container_capture_api_owner()'), null)
  })

  test(`${engine}: empty DOM batches still require and revalidate their captured owner`, async () => {
    const { run, json } = domRuntime(engine)
    await assert.rejects(run('wx.createSelectorQuery().exec()'), error => error.code === 'ERR_CANCELLED')
    const pending = run(`
      globalThis.trace = [];
      __container_run_with_api_owner(firstPage, function() {
        return wx.createSelectorQuery().exec(function(values) { 'use strict'; trace.push(values.length, this === undefined, __container_capture_api_owner() === firstPage); });
      });
    `)
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), [])
    assert.deepEqual(json('trace'), [0, true, true])
    const cancelled = run(`__container_run_with_api_owner(firstPage, function() {
      return wx.createSelectorQuery().exec(function() { trace.push('must-not-run'); });
    });`)
    run(`__container_invoke_page_instance(11, 0, 'onUnload', [])`)
    await assert.rejects(cancelled, error => error.code === 'ERR_CANCELLED')
    assert.deepEqual(json('trace'), [0, true, true])
  })

  test(`${engine}: profile changes invalidate old builders and pending DOM callbacks`, async () => {
    const { run, json } = activeFirst(runtime(engine))
    run(`globalThis.legacyQuery = wx.createSelectorQuery();
      __container_set_dom_query_contract({ version: '1.0', enabled: true });`)
    await assert.rejects(run(`legacyQuery.select('#legacy').boundingClientRect().exec()`), error => error.code === 'ERR_CANCELLED')
    const pending = run(`__container_run_with_api_owner(firstPage, function() {
      return wx.createSelectorQuery().select('#pending').boundingClientRect().exec();
    })`)
    const event = json('__container_events.filter(value => value.type === "api.call").pop()')
    run(`__container_set_dom_query_contract({ version: '1.0', enabled: false });
      __container_set_dom_query_contract({ version: '1.0', enabled: true });
      __container_resolve_api(${event.id}, [null], null);`)
    await assert.rejects(pending, error => error.code === 'ERR_CANCELLED')
  })
}
