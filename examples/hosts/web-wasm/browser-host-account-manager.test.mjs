import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserHostAccountManager, browserStorageScope } from './browser-host-account-manager.mjs'
const app = {hostAppId:'host',tenantId:'tenant',publisherId:'pub',appId:'app',environment:'release',version:'1',packRoot:'a'.repeat(64)}
const deferred = () => { let resolve; const promise = new Promise(done=>resolve=done);return {promise,resolve} }
function owners({ failEpoch, presentation, lateResult } = {}) {
  const created=[],log=[]
  const createOwner=async options=>{
    log.push(['create',options.account.epoch]); const epoch=options.account.epoch
    const owner={ options,revoked:false,
      revoke(){this.revoked=true;log.push(['revoke',epoch])},
      async detachSurface(){log.push(['detach',epoch])},
      async close(){log.push(['close',epoch])},
      async start(launch){this.launch=launch;log.push(['start',epoch]);if(epoch===failEpoch)throw new Error('startup failed')},
      async waitForPresentation(){if(presentation?.epoch===epoch)await presentation.promise;log.push(['present',epoch])},
      async invoke(){if(lateResult)await lateResult.promise;return {epoch}},
    };created.push(owner);return owner
  }
  return {createOwner,created,log}
}
test('switch revokes sibling controllers immediately and presents only new identity with fresh launch',async t=>{
  const manager=new BrowserHostAccountManager({principalId:'alice',epoch:1}),a=owners(),b=owners()
  const first=manager.attach({application:app,createOwner:a.createOwner,launchOptions:{query:{secret:'alice'}}})
  const second=manager.attach({application:{...app,appId:'other'},createOwner:b.createOwner})
  t.after(async()=>{await first.close();await second.close()});await Promise.all([first.ready,second.ready])
  const changing=manager.switchAccount({principalId:'bob',epoch:2},{launches:{app:{query:{fromHost:'new'}}}})
  assert.equal(first.state.inputEnabled,false);assert.equal(second.state.inputEnabled,false)
  assert.equal(a.created[0].revoked,true);assert.equal(b.created[0].revoked,true)
  await assert.rejects(()=>first.invoke('business',{}),{code:'ERR_IDENTITY_SWITCHING'})
  const receipt=await changing;assert.equal(receipt.status,'complete')
  assert.deepEqual(a.created[1].launch,{query:{fromHost:'new'}});assert.deepEqual(b.created[1].launch,{})
  assert.notEqual(a.created[0].options.storageScope,a.created[1].options.storageScope)
  assert.ok(a.log.findIndex(([event,epoch])=>event==='revoke'&&epoch===1)<a.log.findIndex(([event,epoch])=>event==='detach'&&epoch===1))
  assert.ok(a.log.findIndex(([event,epoch])=>event==='close'&&epoch===1)<a.log.findIndex(([event,epoch])=>event==='create'&&epoch===2))
  assert.equal(manager.query(receipt.operationId).status,'complete')
})
test('failed account startup never restores old owner, retry uses latest account',async t=>{
  const manager=new BrowserHostAccountManager({principalId:'alice',epoch:1}),o=owners({failEpoch:2})
  const controller=manager.attach({application:app,createOwner:o.createOwner});t.after(()=>controller.close());await controller.ready
  const receipt=await manager.switchAccount({principalId:'bob',epoch:2})
  assert.equal(receipt.status,'failed');assert.equal(controller.state.phase,'failed');assert.equal(controller.state.inputEnabled,false)
  assert.equal(manager.account.principalId,'bob');assert.equal(o.created[0].revoked,true);assert.equal(o.created[1].revoked,true)
  await manager.switchAccount({principalId:'carol',epoch:3});assert.equal(controller.state.phase,'complete')
  assert.equal(o.created.at(-1).options.account.principalId,'carol')
})
test('latest epoch wins while a prior candidate awaits presentation',async t=>{
  const presentation={epoch:2,...deferred()},manager=new BrowserHostAccountManager({principalId:'alice',epoch:1}),o=owners({presentation})
  const controller=manager.attach({application:app,createOwner:o.createOwner});t.after(()=>controller.close());await controller.ready
  const bob=manager.switchAccount({principalId:'bob',epoch:2})
  while(!o.created.some(owner=>owner.options.account.epoch===2))await new Promise(resolve=>setImmediate(resolve))
  const carol=manager.switchAccount({principalId:'carol',epoch:3})
  // The starting owner is still executing JS while presentation is pending.
  // It must be revoked before switchAccount returns, without waiting for it.
  assert.equal(o.created.find(owner=>owner.options.account.epoch===2).revoked,true)
  presentation.resolve()
  assert.equal((await bob).status,'superseded');assert.equal((await carol).status,'complete')
  assert.equal(o.created.find(owner=>owner.options.account.epoch===2).revoked,true)
  assert.equal((await controller.invoke('state')).epoch,3)
})
test('late old-account result is rejected and same-principal credential refresh preserves owner',async t=>{
  const lateResult=deferred(),manager=new BrowserHostAccountManager({principalId:'alice',epoch:1}),o=owners({lateResult})
  const controller=manager.attach({application:app,createOwner:o.createOwner});t.after(()=>controller.close());await controller.ready
  const old=controller.invoke('login');await manager.refreshCredentials(account=>assert.equal(account.epoch,1));assert.equal(o.created.length,1)
  const switching=manager.switchAccount({principalId:'bob',epoch:2});lateResult.resolve()
  await assert.rejects(()=>old,{code:'ERR_CANCELLED'});await switching
})
test('scope framing isolates anonymous, principals, tenants and environments while retaining upgrades',()=>{
  const alice=browserStorageScope(app,{principalId:'alice'})
  assert.equal(alice,browserStorageScope({...app,version:'2',packRoot:'b'.repeat(64)},{principalId:'alice'}))
  for(const candidate of [browserStorageScope(app,{principalId:'bob'}),browserStorageScope(app,{principalId:null}),browserStorageScope({...app,tenantId:'other'},{principalId:'alice'}),browserStorageScope({...app,environment:'develop'},{principalId:'alice'})])assert.notEqual(candidate,alice)
})
test('application logout resets all its instances while other apps and host account stay live',async t=>{
  const manager=new BrowserHostAccountManager({principalId:'alice',epoch:'9007199254740993'}),a=owners(),b=owners(),other=owners()
  const first=manager.attach({application:app,createOwner:a.createOwner}),second=manager.attach({application:app,createOwner:b.createOwner}),third=manager.attach({application:{...app,appId:'other'},createOwner:other.createOwner})
  t.after(async()=>{await first.close();await second.close();await third.close()});await Promise.all([first.ready,second.ready,third.ready])
  await manager.logoutApplication(app)
  assert.equal(manager.account.principalId,'alice');assert.equal(manager.account.epoch,'9007199254740993')
  assert.equal(a.created.length,2);assert.equal(b.created.length,2);assert.equal(other.created.length,1)
  assert.equal(a.created[1].options.appAuthorized,false);assert.equal(third.state.inputEnabled,true)
  await manager.switchAccount({principalId:'bob',epoch:'9007199254740994'});assert.equal(manager.account.principalId,'bob')
})

test('late identity hooks from retired accounts and app incarnations cannot authorize or log out their replacement',async t=>{
  const manager=new BrowserHostAccountManager({principalId:'alice',epoch:'1'}),o=owners()
  const controller=manager.attach({application:app,createOwner:o.createOwner});t.after(()=>controller.close());await controller.ready
  const alice=o.created[0].options
  await manager.switchAccount({principalId:'bob',epoch:'2'})
  assert.throws(()=>alice.grantApplication(),{code:'ERR_CANCELLED'})
  assert.throws(()=>alice.requestLogout(),{code:'ERR_CANCELLED'})
  assert.equal(manager.applicationAuthorized(app),false)
  const bob=o.created[1].options;bob.grantApplication();assert.equal(manager.applicationAuthorized(app),true)
  await manager.logoutApplication(app)
  assert.throws(()=>bob.grantApplication(),{code:'ERR_CANCELLED'})
  assert.throws(()=>bob.requestLogout(),{code:'ERR_CANCELLED'})
  assert.equal(manager.applicationAuthorized(app),false);assert.equal(controller.state.inputEnabled,true)
})

test('failed close stays blocked, is shared by concurrent callers, and retries actual retained cleanup',async()=>{
  const manager=new BrowserHostAccountManager({principalId:'alice',epoch:'1'}),o=owners(),release=deferred()
  const createOwner=async options=>{
    const owner=await o.createOwner(options);let attempts=0
    owner.close=async()=>{o.log.push(['close',++attempts]);if(attempts===1){await release.promise;throw new Error('native device did not drain')}}
    return owner
  }
  const controller=manager.attach({application:app,createOwner});await controller.ready
  const closing=controller.close();assert.equal(controller.close(),closing)
  assert.equal(o.created[0].revoked,true);assert.equal(controller.state.inputEnabled,false)
  release.resolve();await assert.rejects(closing,/controller cleanup failed/)
  await assert.rejects(()=>controller.invoke('business'),{code:'ERR_IDENTITY_SWITCHING'})
  await controller.close();assert.equal(o.log.filter(([event])=>event==='close').length,2)
  await controller.close();assert.equal(o.log.filter(([event])=>event==='close').length,2)
})

test('a synchronous revoke error does not lose the owner or prevent retrying close',async()=>{
  const manager=new BrowserHostAccountManager({principalId:'alice',epoch:'1'}),o=owners()
  const controller=manager.attach({application:app,createOwner:o.createOwner});await controller.ready
  o.created[0].revoke=()=>{throw new Error('revocation transport failed')}
  await assert.rejects(()=>controller.close(),/controller cleanup failed/)
  assert.equal(o.log.filter(([event])=>event==='close').length,1)
  await controller.close();assert.equal(controller.state.phase,'closed')
})

test('account data deletion cannot run while a retired namespace has failed to drain',async t=>{
  const cleared=[],revoked=[],manager=new BrowserHostAccountManager({principalId:'alice',epoch:'1'}, {
    clearLocalData:async value=>cleared.push(value),revokeBackend:async value=>revoked.push(value),
  }),o=owners()
  let fails=true
  const controller=manager.attach({application:app,createOwner:async options=>{
    const owner=await o.createOwner(options);if(options.account.epoch==='1')owner.close=async()=>{if(fails)throw new Error('storage lease retained')};return owner
  }})
  t.after(()=>controller.close());await controller.ready
  await assert.rejects(()=>manager.deleteAccount('alice'),{code:'ERR_IDENTITY_SWITCHING'})
  await assert.rejects(()=>manager.deleteAccount('alice'),{code:'ERR_IDENTITY_SWITCHING'})
  assert.equal(cleared.length,0);assert.equal(revoked.length,0);assert.equal(controller.state.inputEnabled,false)
  fails=false;await controller.retry();await manager.deleteAccount('alice')
  assert.equal(cleared.length,1);assert.equal(revoked.length,1)
})

test('deletion includes detached applications and blocks a return to the deleting principal across backend awaits',async()=>{
  const cleared=[],backend=deferred(),entered=deferred(),manager=new BrowserHostAccountManager({principalId:'alice',epoch:'1'}, {
    clearLocalData:async value=>cleared.push(value),revokeBackend:async()=>{entered.resolve();await backend.promise},
  })
  for (const application of [app,{...app,appId:'other'}]) {
    const controller=manager.attach({application,createOwner:owners().createOwner});await controller.ready;await controller.close()
  }
  manager.grantApplication(app)
  const deleting=manager.deleteAccount('alice');await entered.promise
  assert.throws(()=>manager.switchAccount({principalId:'alice',epoch:'3'}),{code:'ERR_ACCOUNT_DELETING'})
  await assert.rejects(()=>manager.deleteAccount('alice'),{code:'ERR_ACCOUNT_DELETING'})
  await manager.switchAccount({principalId:'bob',epoch:'3'});backend.resolve();await deleting
  assert.deepEqual(cleared.map(value=>value.application.appId).sort(),['app','other'])
  assert(cleared.every(value=>value.principalId==='alice'));assert.equal(manager.account.principalId,'bob')
  await manager.switchAccount({principalId:'alice',epoch:'4'});assert.equal(manager.applicationAuthorized(app),false)
})

test('observer initiated newer epochs cannot interrupt the synchronous sibling revocation boundary',async t=>{
  const manager=new BrowserHostAccountManager({principalId:'alice',epoch:'1'}),a=owners(),b=owners()
  let newest=null
  const first=manager.attach({application:app,createOwner:a.createOwner,onState:state=>{
    if(state.operation?.epoch==='2'&&!newest)newest=manager.switchAccount({principalId:'carol',epoch:'3'})
  }})
  const second=manager.attach({application:{...app,appId:'other'},createOwner:b.createOwner})
  t.after(async()=>{await first.close();await second.close()});await Promise.all([first.ready,second.ready])
  const older=manager.switchAccount({principalId:'bob',epoch:'2'})
  assert.equal(a.created[0].revoked,true);assert.equal(b.created[0].revoked,true)
  await older;assert(newest);await newest
  assert.equal((await first.invoke('state')).epoch,'3');assert.equal((await second.invoke('state')).epoch,'3')
})

test('invalid host launch options fail before changing identity or revoking any sibling owner',async t=>{
  const manager=new BrowserHostAccountManager({principalId:'alice',epoch:'1'}),a=owners(),b=owners()
  const first=manager.attach({application:app,createOwner:a.createOwner}),second=manager.attach({application:{...app,appId:'other'},createOwner:b.createOwner})
  t.after(async()=>{await first.close();await second.close()});await Promise.all([first.ready,second.ready])
  const circular={};circular.self=circular
  let deep={};for(let depth=0;depth<65;depth++)deep={next:deep}
  class CustomLaunch { constructor(){this.route='pages/index'} }
  const invalid=[
    {query:{callback(){}}},circular,42,null,{extra:{missing:undefined}},
    {extra:{number:NaN}},{extra:{number:Infinity}},{extra:{big:1n}},
    {extra:{symbol:Symbol('invalid')}},{extra:{date:new Date(0)}},new CustomLaunch(),
    {extra:{[Symbol('key')]:'hidden'}},{extra:deep},{extra:{sparse:[,]}},
    {query:'text'},{query:null},{query:[]},{query:{count:1}},{query:{flag:false}},
    {route:''},{route:1},{scene:-1},{scene:1.5},{scene:Number.MAX_SAFE_INTEGER+1},
    {extra:[]},
  ]
  for(const options of invalid) {
    // Validate unmounted app launches too, before touching either live owner.
    const launches={app:{query:{valid:'yes'}},unmounted:options}
    assert.throws(()=>manager.switchAccount({principalId:'bob',epoch:'2'},{launches}),{code:'ERR_INVALID_REQUEST'})
    assert.equal(manager.account.principalId,'alice');assert.equal(a.created[0].revoked,false);assert.equal(b.created[0].revoked,false)
    assert.equal(first.state.inputEnabled,true);assert.equal(second.state.inputEnabled,true)
    assert.equal((await first.invoke('state')).epoch,'1');assert.equal((await second.invoke('state')).epoch,'1')
  }
})

test('launch copies preserve JSON without invoking coercion and allow reused acyclic objects',async t=>{
  const manager=new BrowserHostAccountManager({principalId:'alice',epoch:'1'}),o=owners()
  const controller=manager.attach({application:{...app,appId:'query'},createOwner:o.createOwner})
  t.after(()=>controller.close());await controller.ready
  const shared={value:'host'},query=Object.assign(Object.create(null),{from:'host'})
  const launch={route:'pages/index',scene:0,query,extra:{first:shared,second:shared,list:[null,true,1]}}
  const switching=manager.switchAccount({principalId:'bob',epoch:'2'},{launches:{query:launch}})
  query.from='mutated';shared.value='mutated';await switching
  assert.deepEqual(o.created[1].launch,{route:'pages/index',scene:0,query:{from:'host'},extra:{first:{value:'host'},second:{value:'host'},list:[null,true,1]}})
})
