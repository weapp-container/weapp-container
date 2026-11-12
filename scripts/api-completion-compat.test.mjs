import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'
const root=process.env.NEXTTICK_SOURCE_ROOT || new URL('../',import.meta.url).pathname
const {createAppServiceTestRealm}=await import(pathToFileURL(root+'/scripts/app-service-test-realm.mjs'))
const results=[]
for(const engine of ['quickjs','v8'])for(const mode of ['ticket-success','ticket-failure','legacy-success','legacy-failure','local-failure'])for(const throws of ['none','primary','complete']){
 const name=`${mode}, throws=${throws}: preserve callback receiver/order/error isolation/Promise settlement after unload`
 const failed=mode.includes('failure'),primary=failed?'fail':'success'
 try{
  const outcome=failed?{status:'failure',error:{errMsg:'getSystemInfo:fail test'}}:{status:'success',result:{errMsg:'getSystemInfo:ok'}}
  const r=createAppServiceTestRealm(engine,{__container_host_api_delivery_claim:()=>JSON.stringify(outcome)})
  r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.getSystemInfo':mode==='local-failure'?'unsupported':'partial'}})
  r.run(`globalThis.trace=[];globalThis.receivers=[];Page({});__container_set_current_pages([0],[{index:0,instanceId:11}]);globalThis.page=__container_page_instances['11'];page.request=function(){const options={success:function(value){'use strict';trace.push('success');receivers.push(this===options);globalThis.primaryValue=value;${throws==='primary'?"throw Error('primary')":''}},fail:function(value){'use strict';trace.push('fail');receivers.push(this===options);globalThis.primaryValue=value;${throws==='primary'?"throw Error('primary')":''}},complete:function(value){'use strict';trace.push('complete');receivers.push(this===options);globalThis.sameValue=primaryValue===value;${throws==='complete'?"throw Error('complete')":''}}};wx.getSystemInfo(options).then(function(value){trace.push('resolved');globalThis.sameSettlement=primaryValue===value},function(value){trace.push('rejected');globalThis.sameSettlement=primaryValue===value})};__container_invoke_page_instance(11,0,'request',[]);__container_invoke_page_instance(11,0,'onUnload',[])`)
  if(mode!=='local-failure'){
   const id=r.run(`__container_events.filter(x=>x.type==='api.call').slice(-1)[0].id`)
   if(mode.startsWith('ticket'))r.run(`__container_resolve_api(${id},null,null,'native-test-ticket')`)
   else if(failed)r.run(`__container_resolve_api(${id},null,{errMsg:'getSystemInfo:fail test'})`)
   else r.run(`__container_resolve_api(${id},{errMsg:'getSystemInfo:ok'},null)`)
  }
  for(let i=0;i<4;i++)await Promise.resolve()
  assert.deepEqual(r.json('trace'),[primary,'complete',failed?'rejected':'resolved']);assert.deepEqual(r.json('receivers'),[true,true]);assert.equal(r.run('sameValue && sameSettlement'),true);assert.equal(r.run('__container_errors.length'),throws==='none'?1*(mode==='local-failure'):1+1*(mode==='local-failure'))
  results.push({engine,name,status:'pass'})
 }catch(error){results.push({engine,name,status:'fail',error:String(error.stack||error)})}
}
for(const engine of ['quickjs','v8']){
 const name='native retired ticket keeps callback and Promise admission unchanged'
 try{
 const r=createAppServiceTestRealm(engine,{__container_host_api_delivery_claim:()=>'{"status":"retired"}'})
 r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.getSystemInfo':'partial'}})
 r.run(`globalThis.trace=[];wx.getSystemInfo({success:()=>trace.push('success'),fail:()=>trace.push('fail'),complete:()=>trace.push('complete')}).then(()=>trace.push('resolved'),()=>trace.push('rejected'));__container_resolve_api(1,null,null,'retired-ticket')`)
 for(let i=0;i<4;i++)await Promise.resolve();assert.deepEqual(r.json('trace'),[]);results.push({engine,name,status:'pass'})
 }catch(error){results.push({engine,name,status:'fail',error:String(error.stack||error)})}
}
const report={source:root,total:results.length,passed:results.filter(x=>x.status==='pass').length,failed:results.filter(x=>x.status==='fail').length,results};console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1
