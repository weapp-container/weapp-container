import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
const source = process.env.SCHEDULER_SOURCE_ROOT || new URL('../', import.meta.url).pathname
const { createAppServiceTestRealm } = await import(pathToFileURL(source + '/scripts/app-service-test-realm.mjs'))
const results = []
const caps = { 'wx.nextTick':'full', 'wx.requestIdleCallback':'full', 'wx.cancelIdleCallback':'full', 'wx.onError':'full', 'wx.offError':'full' }
function realm(engine) {
  const clock = { now: 100 }
  const r = createAppServiceTestRealm(engine, { __container_host_performance_now: () => clock.now })
  r.clock = clock
  r.install = values => r.transports.installHostEnvironment({kind:'capabilities', capabilities:{...caps,...values}})
  r.install({})
  r.run('globalThis.trace = []')
  r.command = (action, extra={}) => JSON.parse(r.transports.captureReceiverIncarnations({kind:'turn-scheduler',action,...extra}))
  r.begin = (idleBudgetMs=null, limit=64) => r.command('begin',{idleBudgetMs,limit})
  r.task = (allowIdle=false) => r.command('task',{allowIdle})
  r.end = () => r.command('end')
  r.poll = async (budget=null) => {
    await Promise.resolve(); r.begin(budget); const out=[]
    try { for(let i=0;i<64;i++){const x=r.task(budget!==null);if(!x.called)break;out.push(x);await Promise.resolve()} }
    finally {r.end()}
    return out
  }
  r.owners = () => r.run(`
    Page({}); Page({});
    __container_set_current_pages([0,1],[{index:0,instanceId:11},{index:1,instanceId:12}]);
    globalThis.page=__container_page_instances['11'];
    __container_registration_module_id='module:scheduler-component.js';
    __container_managed_component_modules[__container_registration_module_id]=true;
    globalThis.definition=Component({methods:{}}); __container_registration_module_id=null;
    globalThis.component=__container_clone_component_instance(definition,{scopeId:'scheduler-component',moduleId:'module:scheduler-component.js',pageId:11,parentScopeId:null,ownerScopeId:null});
  `)
  return r
}
const cases = [
['nextTick is void and deferred beyond current microtasks',async r=>{
 assert.equal(r.run(`wx.nextTick(function(){trace.push('tick')})`),undefined)
 r.run(`Promise.resolve().then(function(){trace.push('micro')})`);await Promise.resolve()
 assert.deepEqual(r.json('trace'),['micro']);await r.poll();assert.deepEqual(r.json('trace'),['micro','tick'])
}],
['frontier excludes nested callback registrations',async r=>{
 r.run(`wx.nextTick(function(){trace.push(1);wx.nextTick(function(){trace.push(2)})})`)
 await r.poll();assert.deepEqual(r.json('trace'),[1]);await r.poll();assert.deepEqual(r.json('trace'),[1,2])
}],
['frontier excludes callback microtask registrations',async r=>{
 r.run(`wx.nextTick(function(){trace.push(1);Promise.resolve().then(function(){wx.nextTick(function(){trace.push(2)})})})`)
 await r.poll();assert.deepEqual(r.json('trace'),[1]);await r.poll();assert.deepEqual(r.json('trace'),[1,2])
}],
['checkpoint runs between callbacks',async r=>{
 r.run(`wx.nextTick(function(){trace.push(1);Promise.resolve().then(function(){trace.push(2)})});wx.nextTick(function(){trace.push(3)})`)
 await r.poll();assert.deepEqual(r.json('trace'),[1,2,3])
}],
['idle requires an explicit real host opportunity',async r=>{
 r.run(`wx.requestIdleCallback(function(){trace.push('idle')})`);await r.poll();assert.deepEqual(r.json('trace'),[])
 await r.poll(10);assert.deepEqual(r.json('trace'),['idle'])
}],
['idle opportunity admits at most one callback',async r=>{
 r.run(`wx.requestIdleCallback(function(){trace.push(1)});wx.requestIdleCallback(function(){trace.push(2)})`)
 await r.poll(10);assert.deepEqual(r.json('trace'),[1]);await r.poll(10);assert.deepEqual(r.json('trace'),[1,2])
}],
['idle result matches GeneralCallbackResult projection',async r=>{
 r.run(`wx.requestIdleCallback(function(res){trace.push(this===globalThis,Object.keys(res),res.errMsg,Object.getPrototypeOf(res)===null)})`)
 await r.poll(10);assert.deepEqual(r.json('trace'),[true,['errMsg'],'requestIdleCallback:ok',true])
}],
['host opportunity expires before dispatch',async r=>{
 r.run(`wx.requestIdleCallback(function(){trace.push(1)})`);r.begin(10);r.clock.now=111
 assert.equal(r.task(true).called,false);r.end();assert.deepEqual(r.json('trace'),[])
}],
['host may withdraw idle permission',async r=>{
 r.run(`wx.requestIdleCallback(function(){trace.push(1)})`);r.begin(10);assert.equal(r.task(false).called,false);r.end()
 assert.deepEqual(r.json('trace'),[])
}],
['nextTick work blocks untimed idle for that poll',async r=>{
 r.run(`wx.requestIdleCallback(function(){trace.push('idle')});wx.nextTick(function(){trace.push('tick')})`)
 await r.poll(10);assert.deepEqual(r.json('trace'),['tick']);await r.poll(10);assert.deepEqual(r.json('trace'),['tick','idle'])
}],
['new nextTick work blocks idle until a later opportunity',async r=>{
 r.run(`wx.requestIdleCallback(function(){trace.push('idle')})`);r.begin(10)
 r.run(`wx.nextTick(function(){trace.push('tick')})`);assert.equal(r.task(true).called,false);r.end()
 await r.poll(10);assert.deepEqual(r.json('trace'),['tick']);await r.poll(10);assert.deepEqual(r.json('trace'),['tick','idle'])
}],
['due real timers block untimed idle',async r=>{
 r.run(`setTimeout(function(){trace.push('timer')},0);wx.requestIdleCallback(function(){trace.push('idle')})`)
 assert.deepEqual(await r.poll(10),[]);assert.deepEqual(r.json('trace'),[])
}],
['future real timers permit a host idle window',async r=>{
 r.run(`setTimeout(function(){},1000000);wx.requestIdleCallback(function(){trace.push('idle')})`)
 await r.poll(10);assert.deepEqual(r.json('trace'),['idle'])
}],
['timeout fallback runs without claiming idle',async r=>{
 r.run(`setTimeout(function(){},0);wx.requestIdleCallback(function(){trace.push('timeout')},{timeout:5})`)
 r.clock.now=105;const out=await r.poll();assert.deepEqual(r.json('trace'),['timeout']);assert.equal(out[0].timedOut,true)
}],
['timeout is monotonic and not Date.now based',async r=>{
 r.run(`wx.requestIdleCallback(function(){trace.push(1)},{timeout:5});Date.now=function(){return 9007199254740991}`)
 await r.poll();assert.deepEqual(r.json('trace'),[]);r.clock.now=105;await r.poll();assert.deepEqual(r.json('trace'),[1])
}],
['cancellation is void and removes only the selected idle task',async r=>{
 r.run(`globalThis.first=wx.requestIdleCallback(function(){trace.push(1)});wx.requestIdleCallback(function(){trace.push(2)})`)
 assert.equal(r.run('wx.cancelIdleCallback(first)'),undefined);await r.poll(10);assert.deepEqual(r.json('trace'),[2])
}],
['guessed idle ID cannot cancel nextTick',async r=>{
 r.run(`wx.nextTick(function(){trace.push('tick')});wx.cancelIdleCallback(1)`);await r.poll();assert.deepEqual(r.json('trace'),['tick'])
}],
['IDs are monotonic across cancellation',async r=>{
 assert.equal(r.run(`globalThis.first=wx.requestIdleCallback(function(){});wx.cancelIdleCallback(first);wx.requestIdleCallback(function(){})>first`),true)
}],
['invalid callback options and IDs reject finitely',async r=>{
 for(const code of ['wx.nextTick(null)','wx.requestIdleCallback(null)','wx.requestIdleCallback(function(){},null)','wx.requestIdleCallback(function(){},{timeout:-1})','wx.requestIdleCallback(function(){},{timeout:Infinity})','wx.cancelIdleCallback(0)','wx.cancelIdleCallback("1")'])assert.throws(()=>r.run(code))
 assert.deepEqual(await r.poll(),[])
}],
['capability publication keeps producers Partial and cancellation at its own grade',async r=>{
 assert.deepEqual(r.json(`['wx.nextTick','wx.requestIdleCallback','wx.cancelIdleCallback'].map(function(n){return __container_capabilities[n]})`),['partial','partial','full'])
}],
['capability revocation drops work without revival',async r=>{
 r.run(`wx.nextTick(function(){trace.push(1)});wx.requestIdleCallback(function(){trace.push(2)})`)
 r.install({'wx.nextTick':'unsupported','wx.requestIdleCallback':'unsupported'});r.install({});await r.poll(10);assert.deepEqual(r.json('trace'),[])
}],
['cancel admission is independent of registration admission',async r=>{
 r.run(`globalThis.id=wx.requestIdleCallback(function(){trace.push(1)})`);r.install({'wx.cancelIdleCallback':'unsupported'})
 assert.throws(()=>r.run('wx.cancelIdleCallback(id)'));await r.poll(10);assert.deepEqual(r.json('trace'),[1])
}],
['hide suspends and show resumes',async r=>{
 r.run(`wx.nextTick(function(){trace.push(1)})`);r.transports.dispatchLifecycleNotification('hide',{});await r.poll();assert.deepEqual(r.json('trace'),[])
 r.transports.dispatchLifecycleNotification('show',{});await r.poll();assert.deepEqual(r.json('trace'),[1])
}],
['terminal realm retirement never revives',async r=>{
 r.run(`wx.nextTick(function(){trace.push(1)})`);r.transports.dispatchLifecycleNotification('retire',{});r.install({});r.transports.dispatchLifecycleNotification('show',{})
 await r.poll(10);assert.deepEqual(r.json('trace'),[]);assert.throws(()=>r.run('wx.nextTick(function(){})'))
}],
['actual Page owner drops pending work on unload',async r=>{
 r.owners();r.run(`page.schedule=function(){wx.nextTick(function(){trace.push(1)})};__container_invoke_page_instance(11,0,'schedule',[]);__container_invoke_page_instance(11,0,'onUnload',[])`)
 await r.poll();assert.deepEqual(r.json('trace'),[])
}],
['Page replacement does not revive old incarnation work',async r=>{
 r.owners();r.run(`page.schedule=function(){wx.requestIdleCallback(function(){trace.push(1)})};__container_invoke_page_instance(11,0,'schedule',[]);__container_invoke_page_instance(11,0,'onUnload',[]);delete __container_page_instances['11'];__container_set_current_pages([0],[{index:0,instanceId:11}])`)
 await r.poll(10);assert.deepEqual(r.json('trace'),[])
}],
['actual component owner drops pending work on detach',async r=>{
 r.owners();r.run(`component.methods.schedule=function(){wx.nextTick(function(){trace.push(1)})};__container_invoke_component(component.__container_component_index,'schedule',[]);__container_unmount_component(component.__container_component_index)`)
 await r.poll();assert.deepEqual(r.json('trace'),[])
}],
['private owner propagation survives mutable public aliases',async r=>{
 r.owners();r.run(`__container_run_with_api_owner=function(owner,thunk){return thunk()};__container_capture_api_owner=function(){return null};page.schedule=function(){wx.nextTick(function(){trace.push(1)})};__container_invoke_page_instance(11,0,'schedule',[]);__container_invoke_page_instance(11,0,'onUnload',[])`)
 await r.poll();assert.deepEqual(r.json('trace'),[])
}],
['session work has no latest-page ownership fallback',async r=>{
 r.owners();r.run(`wx.nextTick(function(){trace.push(1)});__container_invoke_page_instance(11,0,'onUnload',[]);__container_invoke_page_instance(12,1,'onUnload',[])`)
 await r.poll();assert.deepEqual(r.json('trace'),[1])
}],
['native retained driver and readiness are absent from globals',async r=>{
 assert.deepEqual(r.json(`['__container_turn_scheduler','__container_scheduler_timer_ready','__receiver_capture'].map(function(n){return typeof globalThis[n]})`),['undefined','undefined','undefined'])
}],
['callback errors report once and do not strand later tasks',async r=>{
 r.run(`wx.onError(function(){trace.push('error')});wx.nextTick(function(){throw new Error('scheduler test')});wx.nextTick(function(){trace.push('after')})`)
 await r.poll();assert.deepEqual(r.json('trace'),['error','after'])
}],
['captured intrinsics resist guest prototype poisoning',async r=>{
 r.run(`wx.requestIdleCallback(function(){trace[0]='idle'});Reflect.apply=function(){throw 1};Object.getOwnPropertyDescriptor=function(){throw 2};Object.defineProperty=function(){throw 3};WeakMap.prototype.get=function(){throw 4};Map.prototype.values=function(){throw 5};Number.isFinite=function(){throw 6}`)
 await r.poll(10);assert.equal(r.run('trace[0]'),'idle')
}],
['native monotonic clock alias replacement cannot manufacture timeout',async r=>{
 r.run(`wx.requestIdleCallback(function(){trace.push(1)},{timeout:5});__container_host_performance_now=function(){return 100000}`)
 await r.poll();assert.deepEqual(r.json('trace'),[]);r.clock.now=105;await r.poll();assert.deepEqual(r.json('trace'),[1])
}],
['finite per-poll budget preserves backlog',async r=>{
 r.run(`for(var i=0;i<65;i++)wx.nextTick(function(){trace.push(1)})`);assert.equal((await r.poll()).length,64);assert.equal(r.run('trace.length'),64);await r.poll();assert.equal(r.run('trace.length'),65)
}],
['pending queue bound recovers after cancellations',async r=>{
 assert.equal(r.run(`globalThis.ids=[];for(var i=0;i<1024;i++)ids.push(wx.requestIdleCallback(function(){}));true`),true)
 assert.throws(()=>r.run('wx.nextTick(function(){})'))
 r.run(`for(var i=0;i<ids.length;i++)wx.cancelIdleCallback(ids[i]);wx.nextTick(function(){trace.push(1)})`);await r.poll();assert.deepEqual(r.json('trace'),[1])
}],
['option getter reentrancy cannot restore revoked admission',async r=>{
 r.context.revoke=()=>r.install({'wx.requestIdleCallback':'unsupported'})
 assert.throws(()=>r.run(`wx.requestIdleCallback(function(){trace.push(1)},new Proxy({timeout:0},{get:function(target,key){revoke();return Reflect.get(target,key)}}))`))
 r.install({});await r.poll(10);assert.deepEqual(r.json('trace'),[])
}],
['documented timeout getter is read once through its prototype',async r=>{
 r.run(`globalThis.reads=0;const prototype={get timeout(){reads++;return 5}};wx.requestIdleCallback(function(){trace.push('due')},Object.create(prototype))`)
 assert.equal(r.run('reads'),1);await r.poll();assert.deepEqual(r.json('trace'),[]);r.clock.now=105;await r.poll();assert.deepEqual(r.json('trace'),['due']);assert.equal(r.run('reads'),1)
}],
['throwing documented timeout getter publishes no task',async r=>{
 assert.throws(()=>r.run(`wx.requestIdleCallback(function(){trace.push(1)},{get timeout(){throw Error('option getter')}})`));await r.poll(10);assert.deepEqual(r.json('trace'),[])
}],
['timeout-due work still obeys frozen frontier' ,async r=>{
 r.run(`wx.requestIdleCallback(function(){trace.push(1);wx.requestIdleCallback(function(){trace.push(2)},{timeout:0})},{timeout:0})`)
 await r.poll();assert.deepEqual(r.json('trace'),[1]);await r.poll();assert.deepEqual(r.json('trace'),[1,2])
}],
['idle cancellation from earlier microtask wins',async r=>{
 r.run(`globalThis.id=wx.requestIdleCallback(function(){trace.push('idle')},{timeout:0});wx.nextTick(function(){Promise.resolve().then(function(){wx.cancelIdleCallback(id)})})`)
 await r.poll();assert.deepEqual(r.json('trace'),[])
}],
]
for(const engine of ['quickjs','v8'])for(const [name,check] of cases){
 try{await check(realm(engine));results.push({engine,name,status:'pass'})}
 catch(error){results.push({engine,name,status:'fail',error:String(error?.stack||error)})}
}
const report={source,total:results.length,passed:results.filter(x=>x.status==='pass').length,failed:results.filter(x=>x.status==='fail').length,results}
console.log(JSON.stringify(report,null,2))
if(report.failed)process.exitCode=1
