import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'

const source=await readFile(new URL('../examples/hosts/harmony/entry/src/main/ets/session/HostAccountManager.ts',import.meta.url),'utf8')
const {HarmonyHostAccountManager,harmonyStorageScope}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source,{mode:'strip'})).toString('base64'))
const application={hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'app',environment:'release',version:'1',packRoot:'a'.repeat(64)}
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
async function until(predicate){for(let index=0;index<100;index++){if(predicate())return;await settle()}assert.fail('expected finite owner state did not arrive')}

function owners({presentation,lateResult,failEpoch,creation,wrongIdentity=false,unpresented=false}={}){
  const created=[],log=[]
  const createOwner=async context=>{
    log.push(['create',context.account.epoch]);if(creation?.epoch===context.account.epoch)await creation.promise
    const value={context,revoked:false,runnable:false,failClose:false,closes:0,detaches:0}
    value.session={
      executionIdentity:()=>({sessionId:wrongIdentity?'foreign':context.sessionId,hostIdentity:{application:context.application,account:context.account}}),
      revokeIdentity(){value.revoked=true;value.runnable=false;log.push(['revoke',context.account.epoch])},
      detachSurface(){value.detaches++;log.push(['detach',context.account.epoch])},
      async closeAndDrain(){value.closes++;log.push(['close',context.account.epoch]);if(value.closeGate)await value.closeGate;if(value.failClose)throw new Error('native storage lease retained')},
      start(){log.push(['start',context.account.epoch]);if(context.account.epoch===failEpoch)throw new Error('startup failed')},
      isRunnable:()=>value.runnable,
    }
    value.waitForPresentation=async cancellation=>{if(presentation?.epoch===context.account.epoch)await presentation.promise;if(!cancellation.cancelled&&!unpresented)value.runnable=true;log.push(['present',context.account.epoch])}
    value.invoke=async()=>{if(lateResult)await lateResult.promise;return {epoch:context.account.epoch}}
    created.push(value);return value
  }
  return {created,log,createOwner}
}

test('Harmony shared epoch synchronously gates every stable controller before old-owner drain and fresh host launch',async t=>{
  const manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'}),first=owners(),second=owners()
  const a=manager.attach({application,createOwner:first.createOwner,launchOptions:{query:{private:'alice'}}}),b=manager.attach({application:{...application,appId:'other'},createOwner:second.createOwner})
  t.after(async()=>{await a.close();await b.close()});await Promise.all([a.ready,b.ready]);const release=deferred();first.created[0].closeGate=release.promise
  const switching=manager.switchAccount({principalId:'bob',epoch:'2'},{app:{query:{fromHost:'bob'}}})
  assert.equal(a.state.inputEnabled,false);assert.equal(b.state.inputEnabled,false);assert.equal(first.created[0].revoked,true);assert.equal(second.created[0].revoked,true)
  await assert.rejects(a.invoke('business'),{code:'ERR_IDENTITY_SWITCHING'});await settle();assert.equal(first.created.length,1)
  release.resolve();const receipt=await switching;assert.equal(receipt.status,'complete');assert.equal(manager.query(receipt.operationId).status,'complete');assert.equal(a.query(receipt.operationId).phase,'complete')
  assert.deepEqual(first.created[1].context.launchOptions,{query:{fromHost:'bob'}});assert.deepEqual(second.created[1].context.launchOptions,{})
  assert.notEqual(first.created[0].context.sessionId,first.created[1].context.sessionId);assert.notEqual(first.created[0].context.storageScope,first.created[1].context.storageScope)
  assert.ok(first.log.findIndex(([kind,epoch])=>kind==='close'&&epoch==='1')<first.log.findIndex(([kind,epoch])=>kind==='create'&&epoch==='2'))
})

test('Harmony account identity uses exact u64 strings and scope survives legal package upgrades',()=>{
  const manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'9007199254740993'})
  assert.throws(()=>manager.switchAccount({principalId:'bob',epoch:'9007199254740992'}),{code:'ERR_STALE_ACCOUNT_EPOCH'})
  assert.throws(()=>new HarmonyHostAccountManager({principalId:'alice',epoch:'18446744073709551616'}),/u64/)
  assert.throws(()=>new HarmonyHostAccountManager({principalId:'alice',epoch:'01'}),/u64/)
  const scope=harmonyStorageScope(application,{principalId:'alice',epoch:'1'})
  assert.equal(scope,harmonyStorageScope({...application,version:'2',packRoot:'b'.repeat(64)},{principalId:'alice',epoch:'9'}))
  for(const principalId of ['bob',null])assert.notEqual(scope,harmonyStorageScope(application,{principalId,epoch:'1'}))
  for(const field of ['hostAppId','tenantId','publisherId','appId','environment'])assert.notEqual(scope,harmonyStorageScope({...application,[field]:'other'},{principalId:'alice',epoch:'1'}))
})

test('Harmony latest epoch immediately revokes an awaiting-presentation candidate and records superseded terminal history',async t=>{
  const presentation={epoch:'2',...deferred()},manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'}),o=owners({presentation})
  const controller=manager.attach({application,createOwner:o.createOwner});t.after(()=>controller.close());await controller.ready
  const bob=manager.switchAccount({principalId:'bob',epoch:'2'});await until(()=>controller.state.phase==='awaitingPresentation')
  const operation=controller.state.operation.operationId,carol=manager.switchAccount({principalId:'carol',epoch:'3'})
  assert.equal(o.created[1].revoked,true);assert.equal(controller.state.inputEnabled,false);presentation.resolve()
  assert.equal((await bob).status,'superseded');assert.equal((await carol).status,'complete');assert.equal(controller.query(operation).phase,'superseded');assert.equal((await controller.invoke('state')).epoch,'3')
})

test('Harmony late factory completion is retired before startup and failed new identity never restores the old one',async t=>{
  const creation={epoch:'2',...deferred()},manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'}),o=owners({creation,failEpoch:'3'})
  const controller=manager.attach({application,createOwner:o.createOwner});t.after(()=>controller.close());await controller.ready
  const bob=manager.switchAccount({principalId:'bob',epoch:'2'});await until(()=>o.log.some(([kind,epoch])=>kind==='create'&&epoch==='2'))
  const carol=manager.switchAccount({principalId:'carol',epoch:'3'});creation.resolve();assert.equal((await bob).status,'superseded');assert.equal((await carol).status,'failed')
  assert.equal(o.log.some(([kind,epoch])=>kind==='start'&&epoch==='2'),false);assert.equal(o.created[0].revoked,true);assert.equal(o.created[1].revoked,true);assert.equal(o.created[2].revoked,true);assert.equal(controller.state.inputEnabled,false);assert.equal(manager.account.principalId,'carol')
  await manager.switchAccount({principalId:'dana',epoch:'4'});assert.equal(controller.state.inputEnabled,true)
})

test('Harmony app logout rebuilds its instances only, gates old hooks, and same-user refresh preserves sessions',async t=>{
  const manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'}),a=owners(),b=owners(),other=owners()
  const first=manager.attach({application,createOwner:a.createOwner}),second=manager.attach({application,createOwner:b.createOwner}),third=manager.attach({application:{...application,appId:'other'},createOwner:other.createOwner})
  t.after(async()=>{await first.close();await second.close();await third.close()});await Promise.all([first.ready,second.ready,third.ready]);const old=a.created[0].context
  old.grantApplication();assert.equal(manager.applicationAuthorized(application),true);await manager.refreshCredentials(async(account,current)=>{assert.equal(account.principalId,'alice');assert.equal(current(),true)});assert.equal(a.created.length,1)
  const receipt=await old.requestLogout({query:{fresh:'logout'}});assert.equal(receipt.status,'complete');assert.equal(a.created.length,2);assert.equal(b.created.length,2);assert.equal(other.created.length,1);assert.equal(manager.account.principalId,'alice');assert.equal(manager.account.epoch,'1')
  assert.equal(a.created[1].context.appAuthorized,false);assert.deepEqual(a.created[1].context.launchOptions,{query:{fresh:'logout'}});assert.throws(()=>old.grantApplication(),{code:'ERR_CANCELLED'});assert.throws(()=>old.requestLogout(),{code:'ERR_CANCELLED'})
  const bob=manager.switchAccount({principalId:'bob',epoch:'2'});assert.throws(()=>a.created[1].context.grantApplication(),{code:'ERR_CANCELLED'});await bob
})

test('Harmony old async invoke and credential refresh results reject after account replacement',async t=>{
  const late=deferred(),refresh=deferred(),manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'}),o=owners({lateResult:late})
  const controller=manager.attach({application,createOwner:o.createOwner});t.after(()=>controller.close());await controller.ready
  const result=controller.invoke('login'),refreshing=manager.refreshCredentials(async()=>{await refresh.promise});await manager.switchAccount({principalId:'bob',epoch:'2'});late.resolve();refresh.resolve()
  await assert.rejects(result,{code:'ERR_CANCELLED'});await assert.rejects(refreshing,{code:'ERR_CANCELLED'})
})

test('Harmony failed retirement blocks replacement and retry releases the retained exact owner',async t=>{
  const manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'}),o=owners(),controller=manager.attach({application,createOwner:o.createOwner});t.after(()=>controller.close());await controller.ready
  o.created[0].failClose=true;const receipt=await manager.switchAccount({principalId:'bob',epoch:'2'});assert.equal(receipt.status,'failed');assert.equal(o.created.length,1);assert.equal(controller.state.inputEnabled,false)
  await assert.rejects(controller.invoke('business'),{code:'ERR_IDENTITY_SWITCHING'});o.created[0].failClose=false;assert.equal((await controller.retry()).phase,'complete');assert.equal(o.created[0].closes,2);assert.equal(o.created.length,2)
})

test('Harmony failed close shares the in-flight Promise and retries retained native cleanup',async()=>{
  const manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'}),o=owners(),controller=manager.attach({application,createOwner:o.createOwner});await controller.ready
  o.created[0].failClose=true;const closing=controller.close();assert.equal(controller.close(),closing);await assert.rejects(closing,/requires retry/);assert.equal(controller.state.inputEnabled,false)
  o.created[0].failClose=false;await controller.close();await controller.close();assert.equal(o.created[0].closes,2)
})

test('Harmony cancelled presentation remains blocked until explicit retry and never restores the old account',async t=>{
  const presentation={epoch:'2',...deferred()},manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'}),o=owners({presentation})
  const controller=manager.attach({application,createOwner:o.createOwner});t.after(()=>controller.close());await controller.ready
  const changing=manager.switchAccount({principalId:'bob',epoch:'2'});await until(()=>controller.state.phase==='awaitingPresentation');assert.equal(controller.cancel(),true);assert.equal(o.created[1].revoked,true);presentation.resolve();assert.equal((await changing).status,'failed');assert.equal(controller.state.phase,'failed');assert.equal(controller.state.inputEnabled,false)
  assert.equal((await controller.retry()).phase,'complete');assert.equal(manager.account.principalId,'bob')
})

test('Harmony deleted principal cannot be restored during backend revoke and closed app scopes are also deleted',async()=>{
  const gate=deferred(),cleared=[],revoked=[],manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'9007199254740993'},{async revokeBackend(id){revoked.push(id);await gate.promise},async clearLocalData(app,id,scope){cleared.push({app,id,scope})}}),o=owners()
  const controller=manager.attach({application,createOwner:o.createOwner});await controller.ready;await controller.close()
  const deleting=manager.deleteAccount('alice');assert.equal(manager.deleteAccount('alice'),deleting);await until(()=>revoked.length===1);assert.throws(()=>manager.switchAccount({principalId:'alice',epoch:'9007199254740995'}),{code:'ERR_IDENTITY_SWITCHING'});gate.resolve();await deleting
  assert.equal(manager.account.epoch,'9007199254740994');assert.equal(manager.account.principalId,null);assert.equal(cleared.length,1);assert.equal(cleared[0].app.appId,'app');assert.equal(cleared[0].id,'alice')
})

test('Harmony account deletion cannot bypass a failed old namespace and has no default no-op backend',async t=>{
  const cleared=[],manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'},{async revokeBackend(){cleared.push('backend')},async clearLocalData(){cleared.push('disk')}}),o=owners(),controller=manager.attach({application,createOwner:o.createOwner});t.after(()=>controller.close());await controller.ready
  o.created[0].failClose=true;await assert.rejects(manager.deleteAccount('alice'),{code:'ERR_IDENTITY_SWITCHING'});await assert.rejects(manager.deleteAccount('alice'),{code:'ERR_IDENTITY_SWITCHING'});assert.deepEqual(cleared,[])
  o.created[0].failClose=false;await controller.retry();await manager.deleteAccount('alice');assert.deepEqual(cleared,['backend','disk'])
  const absent=new HarmonyHostAccountManager({principalId:null,epoch:'1'});assert.throws(()=>absent.deleteAccount('alice'),/explicit backend/)
})

test('Harmony refuses a wrong native incarnation or a presentation waiter with no acknowledged drawable',async()=>{
  for(const options of [{wrongIdentity:true},{unpresented:true}]){const manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'}),o=owners(options),controller=manager.attach({application,createOwner:o.createOwner});assert.equal((await controller.ready).phase,'failed');assert.equal(controller.state.inputEnabled,false);assert.equal(o.created[0].revoked,true);await controller.close()}
})

test('Harmony reentrant state observers cannot replace a sibling with an older epoch',async t=>{
  const manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'}),a=owners(),b=owners();let newer=null
  const first=manager.attach({application,createOwner:a.createOwner,onState:state=>{if(state.operation?.epoch==='2'&&state.phase==='revoking'&&newer===null)newer=manager.switchAccount({principalId:'carol',epoch:'3'})}}),second=manager.attach({application:{...application,appId:'other'},createOwner:b.createOwner})
  t.after(async()=>{await first.close();await second.close()});await Promise.all([first.ready,second.ready]);await manager.switchAccount({principalId:'bob',epoch:'2'});if(newer!==null)await newer
  assert.equal((await first.invoke('state')).epoch,'3');assert.equal((await second.invoke('state')).epoch,'3');assert.equal(manager.account.epoch,'3')
})

test('Harmony malformed launch data fails before changing the shared epoch or revoking any sibling',async t=>{
  const manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'}),o=owners(),controller=manager.attach({application,createOwner:o.createOwner,initialSessionId:'explicit-smoke-session'})
  t.after(()=>controller.close());await controller.ready;assert.equal(o.created[0].context.sessionId,'explicit-smoke-session');const circular={};circular.extra=circular
  assert.throws(()=>manager.attach({application:{...application,appId:'malformed'},createOwner:o.createOwner,launchOptions:circular}),/circular/i);
  assert.throws(()=>manager.switchAccount({principalId:'bob',epoch:'2'},{app:circular}),/circular/i);assert.equal(manager.account.epoch,'1');assert.equal(o.created[0].revoked,false);assert.equal(controller.state.inputEnabled,true);await manager.switchAccount({principalId:'bob',epoch:'2'});assert.equal(o.created.length,2)
})


test('Harmony rejects every malformed launch field before any shared identity mutation',async t=>{
  const manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'}),a=owners(),b=owners(),first=manager.attach({application,createOwner:a.createOwner}),second=manager.attach({application:{...application,appId:'other'},createOwner:b.createOwner})
  t.after(async()=>{await first.close();await second.close()});await Promise.all([first.ready,second.ready])
  const invalid=[null,1,'route',[],{route:undefined},{route:1},{query:'query'},{query:{n:1}},{query:null},{scene:NaN},{scene:Infinity},{scene:1.5},{scene:-1},{extra:()=>{}},{extra:{callback:()=>{}}},{extra:{lost:undefined}},{extra:{value:Symbol('value')}},{extra:{value:1n}},{extra:{value:NaN}},{extra:new Date()},{extra:[]}]
  for(const launch of invalid){
    assert.throws(()=>manager.attach({application,createOwner:a.createOwner,launchOptions:launch}),{code:'ERR_INVALID_REQUEST'})
    assert.throws(()=>manager.switchAccount({principalId:'bob',epoch:'2'},{app:{},other:launch}),{code:'ERR_INVALID_REQUEST'})
    assert.throws(()=>manager.logoutApplication(application,launch),{code:'ERR_INVALID_REQUEST'})
    assert.equal(manager.account.epoch,'1');assert.equal(a.created[0].revoked,false);assert.equal(b.created[0].revoked,false);assert.equal(first.state.inputEnabled,true);assert.equal(second.state.inputEnabled,true)
  }
  for(const launches of [null,[],2,{unknown:{query:{invalid:false}}},{unknown:undefined}])assert.throws(()=>manager.switchAccount({principalId:'bob',epoch:'2'},launches),{code:'ERR_INVALID_REQUEST'})
  await manager.switchAccount({principalId:'bob',epoch:'2'},{app:{query:{id:'bob'},extra:{list:[null,true,7,'value']}}});assert.equal(a.created.length,2);assert.equal(b.created.length,2)
})
