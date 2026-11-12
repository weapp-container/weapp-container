import assert from 'node:assert/strict';
import {createRequire,stripTypeScriptTypes} from 'node:module';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildManifest} from '../../tools/container-manifest/src/index.mjs';
import {HostServices} from '../../tools/host-services-reference/src/service.mjs';

const native=createRequire(import.meta.url)(process.argv[2]),owner=native.createOwner();
const base=await readFile(new URL('../../examples/hosts/harmony/entry/src/main/ets/session/HostServices.ts',import.meta.url),'utf8');
const classes=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(base,{mode:'strip'})).toString('base64'));
globalThis.__harmonyActualReference=classes;
const reference=(await readFile(new URL('../../examples/hosts/harmony/entry/src/main/ets/session/ReferenceHostServices.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
const {HarmonyReferenceIdentity}=await import('data:text/javascript;base64,'+Buffer.from('const {HarmonyApiError,HarmonyCallCancellation}=globalThis.__harmonyActualReference;\n'+stripTypeScriptTypes(reference,{mode:'strip'})).toString('base64'));
delete globalThis.__harmonyActualReference;
const directory=await mkdtemp(join(tmpdir(),'weapp-harmony-reference-js-'));
let service,services;
try{
  await mkdir(join(directory,'pages'));
  await writeFile(join(directory,'app.json'),JSON.stringify({pages:['pages/index']}));
  await writeFile(join(directory,'app.js'),'App({});');
  await writeFile(join(directory,'pages/index.js'),`
    const state={order:[],code:null,promiseCode:null,phone:null};
    Page({onPhone(e){state.phone=e.detail;}});
    exports.begin=()=>{
      state.initial=weappContainer.identity.getState();
      wx.login({success:r=>{state.code=r.code;state.order.push('success');},complete:()=>state.order.push('complete')});
      wx.login().then(r=>{state.promiseCode=r.code;state.order.push('promise');});
      return {value:true};
    };
    exports.read=()=>({value:state});
    exports.capability=()=>({value:[typeof wx.getPhoneNumber,wx.canIUse('button.open-type.getPhoneNumber')]});
  `);
  const built=await buildManifest(directory),manifest=built.manifest,packRoot=manifest.integrity.root;
  const accepted=JSON.parse(owner.loadManifestWithConfig(JSON.stringify(manifest),JSON.stringify({engine:'quickjs',session_id:'harmony-reference'})));
  assert.equal(accepted.ok,true,JSON.stringify(accepted));
  const application={hostAppId:'host',tenantId:'tenant',publisherId:'verified-native-installation',appId:'app',environment:'develop',version:'1',packRoot};
  const account={principalId:'alice',epoch:'9007199254740993'},clientSecret='confidential-business-backend-'.repeat(3);
  service=new HostServices({database:':memory:',identitySecret:'host-identity-secret-'.repeat(3),issuerSecret:'issuer-secret-'.repeat(3),applications:[{miniAppId:'app',identityProtocol:'1.0',clientId:'app-backend',clientSecret,hostAppId:'host',tenantId:'tenant',environment:'develop',trustedPackRoots:[packRoot],authorizationPolicies:{phone:{purpose:'Booking contact',permissionVersion:'4'}}}]});
  const token=service.issueHostSession({hostAppId:'host',tenantId:'tenant',environment:'develop',principalId:'alice',principalEpoch:account.epoch,phone:'+8613800000000'}).hostAccessToken;
  const seen=[];
  const backend={async request(path,selection,call){seen.push({path,selection,context:call.context});
    switch(path){
      case '/v1/host/identity-state':return service.identityState(token,selection);
      case '/v1/host/login-codes':return service.loginCode(token,selection);
      case '/v1/host/authorization-policy':return service.authorizationPolicy(token,selection);
      case '/v1/host/consents':return service.setConsent(token,selection);
      case '/v1/host/phone-codes':return service.phoneCode(token,selection);
      default:throw new Error('Unexpected native backend path '+path);
    }
  },async close(){}};
  services=new classes.HarmonyHostServices(owner);
  const identity=new HarmonyReferenceIdentity(services,backend,{confirm:async policy=>{assert.deepEqual(policy,{kind:'phone',purpose:'Booking contact',permissionVersion:'4'});return true;},logoutApplication:()=>{throw new Error('Not used by this probe');}});
  await identity.prepare({application,account});services.configure({application,account},packRoot);
  let sequence=0;
  const dispatch=(op,payload)=>{
    const result=JSON.parse(owner.dispatch(JSON.stringify({protocolVersion:'1.0',sessionId:'harmony-reference',requestId:String(++sequence),kind:'request',op,payload})));
    assert.notEqual(result.ok,false,JSON.stringify(result));assert(!result.messages?.some(message=>message.op==='error'||message.payload?.ok===false),JSON.stringify(result));return result;
  };
  const page=manifest.modules.find(module=>module.id.includes('pages/index.js'));assert(page);
  const call=name=>dispatch('module.call',{moduleId:page.id,export:name,args:[]}).messages[0].payload.result[0].value;
  dispatch('app.init',{modules:manifest.modules.map(module=>({id:module.id,source:built.blobs.get(module.sha256).toString('utf8')})),
    blobs:Object.fromEntries([...built.blobs].map(([hash,bytes])=>['sha256:'+hash,[...bytes]]))});
  dispatch('app.lifecycle',{event:'launch'});dispatch('page.push',{path:'pages/index'});
  assert.deepEqual(call('capability'),['undefined',true]);call('begin');assert.equal(call('read').code,null);
  const pump=async()=>{for(let index=0;index<8;index++){services.drain();await new Promise(resolve=>setImmediate(resolve));}};
  await pump();const state=call('read');assert(state.code);assert(state.promiseCode);assert.notEqual(state.code,state.promiseCode);
  assert(state.order.indexOf('success')<state.order.indexOf('complete'));assert(state.order.includes('promise'));
  assert.equal(state.initial.hostLoggedIn,true);assert.equal(state.initial.appLoggedIn,false);
  assert(seen.every(request=>request.context.account.epoch===account.epoch&&request.context.application.packRoot===packRoot));
  assert(seen.filter(request=>request.context.sessionId!=='native-preflight').every(request=>request.context.sessionId==='harmony-reference'));
  service.exchangeLogin('app-backend',clientSecret,state.code);
  assert.throws(()=>service.exchangeLogin('app-backend',clientSecret,state.code),error=>error.code==='invalid_code');
  dispatch('render.commit',{frameId:1,viewport:{x:0,y:0,width:100,height:100},root:{id:'root',bounds:{x:0,y:0,width:100,height:100},opacity:1,children:[{id:'phone',tag:'button',attributes:{'open-type':'getPhoneNumber',bindgetphonenumber:'onPhone'},dataset:{action:'booking'},bounds:{x:0,y:0,width:50,height:30},opacity:1,children:[]}]}});
  dispatch('event.batch',{events:[{type:'tap',x:10,y:10}]});await pump();const phone=call('read').phone;
  assert(phone?.code,JSON.stringify(phone));assert.equal(phone.errMsg,'getPhoneNumber:ok');
  assert.deepEqual(service.exchangePhone('app-backend',clientSecret,phone.code),{phoneNumber:'+8613800000000'});
  assert(!JSON.stringify(call('read')).includes(token));assert(!JSON.stringify(call('read')).includes(clientSecret));assert(!JSON.stringify(call('read')).includes('+8613800000000'));
  console.log(JSON.stringify({passed:true,classification:'actual-node-napi-arkts-quickjs-and-sqlite-identity',
    assertions:['public wx.login callback and Promise through native transport','trusted accepted pack and exact u64 account context','single-use app-scoped backend code','real button tap to host phone consent to JS getphonenumber event','no invented wx.getPhoneNumber','no host bearer, phone or confidential client exposed'],
    packRoot,graphics:'not-invoked',nativePermissionUI:'finite-callback-only',harmonyDevice:'not-run'}));
}finally{
  if(services){services.revoke();await services.waitForDrain();}owner.destroy();if(service)service.close();await rm(directory,{recursive:true,force:true});
}
