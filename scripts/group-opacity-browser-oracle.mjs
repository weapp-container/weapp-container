#!/usr/bin/env node
/** Auxiliary native Chromium CSS: never an official WeChat conformance result. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { GROUP_OPACITY_PHASES, compareGroupOpacityPixels, expectedGroupOpacityFrame, groupOpacityData } from './group-opacity-smoke.mjs'
import { sha256, sourceHashes } from './simulator-cli-harness.mjs'

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)))
const FIXTURE=resolve(ROOT,'examples/apps/group-opacity-app')
const options={}
for(let index=2;index<process.argv.length;index+=2) {
  assert.ok(['--package','--out'].includes(process.argv[index]) && process.argv[index+1],`unknown or incomplete argument: ${process.argv[index]}`)
  options[process.argv[index].slice(2)]=resolve(process.argv[index+1])
}
assert.ok(options.out,'--out is required')
const installed=createRequire(options.package ?? resolve(ROOT,'vendor/weapp-vite/package.json'))
const {chromium}=installed('playwright'), run=promisify(execFile), out=options.out, artifacts=out+'.files'
await mkdir(dirname(out),{recursive:true}); await mkdir(artifacts)
const sessions=async()=>(await run('rtk',['proxy','playwright-cli','list'],{cwd:ROOT})).stdout
const sources=async()=>({fixture:await sourceHashes(FIXTURE),script:sha256(await readFile(fileURLToPath(import.meta.url))),
  pixelOracle:sha256(await readFile(resolve(ROOT,'scripts/group-opacity-smoke.mjs'))),
  hashHelper:sha256(await readFile(resolve(ROOT,'scripts/simulator-cli-harness.mjs')))})
const save=async(name,bytes,compressed=false)=>{
  const path=name+(compressed?'.gz':''), data=compressed?gzipSync(bytes,{mtime:0}):bytes
  await writeFile(resolve(artifacts,path),data)
  return {path,sha256:sha256(data),bytes:data.length,...(compressed?{rawSha256:sha256(bytes),rawBytes:bytes.length}:{})}
}
// This HTML model deliberately uses native DOM/CSS and event dispatch. It is
// separate from the WXML runtime and is not represented as WeChat execution.
const html=`<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:320px;height:300px;background:#fff;overflow:hidden}
.group,.outer,.inner,.green,.blue,.nested-blue,.ghost,.ghost-child{position:absolute}
.group{left:10px;top:20px;width:120px;height:100px;background:#f00;opacity:.5}
.green{left:10px;top:10px;width:70px;height:60px;background:#0f0}
.blue{left:40px;top:30px;width:70px;height:60px;background:#00f}
.outer{left:160px;top:20px;width:120px;height:100px;background:#f00;opacity:.5}
.inner{left:10px;top:10px;width:90px;height:70px;background:#0f0;opacity:.5}
.nested-blue{left:30px;top:20px;width:40px;height:40px;background:#00f}
.ghost{left:10px;top:150px;width:80px;height:50px;background:#0f0;opacity:0}
.ghost-child{left:10px;top:10px;width:60px;height:30px;background:#00f;opacity:1}
.control{position:absolute;top:240px;width:70px;height:30px}
.reset{left:10px;background:#334155}.inspect{left:100px;background:#64748b}
</style><div id="group" class="measured group"><div id="green" class="measured green"></div><div id="blue" class="measured blue"></div></div>
<div id="outer" class="measured outer"><div id="inner" class="measured inner"><div id="nested-blue" class="measured nested-blue"></div></div></div>
<div id="ghost" class="measured ghost" data-case="ancestor"><div id="ghost-child" class="measured ghost-child" data-case="invisible-child"></div></div>
<div id="reset" class="control reset"></div><div id="inspect" class="control inspect"></div>`
const report={schemaVersion:1,status:'failed',startedAt:new Date().toISOString(),phases:[],
  boundary:'Auxiliary headless Chromium HTML/CSS model with native computed styles, coordinate clicks, screenshots and decoded full RGBA. No container runtime, WeChat DevTools, strict conformance, GPU/device or performance result.',
  pixelAssertionBoundary:'All screenshot RGBA channels checked against independently fixed group-composited rectangles, RGB tolerance one byte, alpha exact. The HTML model is an auxiliary CSS oracle and does not certify WeChat WXML behavior.',
  ownership:{owner:'/root',label:'opacity1022',cwd:ROOT,entrypoint:'standalone Playwright; no CDP/profile/extension',
    headlessRequested:true,taskCreated:true,retainedResources:[]},cleanup:{errors:[]}}
let browser,context,contextClosed=false,browserClosed=false
try {
  report.sourceBefore=await sources(); report.sessionsBefore=await sessions()
  const pkg=installed.resolve('playwright/package.json'), executable=chromium.executablePath(), pkgBytes=await readFile(pkg)
  report.dependencies={playwright:{path:pkg,version:JSON.parse(pkgBytes).version,sha256:sha256(pkgBytes)},
    chromium:{path:executable,sha256:sha256(await readFile(executable))}}
  browser=await chromium.launch({headless:true}); browser.once('disconnected',()=>{browserClosed=true})
  context=await browser.newContext({viewport:{width:320,height:300},deviceScaleFactor:1})
  context.once('close',()=>{contextClosed=true})
  const page=await context.newPage(), errors=[]
  page.on('pageerror',error=>errors.push(error.stack??String(error)))
  report.browser={version:browser.version(),userAgent:await page.evaluate(()=>navigator.userAgent)}
  assert.match(report.browser.userAgent,/HeadlessChrome\//); report.ownership.effectiveHeadless=true
  await page.setContent(html)
  report.html=await save('model.html',Buffer.from(html))
  await page.evaluate(()=>{
    window.model={data:{groupOpacity:.5,ghostOpacity:0,hiddenTaps:0,resets:0},hits:[],observation:null}
    const model=window.model, get=id=>document.getElementById(id)
    get('ghost-child').addEventListener('click',event=>{
      model.hits.push({target:event.target.id,currentTarget:event.currentTarget.id,
        dataset:{...event.currentTarget.dataset},beforeOpacity:model.data.ghostOpacity})
      model.data={...model.data,groupOpacity:1,ghostOpacity:1,hiddenTaps:model.data.hiddenTaps+1}
      get('group').style.opacity='1';get('ghost').style.opacity='1'
    })
    get('ghost').addEventListener('click',event=>model.hits.push({target:event.target.id,
      currentTarget:event.currentTarget.id,dataset:{...event.currentTarget.dataset}}))
    get('reset').addEventListener('click',()=>{
      model.data={...model.data,groupOpacity:.5,ghostOpacity:0,resets:model.data.resets+1}
      get('group').style.opacity='.5';get('ghost').style.opacity='0'
    })
    get('inspect').addEventListener('click',()=>{
      model.observation={data:{...model.data},hits:structuredClone(model.hits),
        geometry:[...document.querySelectorAll('.measured')].map(node=>{
          const box=node.getBoundingClientRect(),style=getComputedStyle(node)
          return {id:node.id,left:box.left,top:box.top,width:box.width,height:box.height,
            opacity:style.opacity,backgroundColor:style.backgroundColor,pointerEvents:style.pointerEvents,visibility:style.visibility}
        })}
    })
  })
  for(const phase of GROUP_OPACITY_PHASES) {
    if(phase==='restored'||phase==='restored-again') await page.mouse.click(30,170)
    if(phase==='hidden-again') await page.mouse.click(20,250)
    await page.mouse.click(110,250)
    const observed=await page.evaluate(()=>window.model.observation),data=groupOpacityData(phase)
    const entry={phase,status:'failed',observed};report.phases.push(entry)
    const png=await page.screenshot({type:'png',fullPage:false,animations:'disabled',caret:'hide',scale:'css'})
    // Decode actual screenshot bytes in the same owned browser. This does not
    // reconstruct DOM pixels with a synthetic canvas scene.
    const decoded=await page.evaluate(async base64=>{
      const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode()
      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight
      const context=canvas.getContext('2d');context.drawImage(image,0,0)
      return {width:canvas.width,height:canvas.height,pixels:[...context.getImageData(0,0,canvas.width,canvas.height).data]}
    },png.toString('base64'))
    assert.equal(decoded.width,320);assert.equal(decoded.height,300)
    const rgba=Buffer.from(decoded.pixels)
    entry.screenshot=await save(`${phase}.png`,png)
    entry.rgba=await save(`${phase}.rgba`,rgba,true)
    assert.deepEqual(observed.data,data)
    assert.deepEqual(observed.hits,Array.from({length:data.hiddenTaps},()=>[
      {target:'ghost-child',currentTarget:'ghost-child',dataset:{case:'invisible-child'},beforeOpacity:0},
      {target:'ghost-child',currentTarget:'ghost',dataset:{case:'ancestor'}}]).flat())
    const boxes=expectedGroupOpacityFrame(phase).boxes
    assert.deepEqual(observed.geometry.map(node=>node.id),Object.keys(boxes))
    for(const node of observed.geometry) {
      for(const [key,value] of Object.entries(boxes[node.id])) assert.equal(node[key],value)
      const expectedOpacity=node.id==='group'?String(data.groupOpacity):node.id==='ghost'?String(data.ghostOpacity)
        :['outer','inner'].includes(node.id)?'0.5':'1'
      assert.equal(node.opacity,expectedOpacity)
      assert.equal(node.pointerEvents,'auto');assert.equal(node.visibility,'visible')
    }
    const compared=compareGroupOpacityPixels(rgba,phase,{strict:false})
    Object.assign(entry,compared,{semanticStatus:'passed',status:compared.comparisonPassed?'passed':'failed'})
    assert.equal(context.pages().length,1)
  }
  assert.deepEqual(errors,[]);report.pageErrors=errors
  const hashes=report.phases.map(phase=>phase.rgbaSha256)
  assert.notEqual(hashes[0],hashes[1]);assert.equal(hashes[0],hashes[2]);assert.equal(hashes[1],hashes[3])
  report.semanticStatus='passed'
  report.pixelComparisonStatus=report.phases.every(phase=>phase.comparisonPassed)?'passed':'failed'
  report.status=report.pixelComparisonStatus
  if(report.status!=='passed') {
    report.pixelDifferenceBoundary='Observed Chromium screenshot differs from the fixed alpha8 mathematical reference. Full pixels and original comparisons are retained; this is a failed auxiliary pixel differential, never an accepted parity result.'
    process.exitCode=1
  }
} catch(error) {report.error=error.stack??String(error);process.exitCode=1}
finally {
  try{if(context)await context.close()}catch(error){report.cleanup.errors.push(`context: ${error.message}`)}
  try{if(browser)await browser.close()}catch(error){report.cleanup.errors.push(`browser: ${error.message}`)}
  report.cleanup.contextClosed=contextClosed;report.cleanup.browserDisconnected=browserClosed
  try{report.sessionsAfter=await sessions();assert.equal(report.sessionsAfter,report.sessionsBefore)}
  catch(error){report.cleanup.errors.push(`sessions: ${error.message}`)}
  if(!contextClosed||!browserClosed||report.cleanup.errors.length){report.status='failed';process.exitCode=1}
  report.sourceAfter=await sources()
  if(JSON.stringify(report.sourceBefore)!==JSON.stringify(report.sourceAfter)){report.status='failed';process.exitCode=1}
  report.endedAt=new Date().toISOString();await writeFile(out,JSON.stringify(report,null,2)+'\n')
  process.stdout.write(JSON.stringify({status:report.status,phases:report.phases.length,cleanup:report.cleanup,out})+'\n')
}
