#!/usr/bin/env node
// Tests the real development HTTP/Skia/browser path, never a JS-only proxy.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir, cpus, loadavg, totalmem, freemem, availableParallelism } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { installSmokeSignals, startDevSimulator } from './simulator-dev-harness.mjs';
import { measureScrollPresentation } from './lib/simulator-scroll-metrics.mjs';
import { driveBrowserRafWheels } from './lib/simulator-scroll-driver.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2), option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const binary=resolve(option('--simulator-bin',join(root,'target/release/weapp-simulator')));
const output=resolve(option('--out',join(root,'artifacts/presentation/report.json')));
const engine=option('--engine','quickjs');
const owned=await mkdtemp(join(tmpdir(),'weapp-presentation-')),project=join(owned,'reference-app');
const signals=installSmokeSignals(), failures=[];
let simulator,browser,context,page,networkCdp;
const report={schemaVersion:1,status:'failed',generatedAt:new Date().toISOString(),engine,
 commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
 environment:{platform:process.platform,arch:process.arch,node:process.version,cpu:cpus()[0]?.model,logicalCpuCount:cpus().length,availableParallelism:availableParallelism(),totalMemoryBytes:totalmem(),freeMemoryBytes:freemem(),loadAverageStart:loadavg()},
 scope:'release CPU Skia, real headless Chromium input and HTTP development loop; no GPU/device claim',
 resources:{headless:true,pages:1,temporaryProject:project},checks:{},gates:{},cleanup:{}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const percentile=(values,p)=>values.toSorted((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)];
try {
 report.sourceTree={dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0,trackedDiffSha256:createHash('sha256').update(execFileSync('git',['diff','--binary','HEAD'],{cwd:root})).digest('hex')};
 report.sourceTree.untrackedFiles={};
 for(const path of execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(path=>/^(crates|scripts|examples\/hosts)\//.test(path)))
   report.sourceTree.untrackedFiles[path]=createHash('sha256').update(await readFile(join(root,path))).digest('hex');
 const bytes=await readFile(binary); report.binary={path:binary,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
 await cp(join(root,'examples/apps/reference-app'),project,{recursive:true,filter:source=>!['dist','.weapp-container','.weapp-vite','node_modules'].includes(basename(source))});
 // Deterministic scrolling extension to the fixed reference; source is captured below.
 const template=join(project,'pages/home/index.wxml'),style=join(project,'pages/home/index.wxss');
 await writeFile(template,(await readFile(template,'utf8'))+'<scroll-view id="perf-scroll" class="perf-scroll" scroll-y><view class="perf-content">'+Array.from({length:100},(_,i)=>`<view class="perf-row" style="background:${i%2?'#167c63':'#1c426a'}">Row ${i}</view>`).join('')+'</view></scroll-view>');
 await writeFile(style,(await readFile(style,'utf8'))+'\n.perf-scroll { position:absolute; left:0; top:400px; width:375px; height:240px; } .perf-content { height:4000px; } .perf-row { height:40px; color:white; }\n');
 report.fixture={base:'examples/apps/reference-app',extension:'100 deterministic 40px scroll rows at y400',wxmlSha256:createHash('sha256').update(await readFile(template)).digest('hex'),wxssSha256:createHash('sha256').update(await readFile(style)).digest('hex')};
 simulator=await startDevSimulator({root,project,engine,port:0,timeoutMs:120000,launcher:{mode:'simulator',command:binary},signal:signals.signal});
 report.resources.simulator={pid:simulator.child.pid,url:simulator.url};
 const initial=await simulator.waitForState(s=>s.status==='ready'&&s.revision>0,'initial generation');
 const {chromium}=await import(pathToFileURL(join(root,'vendor/weapp-vite/node_modules/playwright/index.mjs')).href);
 browser=await chromium.launch({headless:true,handleSIGINT:false,handleSIGTERM:false});
 report.environment.browser=browser.version();
 context=await browser.newContext({deviceScaleFactor:2,viewport:{width:1400,height:1050},hasTouch:true});
 page=await context.newPage();
 if(args.includes('--network-trace')) {
 networkCdp=await context.newCDPSession(page);
 const frameRequests=new Map();report.frameNetwork=[];
 networkCdp.on('Network.requestWillBeSent',event=>{if(new URL(event.request.url).pathname==='/api/frame')frameRequests.set(event.requestId,{startedAt:event.timestamp,chunks:0,decodedBytes:0});});
 networkCdp.on('Network.responseReceived',event=>{const frame=frameRequests.get(event.requestId);if(frame)Object.assign(frame,{headersAt:event.timestamp,timing:event.response.timing,status:event.response.status,protocol:event.response.protocol});});
 networkCdp.on('Network.dataReceived',event=>{const frame=frameRequests.get(event.requestId);if(frame){frame.chunks++;frame.decodedBytes+=event.dataLength;frame.firstChunkAt??=event.timestamp;frame.lastChunkAt=event.timestamp;}});
 networkCdp.on('Network.loadingFinished',event=>{const frame=frameRequests.get(event.requestId);if(frame){Object.assign(frame,{finishedAt:event.timestamp,encodedBytes:event.encodedDataLength,totalMs:(event.timestamp-frame.startedAt)*1000,ttfbMs:(frame.headersAt-frame.startedAt)*1000,bodyMs:(event.timestamp-frame.headersAt)*1000});report.frameNetwork.push(frame);if(report.frameNetwork.length>512)report.frameNetwork.shift();frameRequests.delete(event.requestId);}});
 await networkCdp.send('Network.enable');
 }
 const browserErrors=[];page.on('pageerror',e=>browserErrors.push(e.message));
 await page.goto(simulator.url,{waitUntil:'domcontentloaded'});
 const settings=()=>simulator.json('/api/presentation');
 async function apply(patch) {
   const before=await settings(),requestId=`test-${before.revision}`;
   const receipt=await simulator.json('/api/presentation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...patch,revision:before.revision,requestId})});
   assert.equal(receipt.queued,true);
   await simulator.waitForState(s=>s.presentation?.revision>before.revision,'presentation commit');
   const next=await settings();
   await page.waitForFunction(g=>globalThis.__weappPresentationMetrics?.configGeneration===g,next.generation,{timeout:15000});
   return next;
 }
 await page.waitForFunction(()=>globalThis.__weappPresentationMetrics?.width===750,null,{timeout:15000});
 report.checks.defaultAuto=await settings();assert.equal(report.checks.defaultAuto.effectiveScale,2);
 for(const scale of [1,1.5,2,3,4]) {
   await apply({renderScale:scale});
   const m=await page.evaluate(()=>({...globalThis.__weappPresentationMetrics,frames:undefined,samples:undefined}));
   assert.equal(m.width,Math.ceil(375*scale));assert.equal(m.height,Math.ceil(667*scale));
   assert.equal((await simulator.json('/api/state')).sessionId,initial.sessionId);
   report.checks[`scale${scale}`]={width:m.width,height:m.height,sessionUnchanged:true};
 }
 await apply({renderScale:2,fps:60});
 const previous=await settings();
 const receipt=await simulator.json('/api/presentation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:previous.revision,requestId:'reject-budget',logicalWidth:4096})});
 assert.equal(receipt.queued,true);await sleep(100);assert.deepEqual(await settings(),previous);
 const stale=await fetch(new URL('/api/presentation',simulator.url),{signal:AbortSignal.any([signals.signal,AbortSignal.timeout(5000)]),method:'POST',body:JSON.stringify({revision:0,fps:30})});assert.equal(stale.status,409);await stale.arrayBuffer();
 report.checks.invalidPreservesSettings=true;
 // Measure actual pointer-up to completed pixel presentation, using one outstanding interaction.
 await page.evaluate(()=>{
   globalThis.__inputTimes=[];globalThis.__tapEffects=[];
   document.querySelector('#screen').addEventListener('pointerup',()=>globalThis.__inputTimes.push(performance.now()),{capture:true});
   events.addEventListener('bridge',event=>{
     const batch=JSON.parse(event.data);
     for(const message of batch.messages||[])for(const envelope of message.payload?.effects||[])for(const effect of envelope.events||[])
       if(effect.type==='data.patch.batch')for(const patch of effect.patches||[])
         if(patch.path==='count'&&patch.op==='set')globalThis.__tapEffects.push({value:patch.value,timestamp:performance.now()});
   });
 });
 const canvas=page.locator('#screen');
 // Selector query follows the real runtime's logical geometry.
 const queryBounds=selector=>page.evaluate(async ({sessionId,selector})=>{
   const requestId=`perf-bounds-${selector}`;
   return await new Promise((resolve,reject)=>{
     let timer;
     const complete=event=>{const batch=JSON.parse(event.data);const response=batch.messages?.find(m=>m.requestId===requestId);if(response){clearTimeout(timer);events.removeEventListener('bridge',complete);response.payload.ok?resolve(response.payload.result):reject(new Error(JSON.stringify(response)));}};
     timer=setTimeout(()=>{events.removeEventListener('bridge',complete);reject(new Error('bounds timeout'));},15000);
     events.addEventListener('bridge',complete);
     fetch('/api/bridge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({protocolVersion:'1.0',sessionId,requestId,kind:'request',op:'api.call',payload:{name:'wx.createSelectorQuery',selector}})}).then(response=>{if(!response.ok)throw new Error(`bounds HTTP ${response.status}`);return response.body?.cancel();}).catch(error=>{clearTimeout(timer);events.removeEventListener('bridge',complete);reject(error);});
   });
 },{sessionId:initial.sessionId,selector});
 const bounds=await queryBounds('#increment'),countBounds=await queryBounds('#count');
 const box=Array.isArray(bounds)?bounds[0]:bounds,countBox=Array.isArray(countBounds)?countBounds[0]:countBounds;
 assert.ok(box?.width>0,JSON.stringify(bounds));assert.ok(countBox?.width>0,JSON.stringify(countBounds));
 const samplePresentation=(region=countBox)=>page.evaluate(countBox=>{
   const canvas=document.querySelector('#screen'),scale=canvas.width/375;
   const pixels=canvas.getContext('2d').getImageData(Math.floor(countBox.left*scale),Math.floor(countBox.top*scale),Math.max(1,Math.floor(countBox.width*scale)),Math.max(1,Math.floor(countBox.height*scale))).data;
   let checksum=2166136261;for(const value of pixels)checksum=Math.imul(checksum^value,16777619)>>>0;
   return {input:globalThis.__inputTimes.at(-1),frame:globalThis.__weappPresentationMetrics.frames.at(-1),effect:globalThis.__tapEffects.at(-1),checksum};
 },region);
 let previousPixels=(await samplePresentation()).checksum;
 const latencies=[];
 for(let i=0;i<50;i++) {
   signals.signal.throwIfAborted();
   const before=await page.evaluate(()=>globalThis.__weappPresentationMetrics.presented),rect=await canvas.boundingBox();
   await page.mouse.click(rect.x+(box.left+box.width/2)*rect.width/375,rect.y+(box.top+box.height/2)*rect.height/667);
   await page.waitForFunction(n=>globalThis.__weappPresentationMetrics.presented>n,before,{timeout:15000});
   const sample=await samplePresentation();
   assert.equal(sample.effect?.value,i+1,'the actual Page setData counter must match this input');
   assert.ok(sample.effect.timestamp>=sample.input&&sample.frame.drawCompletedAt>=sample.effect.timestamp,'the CPU draw return must follow this input and its JS state patch; this is not compositor presentation');
   assert.notEqual(sample.checksum,previousPixels,'the count text pixels must change, not just the frame metadata');previousPixels=sample.checksum;
   // frame.timestamp is the RAF callback timestamp; endAt is after putImageData.
   latencies.push(sample.frame.drawCompletedAt-sample.input);
 }
 report.interaction={samples:latencies,p50:percentile(latencies,.5),p95:percentile(latencies,.95)};
 report.gates.inputP95={limitMs:50,actualMs:report.interaction.p95,status:report.interaction.p95<=50?'passed':'failed'};
 // Continuous real scrolling: 60 fixed warmup inputs, 180 measured intervals,
 // then one boundary input. No cooldown frame may repair a missed display slot.
 const rect=await canvas.boundingBox(),x=rect.x+100*rect.width/375,y=rect.y+500*rect.height/667;
 await page.mouse.move(x,y);
 const scrollRegion={left:0,top:400,width:375,height:240};
 const scrollPixelsBefore=(await samplePresentation(scrollRegion)).checksum;
 const cdp=await context.newCDPSession(page);
 await page.evaluate(async()=>{
   globalThis.__wheelTimes=[];globalThis.__wheelEvents=[];globalThis.__scrollPresentations=[];globalThis.__scrollRafOpportunities=[];
   const canvas=document.querySelector('#screen'),context=canvas.getContext('2d'),scale=canvas.width/375;
   // Fixed 1px-wide column through the striped scroll fixture. Each 3 logical
   // pixel input changes these bytes. Compare exact bytes, not frame metadata
   // or a hash that could treat an identical double commit as visible progress.
   const x=Math.floor(10*scale),top=Math.ceil(401*scale),bottom=Math.floor(639*scale),rows=bottom-top;
   const previous=new Uint8Array(context.getImageData(x,top,1,rows).data),original=context.putImageData;
   let pixelRevision=0;
   globalThis.__scrollProbe={method:'exact consecutive comparison of one fixed physical-pixel RGBA column; one initial narrow readback, then ImageData input only; no extra paint',x,top,rows,bytesPerProbe:previous.length};
   context.putImageData=function(image,...rest){
     const result=original.call(this,image,...rest),completedAt=performance.now(),probeStart=performance.now();
     let changed=false,digest=2166136261;
     for(let row=0;row<rows;row++)for(let channel=0;channel<4;channel++){
       const index=row*4+channel,value=image.data[((top+row)*image.width+x)*4+channel];
       if(previous[index]!==value)changed=true;
       previous[index]=value;digest=Math.imul(digest^value,16777619)>>>0;
     }
     if(changed)pixelRevision++;
     const revision=pixelRevision,probeMs=performance.now()-probeStart;
     // Production appends its frame metrics immediately after putImageData.
     // This microtask pairs that same presentation without changing its code.
     queueMicrotask(()=>globalThis.__scrollPresentations.push({
       ...globalThis.__weappPresentationMetrics.frames.at(-1),drawCompletedAt:completedAt,
       scrollPixelRevision:revision,scrollPixelsChanged:changed,scrollProbeDigest:digest,scrollProbeMs:probeMs,
     }));
     return result;
   };
   let rafHandle=null,stopRaf=false;
   const firstOpportunity=new Promise(resolve=>{
     function observeOpportunity(timestamp){
       globalThis.__scrollRafOpportunities.push({timestamp,observedAt:performance.now()});
       if(globalThis.__scrollRafOpportunities.length===1)resolve();
       if(!stopRaf)rafHandle=requestAnimationFrame(observeOpportunity);
     }
     rafHandle=requestAnimationFrame(observeOpportunity);
   });
   const recordWheel=event=>{
     const timestamp=performance.now();
     globalThis.__wheelTimes.push(timestamp);
     globalThis.__wheelEvents.push({index:globalThis.__wheelEvents.length,timestamp,eventTimestamp:event.timeStamp,
       deltaX:event.deltaX,deltaY:event.deltaY,deltaMode:event.deltaMode,isTrusted:event.isTrusted});
   };
   globalThis.__restoreScrollProbe=()=>{
     context.putImageData=original;stopRaf=true;
     if(rafHandle!==null)cancelAnimationFrame(rafHandle);
     canvas.removeEventListener('wheel',recordWheel,{capture:true});
   };
   canvas.addEventListener('wheel',recordWheel,{capture:true});
   // Fix the independent RAF phase before the driver sends its first wheel.
   await firstOpportunity;
 });
 // Drive native inputs from the browser's clock. A separate Node 60Hz timer
 // can beat against Chromium input/RAF scheduling and create burst/gap pairs.
 // This callback is independent of presentation success and never catches up.
 let driverFailure;
 report.scrollDriver={};
 try {
   await driveBrowserRafWheels({page,cdp,x,y,signal:signals.signal,evidence:report.scrollDriver,count:241,maxInflight:4});
   await sleep(200);
 } catch(error) { driverFailure=error; }
 finally {
   try { await cdp.detach();report.cleanup.scrollCdp=true; }
   catch(error) {report.cleanup.scrollCdp={error:error.message};driverFailure??=error;}
   report.scroll=await page.evaluate(()=>{
     globalThis.__restoreScrollProbe();
     return {inputs:globalThis.__wheelTimes,events:globalThis.__wheelEvents,frames:globalThis.__scrollPresentations,
       rafOpportunities:globalThis.__scrollRafOpportunities,pixelProbe:globalThis.__scrollProbe};
   });
 }
 report.scroll.pixelsBefore=scrollPixelsBefore;report.scroll.pixelsAfter=(await samplePresentation(scrollRegion)).checksum;assert.notEqual(report.scroll.pixelsAfter,scrollPixelsBefore,'real scrolling must change visible pixels');
 assert.ok(report.scroll.inputs.length>1,'native wheel events must reach the actual browser canvas');
 // The historical v2 CPU-only scorer calls its completion input presentedAt.
 // Adapt explicit putImageData-return facts locally; raw frames keep the new
 // endpoint name and this is never compositor/GPU presentation evidence.
 const measurement=measureScrollPresentation({inputs:report.scroll.inputs,frames:report.scroll.frames.map(frame=>({...frame,presentedAt:frame.drawCompletedAt})),
   rafOpportunities:report.scroll.rafOpportunities,sessionId:initial.sessionId,configGeneration:previous.generation});
 const probeCosts=report.scroll.frames.map(frame=>frame.scrollProbeMs);
 Object.assign(report.scroll,{...measurement,driverDispatchTimes:report.scrollDriver.dispatches.map(record=>record.dispatchedAt),maxInflightCdp:4,
   inputRecords:report.scroll.inputs.map((timestamp,index)=>({index,timestamp,phase:index<60?'warmup':index<240?'measurement':index===240?'end-exclusive-boundary':'extra'})),
   pixelProbe:{...report.scroll.pixelProbe,samples:probeCosts.length,p50Ms:percentile(probeCosts,.5),p95Ms:percentile(probeCosts,.95),maxMs:Math.max(...probeCosts)},
 });
 report.gates.scrollInputCadence=measurement.scrollInputCadence;
 report.gates.scrollMeasuredInputCadence=measurement.scrollMeasuredInputCadence;
 report.gates.scrollDisplayCadence=measurement.scrollDisplayCadence;
 report.gates.scrollDropRate=measurement.scrollDropRate;
 report.gates.scrollDriver={status:!driverFailure&&report.scroll.events.length===241&&report.scroll.events.every(event=>event.isTrusted&&event.deltaX===0&&event.deltaY===3&&event.deltaMode===0)?'passed':'failed',
   requested:241,scheduled:report.scrollDriver.browser?.records.length||0,dispatched:report.scrollDriver.dispatches.length,delivered:report.scroll.events.length,
   requestedLogicalDelta:report.scrollDriver.requestedLogicalDelta,cdpPhysicalDelta:report.scrollDriver.cdpPhysicalDelta,devicePixelRatio:report.scrollDriver.devicePixelRatio,
   method:'one real trusted DOM wheel with deltaY exactly 3 CSS pixels per independent browser RAF; CDP delta is 3 × actual browser DPR device pixels; bounded at four in flight; no catchup or synthetic DOM dispatch'};
 if(driverFailure)throw driverFailure;
 report.frameStages=await page.evaluate(()=>globalThis.__weappPresentationMetrics.frames);
 const frame=await fetch(new URL('/api/frame',simulator.url),{signal:AbortSignal.any([signals.signal,AbortSignal.timeout(5000)])}),buffer=Buffer.from(await frame.arrayBuffer()),n=buffer.readUInt32LE(0),header=JSON.parse(buffer.subarray(4,4+n));
 assert.equal(header.width,750);assert.equal(header.height,1334);assert.equal(header.format,'rgba8');assert.equal(buffer.length-4-n,750*1334*4);
 report.checks.binary={header,bytes:buffer.length};
 await page.locator('#rotate').click();
 await page.waitForFunction(()=>globalThis.__weappPresentationMetrics?.width===1334&&globalThis.__weappPresentationMetrics?.height===750,null,{timeout:15000});
 assert.equal((await simulator.json('/api/state')).sessionId,initial.sessionId);report.checks.resizePreservesSession=true;
 const saved=JSON.parse(await readFile(join(project,'.weapp-container/presentation.json'),'utf8'));assert.equal(saved.logicalWidth,667);report.checks.persistence=true;
 await mkdir(dirname(output),{recursive:true});await page.screenshot({path:output.replace(/\.json$/,'')+'.png',fullPage:true});
 // The embedding client shares the high-density session. Exercise its real
 // pointer bridge too: backing-pixel coordinates would miss this button.
 await apply({logicalWidth:375,logicalHeight:667});
 await page.goto(new URL('/embed',simulator.url).href,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>{
   const canvas=document.querySelector('#screen');
   return canvas.width===750&&canvas.height===1334;
 },null,{timeout:15000});
 await page.evaluate(()=>{
   globalThis.__embeddingCount=null;
   events.addEventListener('bridge',event=>{
     for(const message of JSON.parse(event.data).messages||[])
       for(const envelope of message.payload?.effects||[])
         for(const effect of envelope.events||[])
           if(effect.type==='data.patch.batch')for(const patch of effect.patches||[])
             if(patch.path==='count'&&patch.op==='set')globalThis.__embeddingCount=patch.value;
   });
 });
 const embeddingBounds=await queryBounds('#increment'),embeddingBox=Array.isArray(embeddingBounds)?embeddingBounds[0]:embeddingBounds;
 const embeddingCountBounds=await queryBounds('#count'),embeddingCountBox=Array.isArray(embeddingCountBounds)?embeddingCountBounds[0]:embeddingCountBounds;
 const countPixels=await page.evaluate(box=>Array.from(document.querySelector('#screen').getContext('2d').getImageData(Math.floor(box.left*2),Math.floor(box.top*2),Math.max(1,Math.floor(box.width*2)),Math.max(1,Math.floor(box.height*2))).data),embeddingCountBox);
 const embeddingRect=await page.locator('#screen').boundingBox();
 await page.mouse.click(embeddingRect.x+(embeddingBox.left+embeddingBox.width/2)*embeddingRect.width/375,embeddingRect.y+(embeddingBox.top+embeddingBox.height/2)*embeddingRect.height/667);
 await page.waitForFunction(()=>globalThis.__embeddingCount===51,null,{timeout:15000});
 await page.waitForFunction(({box,before})=>{
   const pixels=document.querySelector('#screen').getContext('2d').getImageData(Math.floor(box.left*2),Math.floor(box.top*2),Math.max(1,Math.floor(box.width*2)),Math.max(1,Math.floor(box.height*2))).data;
   return pixels.some((value,index)=>value!==before[index]);
 },{box:embeddingCountBox,before:countPixels},{timeout:15000});
 assert.equal((await simulator.json('/api/state')).sessionId,initial.sessionId);
 report.checks.embeddingDensityInput={logicalWidth:375,logicalHeight:667,width:750,height:1334,count:51,sharedSession:true,pixelsChanged:true};
 await page.screenshot({path:output.replace(/\.json$/,'')+'-embed.png',fullPage:true});
 assert.deepEqual(browserErrors,[]);report.checks.browserErrors=browserErrors;
 report.status=Object.values(report.gates).every(g=>g.status==='passed')?'passed':'failed';
} catch(error) {
 report.error={name:error.name,code:error.code,message:error.message,stack:error.stack};
 report.outputTail=simulator?.outputTail();
 if(simulator)try{report.failureState=await simulator.json('/api/state',{timeout:2000});}catch(stateError){report.failureState={error:stateError.message};}
 failures.push(error);
} finally {
 for(const [name,close] of [['networkCdp',()=>networkCdp?.detach()],['context',()=>context?.close()],['browser',()=>browser?.close()],['simulator',()=>simulator?.stop()],['temporaryProject',()=>rm(owned,{recursive:true,force:true})]])try{report.cleanup[name]=await close()??true;}catch(error){report.cleanup[name]={error:error.message};failures.push(error);}
 report.environment.loadAverageEnd=loadavg();report.environment.freeMemoryBytesEnd=freemem();signals.dispose();if(failures.length)report.status='failed';
 await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({status:report.status,report:output,gates:report.gates,error:report.error}));
if(report.status!=='passed')process.exitCode=1;
