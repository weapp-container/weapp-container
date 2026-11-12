/** Explicit synthetic provider for source/IPC contracts only. */
import { createHash } from 'node:crypto'
import { descriptor } from './issue941-descriptor.mjs'
import { createCollector } from './issue941-collector.mjs'
export const plan=descriptor.plans[0],method=plan.steps[1]
const names=plan.steps[2].queries.slice(0,21).map(query=>query.selector.slice('#issue941-'.length))
export const directResult=()=>({resultMethods:names.slice(0,14).map(name=>({name,sameIdentity:true,isPromise:false})),voidMethods:names.slice(14).map(name=>({name,isUndefined:true,isPromise:false})),cacheManagerOptions:['maxSize']})
export const staticInputs=()=>({caseId:descriptor.caseId,sourceSha256:descriptor.sourceSha256,files:descriptor.compiledFiles.map(path=>{const bytes=Buffer.from('synthetic existence');return{path,bytes,length:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}})})
export function checkpointGroups(id) {
 const step=plan.steps.find(step=>step.id===id)
 return step.queries.map(query=>{const count=query.selector==='.issue941-result'?(id==='initial'?0:14):query.selector==='.issue941-void'?(id==='initial'?0:7):1
  const text=query.selector==='#issue941-title'?'issue-941 direct-return adapter':query.selector==='#issue941-cache-options'?'cache options: '+(id==='initial'?'pending':'maxSize'):query.selector.slice('#issue941-'.length)+(names.slice(0,14).includes(query.selector.slice('#issue941-'.length))?': identity preserved, promise no':': undefined yes, promise no')
  return {...query,fields:undefined,count,nodes:Array.from({length:count},()=>query.fields.text?{text}:{}),query:'css'}
 }).map(({fields,...value})=>value)
}
export function fixture({onMethod,nested=false}={}) {
 let stamp=1000;const calls=[],events=[]
 const result=directResult()
 const page={path:plan.route,pageId:17,async waitForRendered(){return true},async callMethod(name,...args){calls.push({op:'callMethod',receiver:this,name,args});return onMethod?await onMethod({receiver:this,name,args}):result},async callMethodWithOptions(name,options,...args){calls.push({op:'callMethodWithOptions',receiver:this,name,options,args});if(nested)return await this.callMethod(name,...args);return onMethod?await onMethod({receiver:this,name,options,args}):result}}
 const program={async reLaunch(){return page},async currentPage(){return page}},collector=createCollector({clock:()=>stamp,emit:event=>events.push({...structuredClone(event),seq:events.length})});collector.attach(program)
 const checkpoint=id=>collector.checkpoint({evidence:{id,route:plan.route,nodes:checkpointGroups(id)}},{session:program,page})
 return{page,program,collector,calls,events,result,checkpoint,setClock:value=>{stamp=value},start:async()=>{await program.reLaunch('/'+plan.route);checkpoint('initial')},trace:()=>({caseId:descriptor.caseId,oracle:'wechat-devtools',run:{status:'passed'},events,assertions:[{id:plan.fullName,passed:true}]})}
}
