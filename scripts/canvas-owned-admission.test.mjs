import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppServiceTestRealm} from './app-service-test-realm.mjs';

const MAX_ITEMS=1000000, MAX_BYTES=16*1024*1024;
function count(value) {return 1+(value!==null&&typeof value==='object'?Object.values(value).reduce((sum,item)=>sum+count(item),0):0);}
function fixture(engine) {
  const r=createAppServiceTestRealm(engine);
  r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.createCanvasContext':'full','wx.canvas.draw':'full'}});
  r.transports.dispatchLifecycleNotification('session',{});
  r.run(`Page({data:{showCanvas:true}});__container_set_current_pages([0],[{index:0,instanceId:11,route:'pages/first'}]);
    globalThis.page=__container_page_instances['11'];globalThis.ctx=wx.createCanvasContext('shared',page);
    globalThis.promises=[];globalThis.callbacks=0;globalThis.admitted=0;globalThis.failures=0;`);
  r.capture=(after='0')=>{
    const encoded=r.transports.captureReceiverIncarnations({kind:'canvas-draw-requests',after});
    const value=JSON.parse(encoded);
    assert.ok(count(value)<=MAX_ITEMS);assert.ok(encoded.length*2<=MAX_BYTES);
    for(const request of value.requests)for(const key of ['bytes','items','request'])assert.equal(Object.hasOwn(request,key),false);
    return value.requests;
  };
  r.deliver=draw=>assert.equal(r.transports.dispatchLifecycleNotification('ownedCanvas',{ticket:draw.ticket,result:{canvasId:'shared',width:3,height:2},error:null}),true);
  r.submit=()=>r.run(`(()=>{try{const promise=ctx.draw(false,()=>callbacks++);promises.push(promise);admitted++;return null}
    catch(error){failures++;return {code:error.code,errMsg:error.errMsg}}})()`);
  r.setDash=length=>r.run(`ctx.setLineDash(Array(${length}).fill(1),0)`);
  return r;
}
for(const engine of ['quickjs','v8']) {
  test(`${engine}: original 25 by 50000 scalar workload rejects atomically, captures every admission and retries unchanged`,async()=>{
    const r=fixture(engine);let cursor='0',firstWave=0,rejected=0;
    for(let index=0;index<25;index++) {
      r.setDash(50000);const error=r.submit();
      if(error) {
        rejected++;assert.equal(error.code,'ERR_RESOURCE_LIMIT');assert.match(error.errMsg,/item budget/);
        const full=r.capture(cursor);assert.ok(full.length>1);firstWave ||= full.filter(item=>item.kind==='draw').length;
        assert.deepEqual(r.capture(cursor),full,'capture retry is immutable and stays bounded');
        const last=full.at(-1).sequence;
        // Context-only ACK removes its own charge, not any draw payload.
        const context=full.find(item=>item.kind==='context');
        if(context){cursor=context.sequence;assert.equal(r.capture(cursor).length,full.length-1);}
        const draws=full.filter(item=>item.kind==='draw');
        r.deliver(draws[0]);cursor=draws[0].sequence;
        const suffix=r.capture(cursor);assert.equal(suffix.length,draws.length-1);
        assert.deepEqual(r.capture('0'),suffix,'a lower later cursor cannot resurrect an ACKed prefix');
        // Releasing exactly one draw makes room for the rejected batch. No
        // replacement setLineDash is issued: its original command must remain.
        assert.equal(r.submit(),null);
        const retried=r.capture(cursor).at(-1);
        assert.equal(retried.sequence,(BigInt(last)+1n).toString(),'rejection consumes no request identity');
        assert.equal(retried.options.commands.length,1);assert.equal(retried.options.commands[0].op,'setLineDash');
        assert.deepEqual(retried.options.commands[0].args,[Array(50000).fill(1),0]);
        for(const draw of r.capture(cursor))r.deliver(draw);
        cursor=retried.sequence;assert.deepEqual(r.capture(cursor),[]);
      }
    }
    const tail=r.capture(cursor);for(const draw of tail.filter(item=>item.kind==='draw'))r.deliver(draw);
    if(tail.length)cursor=tail.at(-1).sequence;assert.deepEqual(r.capture(cursor),[]);
    assert.equal(r.run('admitted'),25);assert.equal(r.run('callbacks'),25);
    assert.deepEqual(Array.from(await r.run('Promise.all(promises.map(p=>p.then(()=>true,()=>false)))')),Array(25).fill(true));
    assert.ok(rejected>0);assert.ok(firstWave>0&&firstWave<25);
    console.log(JSON.stringify({engine,nodeVmOnly:true,originalDrawCount:25,scalarsPerDraw:50000,firstWaveAdmitted:firstWave,budgetRejections:rejected,eventuallySettled:25}));
  });
  test(`${engine}: context metadata shares the exact aggregate budget and failed registration preserves identities`,async()=>{
    const r=fixture(engine);
    for(let index=0;index<19;index++){r.setDash(50000);assert.equal(r.submit(),null);}
    let full=r.capture();const registration=full[0],sample=full[1];
    const drawOverhead=count(sample)-50000, registrationItems=count(registration);
    const target=MAX_ITEMS-registrationItems+1;
    const remainder=target-count({requests:full})-drawOverhead;
    assert.ok(remainder>0&&remainder<=65536);r.setDash(remainder);assert.equal(r.submit(),null);
    full=r.capture();assert.equal(count({requests:full}),target);
    const before=JSON.stringify(full),last=full.at(-1).sequence;
    const error=r.run(`(()=>{try{wx.createCanvasContext('another',page);return null}catch(error){return error}})()`);
    assert.equal(error.code,'ERR_RESOURCE_LIMIT');assert.match(error.errMsg,/item budget/);
    assert.equal(JSON.stringify(r.capture()),before,'failed context adds neither metadata nor a queue entry');
    for(const draw of full.filter(item=>item.kind==='draw'))r.deliver(draw);assert.deepEqual(r.capture(last),[]);
    r.run(`globalThis.other=wx.createCanvasContext('another',page)`);
    const [fresh]=r.capture();assert.equal(fresh.context,'2');assert.equal(fresh.sequence,(BigInt(last)+1n).toString());
    assert.equal(r.run('callbacks'),20);
    assert.equal((await r.run('Promise.all(promises)')).length,20);
  });
  test(`${engine}: wire byte limit includes actual capture wrapper and rejection retains long text`,async()=>{
    const r=fixture(engine);let rejected=false;
    for(let index=0;index<10;index++) {
      r.run(`ctx.fillText('x'.repeat(1000000),0,0)`);
      const error=r.submit();
      if(error) {
        assert.equal(error.code,'ERR_RESOURCE_LIMIT');assert.match(error.errMsg,/byte budget/);rejected=true;
        const accepted=r.capture(),last=accepted.at(-1).sequence;
        assert.ok(count({requests:accepted})<MAX_ITEMS/100);
        for(const draw of accepted.filter(item=>item.kind==='draw'))r.deliver(draw);assert.deepEqual(r.capture(last),[]);
        assert.equal(r.submit(),null);const [retry]=r.capture();
        assert.equal(retry.sequence,(BigInt(last)+1n).toString());assert.equal(retry.options.commands.length,1);
        assert.deepEqual(retry.options.commands[0].args,['x'.repeat(1000000),0,0]);
        r.deliver(retry);assert.deepEqual(r.capture(retry.sequence),[]);
      }
    }
    const tail=r.capture();for(const draw of tail.filter(item=>item.kind==='draw'))r.deliver(draw);
    assert.ok(rejected);assert.equal(r.run('admitted'),10);assert.equal(r.run('callbacks'),10);
    assert.equal((await r.run('Promise.all(promises)')).length,10);
  });
  test(`${engine}: captured Promise intrinsics and synchronous callbacks cannot bypass aggregate admission`,async()=>{
    const r=fixture(engine);
    r.run(`globalThis.promiseHooks=0;const Original=Promise;
      globalThis.Promise=function(){promiseHooks++;throw Error('guest Promise constructor')};
      Object.defineProperty(Original,Symbol.species,{get(){promiseHooks++;throw Error('guest species')},configurable:true});
      Object.defineProperty(Original.prototype,'constructor',{get(){promiseHooks++;throw Error('guest constructor getter')},configurable:true});
      globalThis.reentrantCode='';globalThis.last=ctx.draw(false,function(){
        ctx.fillRect(0,0,1,1);try{ctx.draw()}catch(error){reentrantCode=error.code}
      });`);
    // Fill the remaining queue by count with intrinsic promises. A callback
    // runs before ACK; deleting its callback record cannot free queue capacity.
    for(let index=0;index<254;index++)assert.equal(r.submit(),null);
    assert.equal(r.submit().code,'ERR_RESOURCE_LIMIT');const full=r.capture();
    const first=full.find(item=>item.kind==='draw');r.deliver(first);
    assert.equal(r.run('reentrantCode'),'ERR_RESOURCE_LIMIT');assert.equal(r.run('promiseHooks'),0);
    for(const draw of full.filter(item=>item.kind==='draw'&&item.ticket!==first.ticket))r.deliver(draw);
    assert.deepEqual(r.capture(full.at(-1).sequence),[]);
    assert.equal(r.submit(),null);const [retry]=r.capture();assert.deepEqual(retry.options.commands,[{op:'fillRect',args:[0,0,1,1]}]);
    r.deliver(retry);assert.equal(r.run('promiseHooks'),0);
    // Await without consulting the poisoned inherited constructor/species.
    assert.equal((await r.run('last')).canvasId,'shared');
  });
  test(`${engine}: same guest call exposes Canvas alongside a not-yet-transferred setData effect`,()=>{
    const r=fixture(engine);
    r.run(`__container_run_with_api_owner(page,()=>{page.setData({showCanvas:false});ctx.fillRect(0,0,1,1);ctx.draw()});`);
    const requests=r.capture();assert.equal(requests.filter(item=>item.kind==='draw').length,1);
    const batch=r.json('__container_drain_events()');
    assert.ok(batch.events.some(event=>event.type==='data.patch.batch'&&event.patches.some(patch=>patch.path==='showCanvas'&&patch.value===false)),JSON.stringify(batch.events));
    assert.equal(r.transports.installHostEnvironment({kind:'effects-ack',drainId:batch.__containerDrainId}),true);
    console.log(JSON.stringify({engine,nodeVmOnly:true,ownedDrawPending:1,publicDataPatchPending:true,nativePaintNotExecuted:true}));
  });
}
