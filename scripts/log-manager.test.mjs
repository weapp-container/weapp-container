import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

const names = ['wx.getLogManager', ...['debug','info','log','warn'].map(x=>'object:LogManager.'+x)]
const policy = (overrides={}) => ({kind:'capabilities',capabilities:Object.assign(Object.fromEntries(names.map(x=>[x,'partial'])),overrides)})
function fixture(engine, writer) {
 const records=[]
 let nativeAlive=true
 const realm=createAppServiceTestRealm(engine,{__container_host_log_manager_write: text=>{
  if(text===undefined)return nativeAlive
  if(writer)return writer(text,records)
  if(text)records.push(JSON.parse(text))
  return !!text
 }})
 realm.transports.installHostEnvironment(policy())
 return {...realm,records,retireNative(){nativeAlive=false}}
}
function argument(record,index=0){return record.arguments.nodes[record.arguments.roots[index]]}
for(const engine of ['quickjs','v8']){
 test(`${engine}: factory and four methods require independent trusted admission, without defaults`,()=>{
  const r=fixture(engine)
  r.transports.installHostEnvironment({kind:'capabilities',capabilities:{}})
  assert.throws(()=>r.run('wx.getLogManager()'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
  r.run(`__container_capabilities['wx.getLogManager']='full'`)
  assert.throws(()=>r.run('wx.getLogManager()'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
  r.transports.installHostEnvironment(policy({'object:LogManager.info':'unsupported'}))
  r.run('globalThis.logger=wx.getLogManager({level:1})')
  for(const level of ['debug','log','warn'])assert.equal(r.run(`logger.${level}('${level}')`),undefined)
  assert.throws(()=>r.run('logger.info(1)'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
  assert.deepEqual(r.records.map(x=>x.level),['debug','log','warn'])
  r.transports.installHostEnvironment(policy({'wx.getLogManager':'unsupported'}))
  r.run(`__container_capabilities['wx.getLogManager']='full';__container_capabilities['object:LogManager.info']='full'`)
  assert.throws(()=>r.run('logger.log(1)'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
 })
 for(const kind of ['capabilities','environment'])test(`${engine}: ${kind} trusted withdrawal survives hostile guest array iteration`,()=>{
  const r=fixture(engine)
  r.run(`globalThis.logger=wx.getLogManager({level:1});Array.prototype[Symbol.iterator]=function(){return {next(){return {done:true}}}}`)
  const snapshot=kind==='capabilities'?{kind,capabilities:{}}:{version:'1.0',capabilities:{},syncApiValues:{},syncApiErrors:{},storage:null,files:null,domQuery:false}
  assert.equal(r.transports.installHostEnvironment(snapshot),true)
  assert.throws(()=>r.run('logger.log("late")'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
  assert.throws(()=>r.run('wx.getLogManager()'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
  assert.equal(r.records.length,0)
 })
 test(`${engine}: native terminal owner fences borrowed methods and repeated trusted grants without a guest retirement callback`,()=>{
  const r=fixture(engine)
  r.run(`globalThis.logger=wx.getLogManager({level:1})`)
  r.retireNative()
  for(let i=0;i<2;i++){
   assert.equal(r.transports.installHostEnvironment(policy()),true)
   assert.throws(()=>r.run('logger.log("late")'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
   assert.throws(()=>r.run('wx.getLogManager()'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
  }
  assert.equal(r.records.length,0)
 })
 test(`${engine}: nested Map Set and ArrayBuffer budget failures reject atomically`,()=>{
  const r=fixture(engine)
  r.run(`const logger=wx.getLogManager({level:1});logger.log(new Map([[1,Symbol('x'.repeat(500000))]]));logger.log(new Set([Symbol('x'.repeat(500000))]));logger.log(new ArrayBuffer(102401));logger.log('tail')`)
  assert.equal(r.records.length,1)
  assert.equal(argument(r.records[0]).value,'tail')
 })
 test(`${engine}: explicit logs preserve more than sixteen arguments and a 50KiB value`,()=>{
  const r=fixture(engine)
  r.run(`wx.getLogManager({level:1}).log('x'.repeat(51200),...Array.from({length:32},(_,i)=>i))`)
  const [record]=r.records
  assert.equal(record.source,'logManager');assert.equal(record.arguments.roots.length,33)
  assert.equal(argument(record).value.length,51200)
  assert.equal(argument(record,32).value,31)
  assert.equal(record.kind,'explicit')
  assert.equal(r.run('typeof __container_host_log_manager_write'), 'undefined')
  assert.equal(r.run('typeof __container_log_manager_instrument'), 'undefined')
  assert.equal(r.run('typeof __container_log_manager'), 'undefined')
 })
 test(`${engine}: cycles, duplicate identities, holes, BigInt, symbols and accessors do not invoke guest code`,()=>{
  const r=fixture(engine)
  r.run(`let reads=0;const cyclic={get bad(){reads++;throw 1},toJSON(){throw 2}};cyclic.self=cyclic;
   const sparse=[];sparse[3]=cyclic;const symbol=Symbol('tag');
   wx.getLogManager({level:1}).warn(cyclic,cyclic,sparse,12n,symbol,symbol,undefined,NaN,-0);globalThis.reads=reads`)
  assert.equal(r.run('reads'),0)
  const g=r.records[0].arguments
  assert.equal(g.roots[0],g.roots[1]);assert.equal(g.roots[4],g.roots[5])
  const root=argument(r.records[0]);assert(root.properties.some(x=>x.accessor&&x.get))
  assert.equal(argument(r.records[0],2).type,'array')
  assert.equal(argument(r.records[0],3).value,'12')
  assert.equal(argument(r.records[0],4).description,'tag')
  assert.equal(argument(r.records[0],6).type,'undefined')
  assert.equal(argument(r.records[0],7).value,'NaN')
  assert.equal(argument(r.records[0],8).value,'-0')
 })
 test(`${engine}: Unicode is retained and the projected UTF8 wire budget rejects oversize logs atomically`,()=>{
  const r=fixture(engine)
  r.run(`globalThis.logger=wx.getLogManager({level:1});logger.log('汉字😀\\uD800','\\uDC00');logger.log('汉'.repeat(35000));logger.log('tail')`)
  assert.equal(r.records.length,2)
  assert.deepEqual(argument(r.records[0]).value,{utf16:'6c495b57d83dde00d800'})
  assert.deepEqual(argument(r.records[0],1).value,{utf16:'dc00'})
  assert.equal(argument(r.records[1]).value,'tail')
  assert(r.records.every(x=>Buffer.byteLength(JSON.stringify(x.arguments))<=102400))
 })
 test(`${engine}: oversized symbol descriptions reject before projection and leave later records healthy`,()=>{
  const r=fixture(engine)
  r.run(`const logger=wx.getLogManager({level:1});logger.log(Symbol('x'.repeat(500000)));logger.log('tail')`)
  assert.equal(r.records.length,1);assert.equal(argument(r.records[0]).value,'tail')
 })
 test(`${engine}: captured graph primitives survive hostile JSON and prototype replacements`,()=>{
  const r=fixture(engine)
  r.run(`globalThis.logger=wx.getLogManager({level:1});
   Object.prototype.toJSON=function(){throw 1};Array.prototype.toJSON=function(){throw 2};
   String.prototype.charCodeAt=function(){throw 3};JSON.stringify=function(){throw 4};
   Object.getOwnPropertyDescriptor=function(){throw 5};Reflect.ownKeys=function(){throw 6};
   logger.log(new Map([['key',{value:7}]]),'intact')`)
  assert.equal(r.records.length,1);assert.equal(argument(r.records[0]).type,'map');assert.equal(argument(r.records[0],1).value,'intact')
 })
 test(`${engine}: level zero records genuine App/Page hooks and core wx calls, level one excludes automatic producers`,()=>{
  const r=fixture(engine)
  r.run(`globalThis.order=[];App({onShow:function(x){order.push('app:'+x);return 17}});Page({onLoad:function(x){order.push('page:'+x);return 23}});
   wx.getLogManager();globalThis.appResult=__container_invoke_app('onShow',['a']);globalThis.pageResult=__container_invoke_page(0,'onLoad',['p']);wx.canIUse('wx.getLogManager');
   __container_invoke_app('missing',[]);__container_invoke_page(0,'missing',[])`)
  assert.deepEqual(r.json('order'),['app:a','page:p']);assert.equal(r.run('appResult'),17);assert.equal(r.run('pageResult'),23)
  assert.deepEqual(r.records.map(x=>[x.kind,x.name]),[['lifecycle','App.onShow'],['lifecycle','Page.onLoad'],['api','wx.canIUse']])
  r.run(`wx.getLogManager({level:1});__container_invoke_app('onShow',['b']);wx.canIUse('x');wx.getLogManager({level:1}).debug('explicit')`)
  assert.equal(r.records.length,4);assert.equal(r.records[3].kind,'explicit')
 })
 test(`${engine}: installed wx wrappers preserve this, arguments, returns, throws and single canIUse instrumentation`,()=>{
  const r=fixture(engine)
  r.run(`wx.getLogManager();globalThis.receiver={tag:7};globalThis.failure={same:true};
   wx.probe=function(a,b){if(a==='fail')throw failure;return [this===receiver,a,b]};
   __container_install_host_services({apis:[],objectApis:[]});__container_install_host_services({apis:[],objectApis:[]});
   globalThis.probeResult=wx.probe.call(receiver,1,2);try{wx.probe('fail')}catch(e){globalThis.same=e===failure};wx.canIUse('x')`)
  assert.deepEqual(r.json('probeResult'),[true,1,2]);assert.equal(r.run('same'),true)
  assert.equal(r.records.filter(x=>x.name==='wx.probe').length,2)
  assert.equal(r.records.filter(x=>x.name==='wx.canIUse').length,1)
 })
 test(`${engine}: stale direct and counterpart descriptors cannot replace the runtime factory`,()=>{
  const r=fixture(engine)
  r.run(`globalThis.saved=wx.getLogManager;
   __container_install_host_services({apis:[{name:'wx.getLogManager',kind:'object',owner:'host'},{name:'wx.onOther',kind:'subscription',owner:'host',counterpart:'wx.getLogManager'}],objectApis:[]})`)
  assert.equal(r.run('saved===wx.getLogManager'),true)
  assert.equal(r.run('Object.getOwnPropertyDescriptor(wx,"getLogManager").writable'),false)
 })
 test(`${engine}: reentrant proxies and writer failures cannot replace ordinary API effects`,()=>{
  const r=fixture(engine,()=>{throw Error('sink unavailable')})
  r.run(`globalThis.logger=wx.getLogManager();globalThis.calls=0;
   const proxy=new Proxy({},{ownKeys(){logger.log('recursive');calls++;return []}});
   logger.log(proxy);globalThis.result=wx.canIUse('wx.getLogManager')`)
  assert.equal(r.run('calls'),1);assert.equal(r.run('result'),true)
 })
 test(`${engine}: trusted revocation during proxy projection cancels the pending native admission`,()=>{
  const r=fixture(engine)
  r.context.revoke=()=>r.transports.installHostEnvironment(policy({'wx.getLogManager':'unsupported'}))
  r.run(`const logger=wx.getLogManager({level:1});logger.log(new Proxy({},{ownKeys(){revoke();return []}}))`)
  assert.equal(r.records.length,0)
 })
 test(`${engine}: Page hiding leaves logger alive while trusted Session retirement fences borrowed methods`,()=>{
  const r=fixture(engine)
  r.run(`globalThis.logger=wx.getLogManager({level:1})`)
  r.transports.dispatchLifecycleNotification('hide',{})
  r.run(`logger.log('after hide')`);assert.equal(r.records.length,1)
  r.transports.dispatchLifecycleNotification('retire',{})
  r.transports.installHostEnvironment(policy())
  assert.throws(()=>r.run(`logger.log('late')`),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
  assert.throws(()=>r.run('wx.getLogManager()'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
 })
}

test('catalog runtime ownership is reproducible and does not implicitly grant LogManager',()=>{
 const catalog=JSON.parse(readFileSync(new URL('../crates/container-runtime/src/host-api-catalog.json',import.meta.url)))
 for(const name of names)assert.equal(catalog.apis.find(x=>x.name===name).owner,'runtime')
 const generator=readFileSync(new URL('./generate-host-api-catalog.mjs',import.meta.url),'utf8')
 assert(generator.includes('canIUse getLogManager getRandomValues'))
 for(const engine of ['quickjs','v8']){
  const source=readFileSync(new URL(`../crates/container-engine-${engine}/src/lib.rs`,import.meta.url),'utf8')
  const defaults=source.slice(source.indexOf('let __container_capabilities = {'),source.indexOf('function __container_capability('))
  assert(!defaults.includes('getLogManager'));assert(!defaults.includes('LogManager.'))
 }
})
