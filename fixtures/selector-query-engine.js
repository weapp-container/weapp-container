// Shared native-engine fixture: no host geometry or component scopes are faked.
Page({ data: {} });
__container_set_current_pages([0], [{ index: 0, instanceId: 1 }]);
__container_registration_module_id = 'selector:component';
__container_managed_component_modules['selector:component'] = true;
Component({});
__container_registration_module_id = null;
function componentRecord(scope) {
  return { scopeId: scope, moduleId: 'selector:component', parentScopeId: null,
    ownerScopeId: null, properties: {} };
}
const componentScopes = ['test-scope', 'initial-scope', 'final-scope'];
__container_reconcile_components({ version: 1, phase: 'prepare', pageId: 1,
  instances: componentScopes.map(componentRecord), remove: [] });
function component(scope) { return __container_component_scopes[scope]; }
function page() { return __container_page_instances['1']; }
let query;
let trace = [];
let result = null;
let failure = null;
function observe(name) {
  return function(value) { trace.push([name, value]); };
}
function completed(value) { result = value; }
function rejected(error) { failure = error.code; }
exports.batch = function() {
  query = wx.createSelectorQuery().in(component('test-scope'));
  const fields = { dataset: true, id: false };
  query.select('#first').fields(fields, observe('fields'));
  fields.dataset = false;
  query.selectAll('.card').boundingClientRect(observe('rect'));
  query.select('#missing').scrollOffset(observe('offset'));
  query.exec(observe('exec')).then(completed, rejected);
};
exports.failing = function() {
  query = wx.createSelectorQuery();
  query.select('#old').fields({ dataset: true }, observe('old'));
  query.exec(observe('old-exec')).then(completed, rejected);
};
exports.reuse = function() {
  query.select('#fresh').fields({ dataset: true }, observe('fresh'));
  query.exec(observe('fresh-exec')).then(completed, rejected);
};
exports.empty = function() {
  query.exec(observe('empty-exec')).then(completed, rejected);
};
exports.invalid = function() {
  query = wx.createSelectorQuery();
  query.select('#not-dispatched').fields({}, observe('not-dispatched'));
  query.select('').fields({}, observe('invalid'));
  query.exec(observe('invalid-exec')).then(completed, rejected);
};
exports.throwing = function() {
  query = wx.createSelectorQuery();
  query.select('#first').fields({}, function() { throw new Error('selector callback failed'); });
  query.select('#second').fields({}, observe('after-throw'));
  query.exec(observe('exec')).then(completed, rejected);
};
exports.retained = function() {
  query = wx.createSelectorQuery().in(component('initial-scope'));
  const first = query.select('#retained');
  const second = query.select('#later');
  second.fields({ id: true }, observe('second'));
  first.fields({ dataset: true }, observe('first'));
  query.select('#unused');
  query.in(component('final-scope'));
  query.exec(observe('exec')).then(completed, rejected);
};
exports.invalidScope = function() {
  query = wx.createSelectorQuery().in({});
  query.select('#page-secret').fields({}, observe('invalid-scope'));
  query.exec(observe('invalid-scope-exec')).then(completed, rejected);
};
exports.pageScope = function() {
  query = wx.createSelectorQuery().in(page());
  query.select('#page').boundingClientRect(observe('page'));
  query.exec(observe('page-exec')).then(completed, rejected);
};
exports.forgedScope = function() {
  query = wx.createSelectorQuery().in({ scopeId: 'test-scope', __container_instance_id: '1' });
  query.select('#secret').boundingClientRect(observe('forged'));
  query.exec(observe('forged-exec')).then(completed, rejected);
};
exports.replacePage = function() {
  __container_invoke_page_instance(1, 0, 'onUnload', []);
  delete __container_page_instances['1'];
  __container_set_current_pages([0], [{ index: 0, instanceId: 1 }]);
  return true;
};
exports.unloadPage = function() {
  __container_invoke_page_instance(1, 0, 'onUnload', []);
  return true;
};
exports.pushPage = function() {
  __container_set_current_pages([0, 0], [{ index: 0, instanceId: 1 }, { index: 0, instanceId: 2 }]);
  return true;
};
exports.replaceScope = function() {
  __container_reconcile_components({ version: 1, phase: 'dispose', pageId: 1,
    instances: [], remove: ['test-scope'] });
  __container_reconcile_components({ version: 1, phase: 'prepare', pageId: 1,
    instances: [componentRecord('test-scope')], remove: [] });
  return true;
};
exports.reinsertRetiredScope = function() {
  const saved = component('test-scope');
  exports.replaceScope();
  saved.__container_disposed = saved.__container_detached_lifecycle = false;
  __container_component_scopes['test-scope'] = saved;
  return true;
};
exports.disposeInCallback = function() {
  query = wx.createSelectorQuery().in(component('test-scope'));
  query.select('#first').boundingClientRect(function(value) {
    trace.push(['first', value]);
    exports.replaceScope();
  });
  query.select('#second').boundingClientRect(observe('second'));
  query.exec(observe('exec')).then(completed, rejected);
};
exports.timerPageScope = function() {
  const receiver = page();
  setTimeout(function() {
    query = wx.createSelectorQuery().in(receiver);
    query.select('#timer').boundingClientRect(observe('timer'));
    query.exec(observe('timer-exec')).then(completed, rejected);
  }, 0);
  return true;
};
exports.timerUnscoped = function() {
  setTimeout(function() {
    query = wx.createSelectorQuery();
    query.select('#timer').boundingClientRect(observe('timer'));
    query.exec(observe('timer-exec')).then(completed, rejected);
  }, 0);
  return true;
};
exports.state = function() { return { trace: trace, result: result, failure: failure }; };
