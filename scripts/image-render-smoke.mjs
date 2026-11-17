#!/usr/bin/env node
/** Actual pinned weapp-vite output, both native engines and Skia CPU pixels. */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createOwnedCommandRunner, matchedResponse, sha256, sourceHashes } from './simulator-cli-harness.mjs'
import { validateCompiler } from './scrolling-smoke.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE = resolve(ROOT, 'examples/apps/image-contract-app')
const COLORS = [[220,20,60], [255,128,0], [255,220,0], [0,160,70],
  [0,180,210], [20,80,220], [130,50,200], [230,30,170],
  [120,70,30], [90,100,110], [230,240,250], [15,20,25]].map(rgb => [...rgb,255])
const MODES = ['scale','fit','fill','width','height','top','bottom','center',
  'left','right','top-left','top-right','bottom-left','bottom-right']
const CORNERS = { scale:[0,3,8,11], fill:[0,3,8,11], top:[1,2,5,6], bottom:[5,6,9,10],
  center:[1,2,9,10], left:[0,1,8,9], right:[2,3,10,11],
  'top-left':[0,1,4,5], 'top-right':[2,3,6,7], 'bottom-left':[4,5,8,9], 'bottom-right':[6,7,10,11] }
const request = (requestId, op, payload) => ({protocolVersion:'1.0',sessionId:'simulator-1',requestId,kind:'request',op,payload})
const tap = (id,x,y) => request(id,'event.batch',{events:[{type:'tap',x,y}]})
const render = (id,blobs) => request(id,'render.commit',{templateId:'template:pages/index/index.wxml',blobs,viewport:{width:360,height:400}})

export function inspectImageResult(trace, snapshot, report, engine, phase, expectedRequests) {
  assert.equal(report.engine,engine)
  assert.equal(report.renderer,'skia-raster','requires actual native CPU rendering')
  const rejected = phase === 'rejected', sawRejection = rejected || phase === 'recovered'
  // The CLI report describes process completion; the correlated bridge
  // responses below decide whether each operation actually succeeded.
  assert.equal(report.status,'passed')
  assert.equal(trace.traceSummary.complete,true)
  const records = trace.records ?? trace.events
  assert.equal(records.length,trace.traceSummary.totalRecords)
  assert.equal(records.length,4+expectedRequests.length,'every startup and scripted request must be retained')
  assert.deepEqual(records.slice(0,4).map(record=>record.request.op),['app.init','app.lifecycle','page.push','render.commit'])
  assert.deepEqual(records.slice(4).map(record=>record.request),expectedRequests,'trace must contain the exact scripted requests in order')
  assert.equal(new Set(records.map(record=>record.request.requestId)).size,records.length,'request IDs must be unique')
  for(const record of records) {
    const {request:sent,response:batch}=record
    assert.equal(sent.kind,'request'); assert.equal(sent.sessionId,'simulator-1'); assert.equal(sent.protocolVersion,'1.0')
    const responses=batch.messages.filter(message=>message.kind==='response')
    assert.equal(responses.length,1,`${sent.requestId}: exactly one response, including foreign responses`)
    const response=responses[0]
    assert.equal(response.requestId,sent.requestId); assert.equal(response.sessionId,sent.sessionId)
    assert.equal(response.op,sent.op); assert.equal(response.protocolVersion,sent.protocolVersion)
    if(sent.requestId==='reject-render') {
      assert.equal(sawRejection,true)
      assert.equal(response.payload.ok,false); assert.equal(response.payload.committed,false)
      assert.equal(response.payload.error.code,'ERR_UNSUPPORTED_CAPABILITY')
    } else {
      matchedResponse(trace,sent.requestId,sent.op)
      assert.deepEqual(batch.messages.filter(message=>message.op==='error'||message.payload?.ok===false),[],`${sent.requestId}: no unplanned runtime failures`)
    }
  }
  const failures = records.filter(record => record.response.messages.some(message => message.kind === 'response' && message.payload?.ok === false))
  assert.equal(failures.length,Number(sawRejection))
  if(sawRejection) {
    assert.equal(failures[0].request.requestId,'reject-render')
    const failure = failures[0].response.messages.find(message => message.kind === 'response')
    assert.equal(failure.payload.committed,false)
    assert.equal(failure.payload.error.code,'ERR_UNSUPPORTED_CAPABILITY')
  }
  const observation = matchedResponse(trace,'read','api.call').result
  assert.equal(observation.route,'pages/index/index')
  assert.deepEqual(observation.trace,['load','show','ready'])
  assert.equal(observation.data.taps,phase === 'initial' ? 0 : 1)
  assert.equal(observation.data.src,rejected ? 'https://example.invalid/image.png' : phase === 'swapped' ? '/assets/alpha.png' : '/assets/grid.png')
  assert.deepEqual(matchedResponse(trace,'read-tap','api.call').result,{id:'dynamic',dataset:{case:'dynamic'}})
  const geometry=Object.fromEntries(observation.geometry.map(node=>[node.id,node]))
  assert.equal(Object.keys(geometry).length,20)
  const near=(actual,expected,label)=>assert.ok(Number.isFinite(actual)&&Math.abs(actual-expected)<0.02,`${label}: ${actual} != ${expected}`)
  const box=(id,left,top,width,height)=> {
    for(const [key,expected] of Object.entries({left,top,width,height})) near(geometry[id][key],expected,`${id}.${key}`)
  }
  for(const [index,id] of MODES.entries()) box(id,10+(index%4)*50,10+Math.floor(index/4)*50,
    id === 'height' ? 160/3 : 40,id === 'width' ? 30 : 40)
  box('dynamic',220,10,80,60)
  box('width-ratio',220,100,100,75)
  box('height-ratio',220,190,40,30)
  box('percent-ratio',220,240,50,37.5)
  box('default',1000,0,300,225)
  box('empty',1000,0,300,225)
  assert.equal(snapshot.width,360); assert.equal(snapshot.height,400)
  assert.equal(snapshot.stride,1440); assert.equal(snapshot.pixels.length,576000)
  const pixel=(x,y)=>snapshot.pixels.slice(y*snapshot.stride+x*4,y*snapshot.stride+x*4+4)
  for(const [id,indices] of Object.entries(CORNERS)) {
    const position=MODES.indexOf(id),x=10+(position%4)*50,y=10+Math.floor(position/4)*50
    for(const [sample,[dx,dy]] of [[5,5],[35,5],[5,35],[35,35]].entries()) {
      assert.deepEqual(pixel(x+dx,y+dy),COLORS[indices[sample]],`${phase}/${id} corner ${sample}`)
    }
  }
  assert.deepEqual(pixel(65,10),[238,238,238,255],'aspectFit letterbox retains the node background')
  assert.deepEqual(pixel(65,16),COLORS[0],'aspectFit fits the whole image inside the content box')
  assert.deepEqual(pixel(119,19),COLORS[1],'aspectFill crops the centered source rather than stretching')
  assert.deepEqual(pixel(165,35),COLORS[8],'widthFix paints the automatic height')
  assert.deepEqual(pixel(55,95),COLORS[11],'heightFix paints the automatic width')
  assert.deepEqual(pixel(15,235),[60,160,240,255],'component-relative resource uses its distinct lexical WXML source')
  assert.deepEqual(pixel(225,15),phase === 'swapped' || rejected ? [127,227,177,255] : COLORS[0],
    'dynamic resource replacement and premultiplied source-over')
  return {geometry:observation.geometry,rgbaSha256:sha256(Buffer.from(snapshot.pixels)),src:observation.data.src}
}

export async function main(argv=process.argv.slice(2)) {
  const options={},names=new Map([['--simulator-bin','simulatorBin'],['--compiler-root','compilerRoot'],
    ['--compiler-dist-hashes','compilerDistHashes'],['--out','out']])
  for(let index=0;index<argv.length;index++) {
    const name=names.get(argv[index]); assert.ok(name&&argv[index+1],`unknown or incomplete argument: ${argv[index]}`)
    options[name]=resolve(argv[++index])
  }
  for(const name of ['simulatorBin','compilerRoot','compilerDistHashes','out']) assert.ok(options[name],`${name} is required`)
  await mkdir(dirname(options.out),{recursive:true})
  const artifacts=options.out+'.files'; await mkdir(artifacts)
  const temporary=await mkdtemp(resolve(tmpdir(),'weapp-images-'))
  const runner=createOwnedCommandRunner({cwd:ROOT,timeoutMs:180000}),{command}=runner
  const result={schemaVersion:1,status:'failed',engines:[],cleanup:{},
    boundary:'Actual pinned compiler output, QuickJS/V8 handlers, selector geometry and Skia CPU RGBA. Static packaged PNG image modes only; not official DevTools, async image events, remote images, GPU/device or performance acceptance.'}
  const sources=async()=>({fixture:await sourceHashes(FIXTURE),crates:await sourceHashes(resolve(ROOT,'crates')),
    packer:await sourceHashes(resolve(ROOT,'tools/container-manifest/src')),
    packerBin:await sourceHashes(resolve(ROOT,'tools/container-manifest/bin')),
    ...Object.fromEntries(await Promise.all(['Cargo.toml','Cargo.lock','scripts/image-render-smoke.mjs','scripts/simulator-cli-harness.mjs','scripts/scrolling-smoke.mjs']
      .map(async path=>[path,sha256(await readFile(resolve(ROOT,path)))])))})
  const save=async(name,bytes,compress=false)=> {
    const data=compress?gzipSync(bytes,{mtime:0}):bytes,path=name+(compress?'.gz':'')
    await writeFile(resolve(artifacts,path),data)
    return {path,sha256:sha256(data),...(compress?{rawSha256:sha256(bytes)}:{})}
  }
  try {
    result.commit=(await command('git',['rev-parse','HEAD'])).stdout.trim()
    result.sourceBefore=await sources()
    result.simulator={path:options.simulatorBin,sha256:sha256(await readFile(options.simulatorBin))}
    const commit=(await command('git',['rev-parse','HEAD:vendor/weapp-vite'])).stdout.trim()
    result.compiler={before:await validateCompiler(options,command,commit)}
    const project=resolve(temporary,'project'),dist=resolve(temporary,'dist'),pack=resolve(temporary,'pack')
    await cp(FIXTURE,project,{recursive:true})
    result.build=await save('compiler-build.json',Buffer.from(JSON.stringify(await command(process.execPath,
      [resolve(options.compilerRoot,'packages/weapp-vite/bin/weapp-vite.js'),'build',project,'-p','weapp','--outDir',dist]),null,2)))
    result.compiler.after=await validateCompiler(options,command,commit)
    assert.deepEqual(result.compiler.before,result.compiler.after)
    result.rawOutput=await sourceHashes(dist)
    await command(process.execPath,['tools/container-manifest/bin/container-pack.mjs',dist,'--out',pack,'--compiler-commit',commit])
    assert.deepEqual(await sourceHashes(dist),result.rawOutput)
    const manifestBytes=await readFile(resolve(pack,'manifest.json')),manifest=JSON.parse(manifestBytes)
    assert.equal(manifest.compiler.commit,commit)
    for(const path of ['assets/grid.png','assets/alpha.png','components/tile/local.png']) assert.ok(manifest.assets.some(asset=>asset.path===path),`actual build missing ${path}`)
    assert.notEqual(manifest.assets.find(asset=>asset.path==='assets/grid.png').sha256,
      manifest.assets.find(asset=>asset.path==='components/tile/local.png').sha256,'component resource must have distinct bytes')
    result.manifest=await save('manifest.json',manifestBytes); result.integrityRoot=manifest.integrity.root
    const blobs={}
    for(const name of await readdir(resolve(pack,'blobs/sha256'))) {
      const bytes=await readFile(resolve(pack,'blobs/sha256',name)); assert.equal(sha256(bytes),name)
      blobs[`sha256:${name}`]=[...bytes]
    }
    result.blobs=await save('blobs.json',Buffer.from(JSON.stringify(blobs)),true)
    for(const engine of ['quickjs','v8']) {
      const entry={engine,phases:[]}; result.engines.push(entry)
      for(const phase of ['initial','swapped','rejected','recovered']) {
        const prefix=resolve(temporary,`${engine}-${phase}`)
        const script=[tap('image-tap',225,15)]
        if(phase!=='initial') script.push(tap('swap',15,345),render('swap-render',blobs))
        if(['rejected','recovered'].includes(phase)) script.push(tap('unsupported',95,345),render('reject-render',blobs))
        if(phase==='recovered') script.push(tap('recover',175,345),render('recover-render',blobs))
        script.push(tap('inspect',255,345),request('read','api.call',{name:'wx.getStorageSync',key:'image:observation'}),
          request('read-tap','api.call',{name:'wx.getStorageSync',key:'image:tap'}))
        await writeFile(prefix+'.jsonl',script.map(message=>JSON.stringify(message)).join('\n')+'\n')
        const receipt=await command(options.simulatorBin,['run','--pack',pack,'--engine',engine,'--viewport','360x400',
          '--script',prefix+'.jsonl','--trace',prefix+'.trace.json','--snapshot',prefix+'.snapshot.json','--report',prefix+'.report.json'])
        const trace=await readFile(prefix+'.trace.json'),snapshot=await readFile(prefix+'.snapshot.json'),native=await readFile(prefix+'.report.json')
        const phaseResult={name:phase,receipt:await save(`${engine}-${phase}.command.json`,Buffer.from(JSON.stringify(receipt,null,2))),
          trace:await save(`${engine}-${phase}.trace.json`,trace,true),snapshot:await save(`${engine}-${phase}.snapshot.json`,snapshot,true),
          native:await save(`${engine}-${phase}.report.json`,native)}
        entry.phases.push(phaseResult)
        phaseResult.observation=inspectImageResult(JSON.parse(trace),JSON.parse(snapshot),JSON.parse(native),engine,phase,script)
        phaseResult.status='passed'
      }
      const hashes=entry.phases.map(phase=>phase.observation.rgbaSha256)
      assert.notEqual(hashes[0],hashes[1]); assert.equal(hashes[1],hashes[2],'rejection preserves accepted pixels'); assert.equal(hashes[0],hashes[3],'recovery paints the original image')
      entry.status='passed'
    }
    assert.deepEqual(result.engines[0].phases.map(phase=>phase.observation),result.engines[1].phases.map(phase=>phase.observation))
    assert.deepEqual(await sourceHashes(dist),result.rawOutput); result.rawOutputUnmodified=true
    result.sourceAfter=await sources(); assert.deepEqual(result.sourceBefore,result.sourceAfter)
    assert.equal(sha256(await readFile(options.simulatorBin)),result.simulator.sha256)
    result.status='passed'
  } catch(error) {
    result.error=error.stack??String(error)
    if(error.result) result.failedCommand=await save('failed-command.json',Buffer.from(JSON.stringify(error.result,null,2)))
  } finally {
    const errors=[]
    try {assert.equal(runner.active,null); result.cleanup.childrenStopped=true}catch(error){errors.push(String(error))}
    try {await rm(temporary,{recursive:true,force:true}); result.cleanup.temporaryRemoved=true}catch(error){errors.push(String(error))}
    try {runner.dispose()}catch(error){errors.push(String(error))}
    if(errors.length){result.status='failed';result.cleanup.errors=errors}
    await writeFile(options.out,JSON.stringify(result,null,2)+'\n')
  }
  process.stdout.write(JSON.stringify({status:result.status,report:options.out,cleanup:result.cleanup})+'\n')
  if(result.status!=='passed')process.exitCode=1
  return result
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main()
