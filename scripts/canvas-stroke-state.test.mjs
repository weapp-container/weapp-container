import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppServiceTestRealm} from './app-service-test-realm.mjs';

// Production QuickJS/V8 bootstrap compositions in Node VM. No native renderer
// or pixel result is synthesized by these facade/admission tests.
function fixture(engine) {
  const r=createAppServiceTestRealm(engine);
  r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.createCanvasContext':'full','wx.canvas.draw':'full'}});
  r.run(`globalThis.ctx=wx.createCanvasContext('stroke');
    globalThis.readState=()=>({cap:ctx.lineCap,join:ctx.lineJoin,miter:ctx.miterLimit,
      offset:ctx.lineDashOffset,width:ctx.lineWidth,alpha:ctx.globalAlpha,
      fill:ctx.fillStyle,stroke:ctx.strokeStyle,fontSize:ctx.fontSize});`);
  return r;
}
function drain(r) {
  const batch=r.json('__container_drain_events()');
  assert.equal(r.transports.installHostEnvironment({kind:'effects-ack',drainId:batch.__containerDrainId}),true);
  return batch.events;
}
const defaults={cap:'butt',join:'miter',miter:10,offset:0,width:1,alpha:1,fill:'#000000',stroke:'#000000',fontSize:10};
for(const engine of ['quickjs','v8']) {
  test(`${engine}: stroke defaults and method/property updates share drawing state`,()=>{
    const r=fixture(engine);assert.deepEqual(r.json('readState()'),defaults);
    assert.equal(r.run(`ctx.setLineCap('round')`),undefined);
    assert.equal(r.run(`ctx.setLineJoin('bevel')`),undefined);
    assert.equal(r.run(`ctx.setMiterLimit(3)`),undefined);
    r.run(`ctx.lineCap='square';ctx.lineJoin='round';ctx.miterLimit=7;
      ctx.setLineWidth(4);ctx.setGlobalAlpha(.5);ctx.setFillStyle('red');ctx.setStrokeStyle('blue');ctx.setFontSize(12);`);
    assert.deepEqual(r.json('readState()'),{...defaults,cap:'square',join:'round',miter:7,width:4,alpha:.5,fill:'red',stroke:'blue',fontSize:12});
    r.run('ctx.draw()');const [event]=drain(r);
    assert.deepEqual(event.options.commands.slice(0,6),[
      {op:'setLineCap',args:['round']},{op:'setLineJoin',args:['bevel']},{op:'setMiterLimit',args:[3]},
      {op:'setLineCap',args:['square']},{op:'setLineJoin',args:['round']},{op:'setMiterLimit',args:[7]}]);
  });
  test(`${engine}: dash offset preserves immutable pattern and follows method offset`,()=>{
    const r=fixture(engine);
    r.run(`const pattern=[3,2];ctx.setLineDash(pattern,1);pattern[0]=99;ctx.lineDashOffset=-4;ctx.draw();`);
    const [event]=drain(r);assert.deepEqual(event.options.commands,[
      {op:'setLineDash',args:[[3,2],1]},{op:'setLineDash',args:[[3,2],-4]}]);
    r.run('ctx.setLineDash([1]);');assert.equal(r.run('ctx.lineDashOffset'),0);
    r.run('ctx.draw()');assert.deepEqual(drain(r)[0].options.commands,[{op:'setLineDash',args:[[1],0]}]);
  });
  test(`${engine}: save/restore restores shared style state and empty restore is inert`,()=>{
    const r=fixture(engine);
    assert.equal(r.run('ctx.save()'),undefined);
    r.run(`ctx.lineCap='round';ctx.lineJoin='bevel';ctx.miterLimit=2;ctx.setLineDash([4,1],3);ctx.lineWidth=6;ctx.globalAlpha=.25;ctx.fillStyle='red';`);
    r.run(`ctx.save();ctx.lineCap='square';ctx.lineDashOffset=9;ctx.restore();`);
    assert.deepEqual(r.json('readState()'),{...defaults,cap:'round',join:'bevel',miter:2,offset:3,width:6,alpha:.25,fill:'red'});
    assert.equal(r.run('ctx.restore()'),undefined);assert.deepEqual(r.json('readState()'),defaults);
    r.run('ctx.restore()');assert.deepEqual(r.json('readState()'),defaults);
  });
  test(`${engine}: malformed stroke state never advances getters or queue`,()=>{
    const r=fixture(engine);
    const result=r.json(`(()=>{const errors=[];globalThis.hooks=0;
      for(const mutate of [()=>ctx.lineCap='invalid',()=>ctx.lineJoin='none',()=>ctx.miterLimit=NaN,
        ()=>ctx.lineDashOffset=Infinity,()=>ctx.setLineWidth(1e100),()=>ctx.setLineDash([-1]),
        ()=>ctx.setLineDash([1e38,1e38,1e38]),()=>ctx.setMiterLimit({toJSON(){hooks++;return 3}})]) {
        try{mutate();}catch(error){errors.push(error.code)}
      }return {errors,state:readState(),hooks};})()`);
    assert.deepEqual(result,{errors:Array(8).fill('ERR_INVALID_REQUEST'),state:defaults,hooks:0});
    r.run('ctx.draw()');assert.deepEqual(drain(r)[0].options.commands,[]);
  });
  test(`${engine}: command and save budgets preserve the last admitted state`,()=>{
    const r=fixture(engine);
    r.run('for(let i=0;i<16384;i++)ctx.beginPath();');
    assert.equal(r.run(`(()=>{try{ctx.lineCap='round'}catch(e){return e.code}})()`),'ERR_RESOURCE_LIMIT');
    assert.equal(r.run('ctx.lineCap'),'butt');r.run('ctx.draw()');assert.equal(drain(r)[0].options.commands.length,16384);
    r.run('for(let i=0;i<256;i++)ctx.save();');
    assert.equal(r.run('(()=>{try{ctx.save()}catch(e){return e.code}})()'),'ERR_RESOURCE_LIMIT');
    r.run(`ctx.lineCap='round';for(let i=0;i<256;i++)ctx.restore();`);assert.equal(r.run('ctx.lineCap'),'butt');
  });
  test(`${engine}: rejected draw keeps queue and state; accepted reserve resets defaults`,()=>{
    const r=fixture(engine);
    const actual=r.json(`(()=>{ctx.lineCap='round';ctx.setLineDash([4,2],3);ctx.save();
      const push=__container_events.push;let error;
      try{__container_events.push=()=>{throw Error('queue unavailable')};ctx.draw(true)}catch(e){error=e.message}
      finally{__container_events.push=push}
      return {error,state:readState()};})()`);
    assert.equal(actual.error,'queue unavailable');assert.equal(actual.state.cap,'round');assert.equal(actual.state.offset,3);
    r.run('ctx.draw(true)');const [event]=drain(r);assert.equal(event.options.reserve,true);assert.equal(event.options.commands.length,3);
    assert.deepEqual(r.json('readState()'),defaults);r.run('ctx.restore()');assert.deepEqual(r.json('readState()'),defaults);
  });
  test(`${engine}: reentrant next-batch state replays after draw admission without rereading inputs`,()=>{
    const r=fixture(engine);
    r.run(`ctx.lineCap='square';globalThis.once=false;const push=__container_events.push;
      __container_events.push=function(event){if(!once){once=true;ctx.lineCap='round';ctx.save();ctx.lineJoin='bevel'}return push.call(this,event)};
      try{ctx.draw()}finally{__container_events.push=push}`);
    assert.deepEqual(r.json('readState()'),{...defaults,cap:'round',join:'bevel'});
    r.run('ctx.restore()');assert.deepEqual(r.json('readState()'),{...defaults,cap:'round'});
    r.run('ctx.draw()');const events=drain(r);assert.equal(events.length,2);
    assert.deepEqual(events[0].options.commands,[{op:'setLineCap',args:['square']}]);
    assert.deepEqual(events[1].options.commands,[{op:'setLineCap',args:['round']},{op:'save',args:[]},{op:'setLineJoin',args:['bevel']},{op:'restore',args:[]}]);
  });
  test(`${engine}: contexts keep independent state and saved dash snapshots`,()=>{
    const r=fixture(engine);
    r.run(`globalThis.other=wx.createCanvasContext('other');ctx.setLineDash([1,2],3);ctx.save();ctx.setLineDash([9,8],7);ctx.restore();ctx.lineDashOffset=4;ctx.draw();`);
    assert.equal(r.run('other.lineDashOffset'),0);assert.equal(r.run('other.lineCap'),'butt');
    assert.deepEqual(drain(r)[0].options.commands.at(-1),{op:'setLineDash',args:[[1,2],4]});
  });
}
