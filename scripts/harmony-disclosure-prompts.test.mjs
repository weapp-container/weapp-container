import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

const base=await readFile(new URL('../examples/hosts/harmony/entry/src/main/ets/session/HostServices.ts',import.meta.url),'utf8');
const owner=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(base,{mode:'strip'})).toString('base64'));
const source=(await readFile(new URL('../examples/hosts/harmony/entry/src/main/ets/session/DisclosurePrompts.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
globalThis.__harmonyDisclosureOwner=owner;
const {HarmonyDisclosurePrompts}=await import('data:text/javascript;base64,'+Buffer.from('const {HarmonyApiError}=globalThis.__harmonyDisclosureOwner;\n'+stripTypeScriptTypes(source,{mode:'strip'})).toString('base64'));
delete globalThis.__harmonyDisclosureOwner;
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const policy={kind:'phone',purpose:'Booking contact',permissionVersion:'9'};
const call=()=>({cancellation:new owner.HarmonyCallCancellation(),context:{sessionId:'session',callId:'phone',api:'weappContainer.identity.authorizePhone',application:{appId:'trusted-app',publisherId:'trusted-publisher'},account:{principalId:'alice',epoch:'1'}}});
function fixture(t,options={}){
  const handles=[];
  const services=new owner.HarmonyHostServices({hostServices:()=>'{"ok":true}'});
  const driver={create(model,decide,dismiss){const handle={model,decide,dismiss,shows:0,closes:0,async show(){this.shows++;if(options.open)await options.open.promise;},async close(){this.closes++;if(options.failClose)throw new Error('exact dialog still exists');if(options.close)await options.close.promise;}};handles.push(handle);return handle;}};
  const prompts=new HarmonyDisclosurePrompts(services,driver);
  t.after(async()=>{options.failClose=false;options.open?.resolve();options.close?.resolve();services.revoke();await services.retryResourceCleanup();await services.waitForDrain();});
  return {prompts,handles,services};
}

test('Harmony disclosure returns a decision only after exact native disappearance/disposal acknowledgment',async t=>{
  const close=deferred(),f=fixture(t,{close}),answer=f.prompts.confirm(policy,call());let value='pending';answer.then(result=>value=result);
  await settle();const handle=f.handles[0];assert.deepEqual(handle.model,{appId:'trusted-app',publisherId:'trusted-publisher',...policy});
  handle.decide(true);handle.decide(false);await settle();assert.equal(handle.closes,1);assert.equal(value,'pending');
  close.resolve();assert.equal(await answer,true);handle.decide(false);assert.equal(handle.closes,1);
});

test('Harmony account retirement closes UI acquired after cancellation and waits actual disappearance',async t=>{
  const open=deferred(),close=deferred(),f=fixture(t,{open,close}),owned=call();
  const answer=f.prompts.confirm(policy,owned);const outcome=answer.catch(error=>error);
  await settle();assert.equal(f.handles[0].shows,1);f.services.revoke();let drained=false;
  const drain=f.services.waitForDrain().then(()=>drained=true);await settle();assert.equal(drained,false);assert.equal(f.handles[0].closes,0);
  open.resolve();await settle();assert.equal(f.handles[0].closes,1);f.handles[0].decide(true);
  assert.equal((await outcome).category,'cancelled');assert.equal(drained,false);
  const other=fixture(t);await assert.rejects(other.prompts.confirm(policy,call()),/another identity disclosure/);
  close.resolve();await drain;assert.equal(drained,true);
  const next=other.prompts.confirm(policy,call());await settle();other.handles[0].decide(false);assert.equal(await next,false);
});

test('Harmony failed native dialog cleanup retains the exact handle and process lease until a real retry succeeds',async t=>{
  const options={failClose:true},f=fixture(t,options),owned=call(),answer=f.prompts.confirm(policy,owned),outcome=answer.catch(error=>error);
  await settle();f.handles[0].decide(true);assert.match((await outcome).message,/exact dialog/);
  f.services.revoke();await assert.rejects(f.services.waitForDrain(),/failed to stop/);assert.equal(f.handles.length,1);
  const other=fixture(t);await assert.rejects(other.prompts.confirm(policy,call()),/another identity disclosure/);
  options.failClose=false;await f.services.retryResourceCleanup();assert.equal(f.handles.length,1);assert(f.handles[0].closes>=3);
  const next=other.prompts.confirm(policy,call());await settle();other.handles[0].decide(false);assert.equal(await next,false);
});

test('Harmony prompt creation revoked before its first executor turn never displays an old-account dialog',async t=>{
  const f=fixture(t),owned=call(),answer=f.prompts.confirm(policy,owned),outcome=answer.catch(error=>error);
  owned.cancellation.cancel();await owned.cancellation.waitForDrain();assert.equal((await outcome).category,'cancelled');assert.equal(f.handles[0].shows,0);assert.equal(f.handles[0].closes,1);
});
