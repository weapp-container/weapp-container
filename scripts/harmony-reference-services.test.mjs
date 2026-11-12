import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {HostServices} from '../tools/host-services-reference/src/service.mjs';
import {referenceSignature} from '../tools/host-services-reference/src/crypto.mjs';

// Production ArkTS protocol owner + production SQLite account/order service.
// Finite transport/consent/wallet callbacks exercise lifecycle only; official
// platform HTTP/UI compilation and physical/merchant acceptance are separate.
const base=await readFile(new URL('../examples/hosts/harmony/entry/src/main/ets/session/HostServices.ts',import.meta.url),'utf8');
const owner=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(base,{mode:'strip'})).toString('base64'));
const source=(await readFile(new URL('../examples/hosts/harmony/entry/src/main/ets/session/ReferenceHostServices.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
globalThis.__harmonyReferenceOwner=owner;
const {HarmonyReferenceIdentity,HarmonyReferencePayments}=await import('data:text/javascript;base64,'+Buffer.from('const {HarmonyApiError,HarmonyCallCancellation}=globalThis.__harmonyReferenceOwner;\n'+stripTypeScriptTypes(source,{mode:'strip'})).toString('base64'));
delete globalThis.__harmonyReferenceOwner;
const root='a'.repeat(64),clientSecret='backend-only-client-secret-'.repeat(3),callbackSecret='backend-only-reference-callback-'.repeat(3);
const policies={profile:{purpose:'Display a chosen public profile',permissionVersion:'3'},phone:{purpose:'Contact this app\'s booking customer',permissionVersion:'7'}};
const config={application:{hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'first',environment:'develop',version:'1',packRoot:root},account:{principalId:'alice',epoch:'9007199254740993'}};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
class NativeTransport {
  commands=[];requests=[];
  hostServices(json){const command=JSON.parse(json);this.commands.push(command);if(command.operation==='protocol')return '{"version":"1.0","trustedContext":true,"ownerThreadCompletion":true}';if(command.operation==='configure')return '{"ok":true,"sessionId":"session"}';if(command.operation==='take')return JSON.stringify({requests:this.requests.splice(0)});return '{"ok":true}';}
  call(callId,method,payload={},configuration=config){this.requests.push({kind:'call',callId,method,payload,context:{...configuration,sessionId:'session',callId,api:method}});}
  complete(id){return this.commands.find(value=>value.operation==='complete'&&value.payload.callId===id)?.payload;}
}
async function fixture(t,{decision=()=>true,logout=()=>{},payment,configuration=config}={}){
  const service=new HostServices({database:':memory:',issuerSecret:'issuer-secret-'.repeat(4),identitySecret:'identity-secret-'.repeat(4),
    applications:['first','second'].map(miniAppId=>({miniAppId,identityProtocol:'1.0',clientId:miniAppId+'-backend',clientSecret,hostAppId:'host',tenantId:'tenant',environment:'develop',trustedPackRoots:[root],authorizationPolicies:structuredClone(policies),allowedPaymentChannels:['reference']})),payments:{reference:{callbackSecret}}});
  const host=service.issueHostSession({hostAppId:'host',tenantId:'tenant',environment:'develop',principalId:'alice',principalEpoch:config.account.epoch,profile:{nickName:'Alice',avatarUrl:'https://example.test/avatar',secret:'never-disclose'},phone:'+8613800000000'}).hostAccessToken;
  const requests=[],prompts=[];
  const backend={closed:false,
    async request(path,body,call){assert.equal(this.closed,false);assert.equal(call.cancellation.cancelled,false);requests.push({path,body:structuredClone(body),context:structuredClone(call.context)});
      switch(path){
        case '/v1/host/identity-state':return service.identityState(host,body);
        case '/v1/host/login-codes':return service.loginCode(host,body);
        case '/v1/host/check-session':return service.checkSession(host,body);
        case '/v1/host/authorization-policy':return service.authorizationPolicy(host,body);
        case '/v1/host/consents':return service.setConsent(host,body);
        case '/v1/host/phone-codes':return service.phoneCode(host,body);
        case '/v1/host/profile':return service.hostProfile(host,body);
        case '/v1/host/app-logout':return service.logoutAppForHost(host,body);
        default:{const order=/^\/v1\/payments\/orders\/([A-Za-z0-9-]+)\/launch$/.exec(path);assert(order,path);return service.launchForHost(host,order[1],body);}
      }
    },async close(){this.closed=true;},
  };
  const native=new NativeTransport(),services=new owner.HarmonyHostServices(native),identity=new HarmonyReferenceIdentity(services,backend,{confirm:async(policy,call)=>{prompts.push(structuredClone(policy));return decision(policy,call);},logoutApplication:logout});
  if(payment)new HarmonyReferencePayments(services,backend,[{channel:'reference',product:'app',kind:'reference',pay:payment}]);
  await identity.prepare(configuration);services.configure(configuration,root);
  t.after(async()=>{services.revoke();await services.waitForDrain();service.close();});
  const pump=async()=>{services.drain();await settle();services.drain();};
  const invoke=async(id,api,payload={})=>{native.call(id,api,payload,configuration);await pump();return native.complete(id);};
  const app=()=>service.exchangeLogin('first-backend',clientSecret,service.loginCode(host,{miniAppId:'first',packRoot:root}).code).accessToken;
  const order=()=>service.createOrder(app(),{idempotencyKey:'payment-'+requests.length,channel:'reference',product:'app',amount:125,currency:'CNY',description:'Reference checkout'});
  const notify=order=>{const raw=JSON.stringify({eventId:'event-'+order.orderId,merchantOrderId:order.merchantOrderId,amount:order.amount,currency:order.currency,miniAppId:'first',transactionId:'tx-'+order.orderId,status:'paid'}),timestamp=String(Math.floor(Date.now()/1000));service.notification('reference',{'x-reference-timestamp':timestamp,'x-reference-signature':referenceSignature(callbackSecret,timestamp,raw)},raw);};
  return {service,host,backend,requests,prompts,native,services,identity,pump,invoke,app,order,notify};
}

test('Harmony identity preflight prepares a synchronous scoped snapshot and real codes remain app-only/single-use',async t=>{
  const f=await fixture(t);
  const configured=f.native.commands.find(value=>value.operation==='configure').payload;
  assert.equal(configured.syncValues['weappContainer.identity.getState'].hostLoggedIn,true);
  assert.equal(configured.syncValues['weappContainer.identity.getState'].appLoggedIn,false);
  assert(configured.apis.includes('component:button.open-type.getPhoneNumber'));
  assert(!configured.apis.includes('wx.getPhoneNumber'));
  const login=await f.invoke('login','wx.login'),code=login.result.code;
  assert.throws(()=>f.service.exchangeLogin('second-backend',clientSecret,code),error=>error.code==='invalid_code');
  const redeemed=f.service.exchangeLogin('first-backend',clientSecret,code);assert(redeemed.appUserId);
  assert.throws(()=>f.service.exchangeLogin('first-backend',clientSecret,code),error=>error.code==='invalid_code');
  assert((await f.invoke('check','wx.checkSession')).result.valid);
  assert.equal(f.requests[1].body.expectedPrincipalEpoch,'9007199254740993');
  assert(!JSON.stringify(f.native.commands).includes(f.host));assert(!JSON.stringify(f.native.commands).includes(clientSecret));
});

test('Harmony registered profile/phone policies ignore guest descriptions and disclose only authorized public data/codes',async t=>{
  const f=await fixture(t);f.app();
  const before=await f.invoke('denied-profile','wx.getUserInfo');assert(before.error);
  const profile=await f.invoke('profile','wx.getUserProfile',{desc:'guest supplied different purpose'});
  assert.deepEqual(f.prompts[0],{kind:'profile',...policies.profile});
  assert.deepEqual(profile.result,{userInfo:{nickName:'Alice',avatarUrl:'https://example.test/avatar'}});
  assert.equal(f.service.identityState(f.host,{miniAppId:'first',packRoot:root}).phoneAuthorized,false);
  const phone=await f.invoke('phone','weappContainer.identity.authorizePhone',{purpose:'guest-payload'});
  assert.deepEqual(f.prompts[1],{kind:'phone',...policies.phone});assert(phone.result.code);assert.equal(phone.result.phoneNumber,undefined);
  assert.deepEqual(f.service.exchangePhone('first-backend',clientSecret,phone.result.code),{phoneNumber:'+8613800000000'});
  assert(!JSON.stringify(f.native.commands).includes('+8613800000000'));
  const snapshot=f.native.commands.filter(value=>value.operation==='snapshots').at(-1).payload['weappContainer.identity.getState'];
  assert.equal(snapshot.profileAuthorized,true);assert.equal(snapshot.phoneAuthorized,true);assert.equal(snapshot.userInfo,undefined);
});

test('Harmony refusal records revocation and stale server policy cannot be granted or yield phone codes',async t=>{
  let grant=true;const f=await fixture(t,{decision:()=>grant});f.app();
  const phone=await f.invoke('first','weappContainer.identity.authorizePhone');assert(phone.result.code);
  grant=false;const denial=await f.invoke('refusal','weappContainer.identity.authorizePhone');assert.equal(denial.error.code,'permission_denied');
  assert.throws(()=>f.service.exchangePhone('first-backend',clientSecret,phone.result.code),error=>error.code==='consent_required');
  const original=f.backend.request.bind(f.backend);f.backend.request=async(path,body,call)=>{
    const result=await original(path,body,call);
    if(path==='/v1/host/authorization-policy')f.service.apps.get('first').authorizationPolicies.phone.permissionVersion='new-version';
    return result;
  };grant=true;
  const stale=await f.invoke('stale-policy','weappContainer.identity.authorizePhone');assert(stale.error);
  assert.equal(f.requests.filter(value=>value.path==='/v1/host/phone-codes').length,1);
});

test('Harmony revoked owner waits a late real backend operation but never publishes its result or writes a snapshot',async t=>{
  const f=await fixture(t);let finish;
  const gate=new Promise(resolve=>finish=resolve),original=f.backend.request.bind(f.backend);
  f.backend.request=async(path,body,call)=>{const result=await original(path,body,call);if(path==='/v1/host/login-codes')await gate;return result;};
  f.native.call('late','wx.login');await f.pump();f.services.revoke();let drained=false;
  const drain=f.services.waitForDrain().then(()=>drained=true);await settle();assert.equal(drained,false);finish();await drain;
  assert.equal(f.native.complete('late'),undefined);assert.equal(f.native.commands.filter(value=>value.operation==='snapshots').length,0);
});

test('Harmony anonymous preparation exposes accurate state without asking a token provider for credentials',async t=>{
  const f=await fixture(t,{configuration:{...config,account:{principalId:null,epoch:'1'}}});
  assert.equal(f.requests.length,0);assert.equal(f.native.commands.find(value=>value.operation==='configure').payload.syncValues['weappContainer.identity.getState'].hostLoggedIn,false);
  assert.equal((await f.invoke('anonymous-login','wx.login')).error.code,'permission_denied');assert.equal(f.requests.length,0);
});

test('Harmony identity subscriptions only enqueue and app logout invokes its execution boundary after backend revocation',async t=>{
  let restarted=0;const f=await fixture(t,{logout:()=>{assert.equal(f.service.identityState(f.host,{miniAppId:'first',packRoot:root}).appLoggedIn,false);restarted++;}});f.app();
  await f.invoke('listen','weappContainer.identity.onChange',{subscriptionId:'identity'});
  await f.invoke('login','wx.login');assert(f.native.commands.some(value=>value.operation==='event'&&value.payload.event==='IdentityChange'));
  await f.invoke('logout','weappContainer.identity.logout');assert.equal(restarted,1);assert.equal(f.service.host(f.host).scope.principalId,'alice');
  assert.equal((await f.invoke('check-after-logout','wx.checkSession')).error.code,'invalid_request');
});

test('Harmony payment rejects guest signatures and wallet success waits for a signed backend result',async t=>{
  let terminal;const wallet=new Promise(resolve=>terminal=resolve);
  const f=await fixture(t,{payment:async()=>wallet});t.after(()=>terminal());const order=await f.order();
  assert.equal((await f.invoke('signature','weappContainer.payment.request',{orderId:order.orderId,paySign:'guest'})).error.code,'invalid_request');
  f.native.call('pay','weappContainer.payment.request',{orderId:order.orderId});await f.pump();assert.equal(f.native.complete('pay'),undefined);
  f.notify(order);terminal();await f.pump();assert.deepEqual(f.native.complete('pay').result,{orderId:order.orderId,serverConfirmed:true});
  assert.equal(f.service.getOrder(f.app(),order.orderId).status,'paid');
});

test('Harmony cancelled payment frees JS retirement while reserving the old process wallet callback until terminal',async t=>{
  let finishOld;const oldWallet=new Promise(resolve=>finishOld=resolve);
  const old=await fixture(t,{payment:async()=>oldWallet});t.after(()=>finishOld());const oldOrder=await old.order();
  old.native.call('old-pay','weappContainer.payment.request',{orderId:oldOrder.orderId});await old.pump();old.services.revoke();await old.services.waitForDrain();assert.equal(old.native.complete('old-pay'),undefined);
  let newCalls=0;const fresh=await fixture(t,{payment:async()=>{newCalls++;}}),freshOrder=await fresh.order();
  assert.match((await fresh.invoke('busy','weappContainer.payment.request',{orderId:freshOrder.orderId})).error.message,/another official payment UI/);
  assert.equal(newCalls,0);old.notify(oldOrder);finishOld();await settle();assert.equal(old.native.complete('old-pay'),undefined);
  fresh.notify(freshOrder);assert.equal((await fresh.invoke('server-paid','weappContainer.payment.request',{orderId:freshOrder.orderId})).result.serverConfirmed,true);assert.equal(newCalls,0);
});

test('Harmony unconfigured payment channels advertise no payment calls',()=>{
  const native=new NativeTransport(),services=new owner.HarmonyHostServices(native);
  new HarmonyReferencePayments(services,{async request(){throw new Error('unreachable');},async close(){}},[]);
  assert(!services.supportedApis().includes('wx.requestPayment'));assert(!services.supportedApis().includes('weappContainer.payment.request'));
  services.revoke();
});
