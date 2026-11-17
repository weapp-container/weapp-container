import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

const policy = (on = 'full', off = 'full') => ({ kind: 'capabilities', capabilities: {
  'wx.onHostLayoutChange': on, 'wx.offHostLayoutChange': off,
} })
const layout = () => ({version:1,safeInsets:{top:0,right:84,bottom:34,left:0},verticalBarEdge:'right',
  reservedRegions:[{id:'camera',kind:'occlusion',x:867,y:0,width:84,height:56}]})
for (const engine of ['quickjs', 'v8']) {
  const fixture = () => {
    const realm = createAppServiceTestRealm(engine)
    realm.transports.installHostEnvironment(policy())
    return {...realm, emit: value => realm.transports.dispatchLifecycleNotification('hostLayoutChange', value ?? {hostLayout:layout()})}
  }
  test(`${engine}: layout extension is denied without its own admission`, () => {
    const r = createAppServiceTestRealm(engine)
    assert.throws(() => r.run('wx.onHostLayoutChange(function(){})'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    assert.throws(() => r.run('wx.offHostLayoutChange()'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(r.transports.dispatchLifecycleNotification('hostLayoutChange', {hostLayout:layout()}), false)
  })
  test(`${engine}: each listener receives independent complete local geometry and explicit clearing`, () => {
    const r = fixture()
    r.run(`globalThis.trace=[];wx.onHostLayoutChange(function(event){
      trace.push(event);if(event.hostLayout){event.hostLayout.safeInsets.right=-1;event.hostLayout.reservedRegions[0].width=-1}
    });wx.onHostLayoutChange(function(event){trace.push(event)});`)
    const input = {hostLayout:layout(),hostSecret:'private'}
    assert.equal(r.emit(input), true)
    assert.deepEqual(r.json('trace[1]'), {hostLayout:layout()})
    assert.deepEqual(input.hostLayout, layout())
    r.emit({hostLayout:null})
    assert.deepEqual(r.json('trace.slice(-2)'),[{hostLayout:null},{hostLayout:null}])
  })
  test(`${engine}: exact removal, deduplication and active snapshot mutation have stable identity`, () => {
    const r = fixture()
    r.run(`globalThis.trace=[];globalThis.later=()=>trace.push('later');globalThis.first=()=>{trace.push('first');wx.offHostLayoutChange();wx.onHostLayoutChange(later)};
      wx.onHostLayoutChange(first);wx.onHostLayoutChange(first);wx.onHostLayoutChange(()=>trace.push('second'));`)
    r.emit();r.emit();r.run('wx.offHostLayoutChange(later)');r.emit()
    assert.deepEqual(r.json('trace'),['first','second','later'])
  })
  test(`${engine}: trusted withdrawal and retirement cancel pending tails and cannot be forged`, () => {
    const r = fixture()
    r.context.revoke = () => r.transports.installHostEnvironment(policy('unsupported','partial'))
    r.run(`globalThis.trace=[];globalThis.on=wx.onHostLayoutChange;globalThis.off=wx.offHostLayoutChange;
      on(()=>{trace.push('first');revoke()});on(()=>trace.push('stale'));`)
    r.emit()
    r.run("__container_capabilities['wx.onHostLayoutChange']='full'")
    assert.throws(() => r.run('on(function(){})'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(r.run('off()'),undefined)
    r.transports.installHostEnvironment(policy())
    r.context.retire = () => r.transports.dispatchLifecycleNotification('retire',{})
    r.run("on(()=>{trace.push('retire');retire()});on(()=>trace.push('retired-tail'))")
    r.emit()
    assert.equal(r.emit(),false)
    assert.deepEqual(r.json('trace'),['first','retire'])
  })
  test(`${engine}: public aliases and replaced intrinsics cannot redirect layout dispatch`, () => {
    const r = fixture()
    r.run(`globalThis.trace=[];globalThis.on=wx.onHostLayoutChange;globalThis.off=wx.offHostLayoutChange;
      globalThis.callback=event=>trace[trace.length]=event;
      on(callback);wx.onHostLayoutChange=()=>{};wx.offHostLayoutChange=()=>{throw Error('fake')};
      __container_app_listeners={hostLayoutChange:[()=>{throw Error('forged')}]};
      Object.create=Object.defineProperty=Object.getOwnPropertyDescriptor=Reflect.ownKeys=Reflect.apply=Array.isArray=()=>{throw Error('poisoned')};`)
    r.emit()
    assert.deepEqual(r.json('trace'),[{hostLayout:layout()}])
    r.run('off(callback)');r.emit()
    assert.equal(r.run('trace.length'),1)
  })
  test(`${engine}: malformed dispatch ignores accessors and callback failures do not drop the tail`, () => {
    const r = fixture();let gets=0
    r.run(`globalThis.trace=[];wx.onHostLayoutChange(()=>{trace.push('throw');throw Error('layout-listener')});wx.onHostLayoutChange(()=>trace.push('tail'))`)
    for(const value of [null,{}, {hostLayout:{}}, {hostLayout:{version:2}},
      Object.defineProperty({},'hostLayout',{get(){gets++;throw Error('accessor')}})]) {
      assert.equal(r.transports.dispatchLifecycleNotification('hostLayoutChange',value),false)
    }
    assert.equal(gets,0)
    r.emit()
    assert.deepEqual(r.json('trace'),['throw','tail'])
    assert.equal(r.run("__container_errors.filter(row=>row.message==='layout-listener').length"),1)
  })
}
