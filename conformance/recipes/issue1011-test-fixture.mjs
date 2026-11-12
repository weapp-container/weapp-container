/** Controlled synthetic provider, never official/native execution evidence. */
import { createHash } from 'node:crypto'
import { descriptor } from './issue1011-descriptor.mjs'
import { createCollector } from './issue1011-collector.mjs'
import { expectedSnapshot, expectedDomCheckpoints } from './issue1011-source-assertions.mjs'
import { tapElement } from './issue1011-tap-source.mjs'
export const plan=descriptor.plans[0],poll=plan.steps.find(step=>step.kind==='method.poll'),tapSteps=plan.steps.filter(step=>step.kind==='tap')
export const pollOptions={timeoutMs:10000,intervalMs:50,matcher:'toEqual'}
export const staticInputs=()=>({caseId:descriptor.caseId,sourceSha256:descriptor.sourceSha256,files:descriptor.compiledFiles.map(path=>{
 const bytes=Buffer.from(path==='app.json'?JSON.stringify({pages:[plan.route]}):'synthetic file existence')
 return{path,bytes,length:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
})})
export const checkpointGroups=id=>expectedDomCheckpoints.find(step=>step.id===id).nodes.map(({selector,...fields})=>({selector,query:'css',count:1,nodes:[structuredClone(fields)]}))
export function fixture({onOperation,onWait,onMethod,onQuery,nestedMethod=false}={}){
 let clock=1000,methodAt=0;const calls=[],events=[],elements=new Map()
 const page={path:plan.route,pageId:17,async waitForRendered(){return true},async waitFor(ms){calls.push({op:'waitFor',ms});if(onWait)return await onWait({ms,setClock:value=>{clock=value}});clock+=ms},
  async $(selector){calls.push({op:'$',selector,args:[...arguments]});if(onQuery)return await onQuery({selector,element:element(selector),receiver:this});return element(selector)},
  async $$(selector){calls.push({op:'$$',selector});return [element(selector)]},
  async callMethod(name,...args){calls.push({op:'callMethod',name,args});return onMethod?await onMethod({name,args,at:methodAt++,setClock:value=>{clock=value}}):structuredClone(expectedSnapshot)},
  async callMethodWithOptions(name,options,...args){calls.push({op:'callMethodWithOptions',name,options,args});if(nestedMethod)return await this.callMethod(name,...args);return onMethod?await onMethod({name,options,args,at:methodAt++,setClock:value=>{clock=value}}):structuredClone(expectedSnapshot)}}
 function element(selector){if(!elements.has(selector)){
  const value={id:'duplicate-public-id'}
  for(const operation of ['tap','trigger','touchstart','touchend','dispatchEvent'])value[operation]=async function(...args){calls.push({op:operation,selector,args});if(onOperation)return await onOperation({operation,selector,args,receiver:this})}
  elements.set(selector,value)
 }return elements.get(selector)}
 const program={async reLaunch(){return page},async currentPage(){return page}},collector=createCollector({clock:()=>clock,emit:event=>events.push({...structuredClone(event),seq:events.length})});collector.attach(program)
 const checkpoint=id=>collector.checkpoint({evidence:{id,route:plan.route,nodes:checkpointGroups(id)}},{session:program,page})
 return{page,program,collector,calls,events,element,checkpoint,setClock:value=>{clock=value},start:async()=>{await program.reLaunch('/'+plan.route);await page.waitForRendered({selector:descriptor.pageRootReadiness.selector,timeout:descriptor.pageRootReadiness.timeoutMs});checkpoint('initial')},
  taps:async()=>{for(const step of tapSteps)await tapElement(page,step.address.selector)},
  poll:async()=>collector.sourcePoll(pollOptions,async()=>page.callMethodWithOptions('_snapshot',{timeout:5000})),
  finish:()=>{checkpoint('captured');collector.flush()},trace:()=>({caseId:descriptor.caseId,oracle:'wechat-devtools',run:{status:'passed'},events,assertions:[{id:plan.fullName,passed:true}]})}
}
