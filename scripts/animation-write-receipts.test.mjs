import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppServiceTestRealm} from './app-service-test-realm.mjs';
function realm(engine) {
 const r=createAppServiceTestRealm(engine);
 r.run(`Page({data:{animation:{actions:[]},other:0}});__container_set_current_pages([0],[{index:0,instanceId:11}]);globalThis.page=__container_page_instances['11'];
 __container_registration_module_id='module:c.js';__container_managed_component_modules[__container_registration_module_id]=true;globalThis.definition=Component({data:{animation:{actions:[]}},methods:{}});__container_registration_module_id=null;
 globalThis.child=__container_clone_component_instance(definition,{scopeId:'child',moduleId:'module:c.js',pageId:11,parentScopeId:null,ownerScopeId:null});`);
 r.capture=()=>JSON.parse(r.transports.captureReceiverIncarnations({kind:'animation-write-snapshot',pageId:'11',scopes:['child']}));
 return r;
}
for(const engine of ['quickjs','v8']) {
 test(`${engine}: equal successful page/component writes stamp exact paths without dirty/observer changes`,()=>{
  const r=realm(engine);r.run(`globalThis.observed=0;child.observers={animation:function(){observed++}};__container_events=[];page.setData({animation:{actions:[]}});child.setData({animation:{actions:[]}});`);
  const first=r.capture();assert.deepEqual(first.pageWrites.map(x=>x.path),[['animation']]);assert.deepEqual(first.scopes.child.writes.map(x=>x.path),[['animation']]);
  assert.equal(r.run('observed'),0);assert.equal(r.json('__container_events').filter(x=>x.type==='component.property.patch').length,0);
  r.run(`child.setData({animation:{actions:[]}});page.setData({other:1})`);const next=r.capture();
  assert.ok(BigInt(next.scopes.child.writes[0].stamp)>BigInt(first.scopes.child.writes[0].stamp));
  assert.equal(next.pageWrites.find(x=>x.path[0]==='animation').stamp,first.pageWrites[0].stamp);
  assert.equal(r.run('typeof globalThis.__receiver_write_finish'),'undefined');
 });
 test(`${engine}: standalone components preserve writes without acquiring managed animation authority`,()=>{
  const r=realm(engine);r.run(`globalThis.standalone=__container_clone_component_instance(definition);standalone.__container_page_id=11;standalone.__container_scope_id='child';standalone.setData({count:2});__container_component_apply_patch(standalone,{title:'standalone'},'properties');`);
  assert.equal(r.run('standalone.data.count'),2);assert.equal(r.run('standalone.data.title'),'standalone');
  assert.deepEqual(r.capture().pageWrites,[]);assert.deepEqual(r.capture().scopes.child.writes,[]);
 });
 test(`${engine}: host reservations prevent partial input observation and abort without minting stamps`,()=>{
  const r=realm(engine);const before=r.capture();const prepared=JSON.parse(r.transports.captureReceiverIncarnations({kind:'animation-host-write-prepare',pageId:'11',paths:['animation']}));
  assert.throws(()=>r.capture(),/completed prefix/);
  r.transports.captureReceiverIncarnations({kind:'animation-host-write-finish',ticket:prepared.ticket,completed:false});assert.deepEqual(r.capture(),before);
  const accepted=JSON.parse(r.transports.captureReceiverIncarnations({kind:'animation-host-write-prepare',pageId:'11',paths:['animation']}));
  r.run(`__container_apply_page_data_batch(11,[[['animation'],false,{actions:[]}]])`);
  r.transports.captureReceiverIncarnations({kind:'animation-host-write-finish',ticket:accepted.ticket,completed:true});assert.equal(r.capture().pageWrites[0].local,false);
  assert.throws(()=>r.transports.captureReceiverIncarnations({kind:'animation-host-write-finish',ticket:accepted.ticket,completed:true}),/ticket unavailable/);
 });
 test(`${engine}: component clone receipt keeps the input prefix sampled before reentrant serialization`,()=>{
  const r=realm(engine);r.run(`child.setData({animation:{actions:[]}});child.data.toJSON=function(){delete child.data.toJSON;child.setData({animation:{actions:[]}});return child.data};__container_component_snapshot(child.__container_component_index)`);
  const receipt=JSON.parse(r.transports.captureReceiverIncarnations({pageId:'11',scopes:['child'],componentSnapshots:true}));
  const before=receipt.scopes.child.writeSnapshot[0].stamp,after=r.capture().scopes.child.writes[0].stamp;
  assert.ok(BigInt(after)>BigInt(before));assert.equal(JSON.parse(receipt.scopes.child.snapshotJson).inputIdentity.writeSnapshot,undefined);
 });
 test(`${engine}: failed write publishes no successful receipt and forged public aliases cannot supply stamps`,()=>{
  const r=realm(engine);r.run(`globalThis.patch={};Object.defineProperty(patch,'animation',{enumerable:true,get:function(){throw Error('getter failed')}})`);
  assert.throws(()=>r.run('child.setData(patch)'),/getter failed/);assert.deepEqual(r.capture().scopes.child.writes,[]);
  r.run(`globalThis.__receiver_write_head={paths:[['forged']],stamp:'999'};child.setData({'nested[2].animation':{actions:[]}})`);
  assert.deepEqual(r.capture().scopes.child.writes[0].path,['nested',2,'animation']);
 });
}
