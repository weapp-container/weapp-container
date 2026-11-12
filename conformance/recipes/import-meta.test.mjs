/** Synthetic contracts only. No official trace, receipt, host or engine execution is produced. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntimeTraceCollector } from '../../scripts/conformance-recipes.mjs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { descriptor } from './import-meta-descriptor.mjs'
import { readinessPolicies } from './import-meta-source-policy.mjs'
import { createCollector } from './import-meta-collector.mjs'
import { encodeMethodValue } from './source-method-values.mjs'
import { importMetaActionTape, replayImportMeta } from '../../examples/hosts/conformance-desktop/import-meta-replay.mjs'
import { assertImportMetaOutputs } from '../../examples/hosts/conformance-desktop/import-meta-static.mjs'
import { instrumentGithubSharedRuntime, githubProducerInvocation } from '../../scripts/conformance-github-producer.mjs'
const root = new URL('../../', import.meta.url), hash = b => createHash('sha256').update(b).digest('hex')
const plan = descriptor.plans[0], policy = readinessPolicies[plan.steps[0].sourceCallsite]
const runtime = () => ({ dirname: '/pages/issue-431', url: '/pages/issue-431/index.js',
  snapshot: JSON.stringify({ dirname: '/pages/issue-431', filename: '/pages/issue-431/index.js', url: '/pages/issue-431/index.js', extra: true }), extra: true })
const groups = () => plan.steps.at(-1).queries.map(({ fields, ...address }) => ({ ...address, count: 1,
  nodes: [{ ...(fields.text ? { text: 'actual synthetic text '+address.selector } : {}),
    ...(fields.attributes.length ? { attributes: { src: 'https://static.example.com/issue-431/logo.png' } } : {}) }] }))
const source = await readFile(new URL('vendor/weapp-vite/'+descriptor.caseSourcePath, root), 'utf8')
function staticInputs() {
  const text = `data-case="double" data-case='single'
data-template-url="{{'/pages/issue-431/index.wxml'}}"
data-template-dir='{{"/pages/issue-431"}}'
data-env-label="{{'issue-431 native wxml env replacement'}}"
data-env-base='{{"https://static.example.com/issue-431"}}'`
  const bytes = Buffer.from(text)
  return { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256,
    files: [{ path: plan.route+'.wxml', bytes, sha256: hash(bytes), length: bytes.length }] }
}
function passive(samples = [runtime(), runtime()]) {
  let stamp = 1000, at = 0, page, consumed = 0
  const events = [], errors = [], calls = [], collector = createCollector({ clock: () => stamp,
    emit: event => events.push({ ...structuredClone(event), seq: events.length }) })
  const program = { async reLaunch(route) { page = { path: route.replace(/^\//,''), pageId: 42,
    async callMethod(name, ...args) { calls.push({ name, args, receiver: this }); consumed++
      const item = samples[at++]; if (Object.hasOwn(item, 'throw')) throw item.throw; return item },
    async waitFor(ms) { stamp += ms } }; return page }, async currentPage() { return page } }
  collector.attach(program)
  const begin = () => collector.readinessStart({ session: program, page, route: plan.route, timeoutMs: 12000,
    startedAt: stamp, helperSha256: plan.steps[0].readinessHelperSha256 })
  const finish = token => collector.readinessEnd(token)
  const run = async () => {
    page = await program.reLaunch('/'+plan.route); const token = begin(); let ready = false
    try {
      while (stamp <= 13000) {
        try { ready = policy.ready(await page.callMethod('_runE2E')); if (ready) break }
        catch(error) { errors.push(error) }
        stamp += policy.pollMs
      }
      assert.equal(ready,true)
    } finally { finish(token) }
    const value = await page.callMethod('_runE2E')
    collector.checkpoint({ evidence: { id: 'initial', route: plan.route, nodes: groups() } }, { session: program, page })
    collector.flush()
    return { value, trace: { caseId: descriptor.caseId, oracle: 'wechat-devtools', run: { status: 'passed' }, events,
      assertions: [{ id: plan.fullName, passed: true }] } }
  }
  return { run, program, collector, begin, finish, errors, calls, setStamp: value => { stamp=value }, get consumed(){return consumed} }
}
const startup = engine => ({ engine, sessionId: 'synthetic-import-meta-only' })
function native(engine, samples = [runtime(),runtime()], { mutate, rejectFinal } = {}) {
  const calls = []; let stamp = 1000, at = 0, pump = 0, action = 0, required = 0, revision = 1, pageId = 1, route = 'pages/home/index'
  const proof = () => ({ kind: 'owner-pump-native-presentation-v1', sessionId: startup(engine).sessionId, route, pageId: String(pageId),
    templateRevision: String(revision), consumedTemplateRevision: String(revision), frameId: String(revision+10), renderRevision: String(revision),
    presentationAckRevision: String(revision), actionSeq: String(action), ownerPumpSeq: String(pump), requiredPumpSeq: String(required), presented: true })
  const act = () => { action++; required=pump+1; pump++; revision++ }
  const request = async (op,payload={}) => {
    calls.push({op,payload:structuredClone(payload)});pump++;let result
    if(op==='render.settle')result=proof()
    else if(op==='reLaunch'){route=payload.route.replace(/^\//,'');pageId++;act();result={path:route,completion:proof()}}
    else if(op==='currentPage')result={path:route,pageId:String(pageId),completion:proof()}
    else if(op==='checkpoint')result={id:'initial',route,nodes:groups(),completion:proof()}
    else if(op==='method.call'){
      const item=samples[at++];if(rejectFinal&&payload.source.callsite===plan.steps[1].sourceCallsite)throw rejectFinal
      act();const observation=Object.hasOwn(item,'throw')?{kind:'rejected',ticket:'unit/'+at,reason:item.throw===undefined?{kind:'undefined'}
        :item.throw===null||['boolean','string','number'].includes(typeof item.throw)?{kind:'json',value:item.throw}:{kind:'uninspectable',valueType:typeof item.throw}}
        :{kind:'fulfilled',ticket:'unit/'+at,value:encodeMethodValue(item)}
      result={kind:'native-guest-method-result-v1',owner:{kind:'source-labelled-native-method-owner-v1',engine,sessionId:startup(engine).sessionId,
        sourceInvocationId:payload.sourceInvocationId,sourceDeclaration:structuredClone(payload.source),sourceDeclarationTrust:'caller-declared-not-official-oracle',
        route,pageId:String(pageId),originalDeadlineNs:payload.deadlineNs,deadlineClock:'original-unix-deadline-plus-once-anchored-monotonic-budget',
        sessionBeginAttempts:1,sessionPollAttempts:2,requestSha256:'a'.repeat(64),receiverTokenSha256:'b'.repeat(64)},observation,completion:proof()}
    }else throw new Error('unplanned synthetic op '+op)
    return mutate?.(result,op,payload,()=>{stamp=13001})??result
  }
  return {calls,request,readinessClock:()=>stamp,readinessWait:async ms=>{stamp+=ms},get stamp(){return stamp}}
}
const replay = (engine, wire, trace, input=staticInputs()) => replayImportMeta({ ...wire, startup: startup(engine), oracleTrace: trace, staticInputs: input })

test('exact indexed source, helper, method callsites and descriptor contain all original six DOM addresses without expected values',async()=>{
  assert.equal(hash(Buffer.from(source)),descriptor.sourceSha256)
  for(const ref of descriptor.sourceGuards){const b=await readFile(new URL('vendor/weapp-vite/'+ref.path,root));assert.equal(hash(b),ref.sha256);assert.equal(b.length,ref.bytes)}
  assert.equal(plan.fullName,"github-issues runtime import.meta bindings issue #431: renders supported native wxml import.meta bindings at runtime")
  assert.deepEqual(plan.steps.map(x=>x.kind),['method.readiness','method.call','checkpoint'])
  assert.equal(source.split('\n')[45].trim(),"const runtime = await page.callMethod('_runE2E')")
  assert.equal(source.split('\n')[55].trim(),"const runtime = await page.callMethod('_runE2E')")
  assert.ok(!JSON.stringify(descriptor).includes('https://static.example.com'))
  assert.equal(policy.timeoutMs,12000);assert.equal(policy.pollMs,220);assert.equal(policy.ready(runtime()),true);assert.equal(policy.ready(undefined),false)
})
test('each synthetic engine preserves repeated false/throw/fulfilled readiness attempts and one final call with unique source invocation ids',async()=>{
  for(const engine of ['quickjs','v8'])for(const thrown of [new Error('actual object'), 'actual primitive', undefined]){
    const samples=[{url:'still pending'},{throw:thrown},runtime(),runtime()],p=passive(samples),{trace}=await p.run()
    assert.equal(p.errors[0],thrown)
    assert.deepEqual(trace.events.map(x=>x.op),['route.active','method.readiness','method.readiness','method.readiness','method.call','dom.checkpoint'])
    const wire=native(engine,samples),result=await replay(engine,wire,trace)
    assert.deepEqual(result.events,trace.events);assert.equal(result.methodFacts.length,4)
    assert.equal(result.staticCoverage.originalStaticExpectations,9);assert.equal(result.staticCoverage.originalRuntimeExpectations,2)
    assert.equal(wire.calls.filter(x=>x.op==='method.call'&&x.payload.source.callsite===plan.steps[1].sourceCallsite).length,1)
    assert.equal(new Set(result.methodFacts.map(x=>x.owner.sourceInvocationId)).size,4)
    assert.deepEqual(wire.calls.filter(x=>x.op==='method.call').map(x=>x.payload.source.callsite),[...Array(3).fill(plan.steps[0].sourceCallsite),plan.steps[1].sourceCallsite])
  }
})
test('oracle readiness counts/return values never drive IPC; complete actual trace alone decides equality',async()=>{
  const a=(await passive([runtime(),runtime()]).run()).trace,b=(await passive([{url:'pending'},runtime(),runtime()]).run()).trace
  assert.deepEqual(importMetaActionTape(a),importMetaActionTape(b))
  const wire=native('quickjs');await assert.rejects(replay('quickjs',wire,b),/complete actual.*trace differs/)
  assert.equal(wire.calls.filter(x=>x.op==='method.call').length,2)
  const bytes=JSON.stringify(wire.calls);assert.equal(bytes.includes('still pending'),false);assert.equal(bytes.includes('native wxml env replacement'),false)
})
test('missing, reordered, premature-ready and changed-source readiness traces fail before native work',async()=>{
  const original=(await passive([{url:'pending'},runtime(),runtime()]).run()).trace
  for(const alter of [x=>x.events.splice(1,1),x=>{x.events[1].payload.ready=true},x=>{x.events[2].payload.ready=false},
    x=>{x.events[1].payload.sourceCallsite+='other'},x=>{x.events[2].payload.attemptOrdinal=0},x=>{x.events[3].payload.args=[1]}]){
    const trace=structuredClone(original);alter(trace);const wire=native('quickjs');await assert.rejects(replay('quickjs',wire,trace));assert.equal(wire.calls.length,0)
  }
})
test('readiness requires explicit source scope and a finished predicate before the final source method',async()=>{
  const p=passive();const page=await p.program.reLaunch('/'+plan.route)
  assert.deepEqual(await page.callMethod('_runE2E'),runtime())
  assert.throws(()=>p.collector.flush(),/source scope|source-step/)
  const q=passive([{url:'pending'},runtime()]);const current=await q.program.reLaunch('/'+plan.route),token=q.begin()
  await current.callMethod('_runE2E');assert.throws(()=>q.finish(token),/never met/);assert.throws(()=>q.collector.flush())
})
test('pending/late readiness and absent original scope completion fail closed while original results survive',async()=>{
  const p=passive([runtime(),runtime()]),page=await p.program.reLaunch('/'+plan.route),token=p.begin();p.setStamp(13001)
  assert.deepEqual(await page.callMethod('_runE2E'),runtime());assert.throws(()=>p.finish(token),/deadline|scope/);assert.throws(()=>p.collector.flush())
  const q=passive(),current=await q.program.reLaunch('/'+plan.route);q.begin();await current.callMethod('_runE2E')
  assert.deepEqual(await current.callMethod('_runE2E'),runtime());assert.throws(()=>q.collector.flush(),/scope/)
})
test('source deadline prevents an unsuccessful readiness loop reaching final method or DOM',async()=>{
  const trace=(await passive().run()).trace,wire=native('quickjs',Array.from({length:100},()=>({url:'pending'})))
  // Use a deterministic logical source clock; no twelve-second wall-clock wait.
  let stamp=1000;wire.readinessClock=()=>stamp;wire.readinessWait=async()=>{stamp+=4000}
  await assert.rejects(replay('quickjs',wire,trace),/deadline|timed out/)
  assert.equal(wire.calls.filter(x=>x.op==='method.call').length,4);assert.equal(wire.calls.some(x=>x.op==='checkpoint'),false)
})
test('final method transport failure is preserved and is never retried by readiness handling',async()=>{
  const trace=(await passive().run()).trace,error=new Error('final transport failure'),wire=native('v8',undefined,{rejectFinal:error})
  await assert.rejects(replay('v8',wire,trace),actual=>actual===error)
  assert.equal(wire.calls.filter(x=>x.op==='method.call').length,2);assert.equal(wire.calls.some(x=>x.op==='checkpoint'),false)
})
test('native owner substitution fails immediately and cannot be swallowed as a readiness callback retry',async()=>{
  const trace=(await passive().run()).trace
  for(const patch of [o=>{o.engine='foreign'},o=>{o.sessionId='foreign'},o=>{o.pageId='999'},o=>{o.sourceDeclaration.callsite+='foreign'},o=>{o.originalDeadlineNs='1'}]){
    const wire=native('quickjs',undefined,{mutate(result,op){if(op==='method.call')patch(result.owner)}})
    await assert.rejects(replay('quickjs',wire,trace),/same-source/);assert.equal(wire.calls.filter(x=>x.op==='method.call').length,1)
  }
})
test('all nine original WXML literal/regex/negative assertions and two runtime partial objects execute independently of DOM',async()=>{
  const input=staticInputs(),result={route:plan.route,method:'_runE2E',sourceCallsite:plan.steps[1].sourceCallsite,value:runtime()}
  assert.equal(assertImportMetaOutputs(input,{methodResults:[result]}).assertionCoverage.length,11)
  const lines=source.split('\n').map(x=>x.trim()).filter(x=>/^expect\(pageWxml\)/.test(x));assert.equal(lines.length,9)
  for(const line of lines){const match=line.match(/^expect\(pageWxml\)\.(not\.)?(toContain|toMatch)\((.*)\)$/),value=runInNewContext('('+match[3]+')')
    assert.equal(match[2]==='toContain'?input.files[0].bytes.toString().includes(value):new RegExp(value.source,value.flags).test(input.files[0].bytes.toString()),!match[1])}
  for(const change of [v=>{v.dirname='wrong'},v=>{v.url='wrong'},v=>{v.snapshot='malformed'},v=>{v.snapshot=JSON.stringify({dirname:'/pages/issue-431',filename:'wrong',url:v.url})}]){
    const value=runtime();change(value);assert.throws(()=>assertImportMetaOutputs(input,{methodResults:[{...result,value}]}))
  }
  assert.throws(()=>assertImportMetaOutputs(input,{methodResults:[]}));assert.throws(()=>assertImportMetaOutputs(input,{methodResults:[{...result,sourceCallsite:plan.steps[0].sourceCallsite}]}))
})
test('quote-sensitive WXML and forbidden import.meta references retain the original assertions',()=>{
  const result={route:plan.route,method:'_runE2E',sourceCallsite:plan.steps[1].sourceCallsite,value:runtime()}
  for(const change of [s=>s.replace("data-case='single'",'data-case="single"'),s=>s.replace("wxml'}}\"", "wxml'}}'"),s=>s+' import.meta.env',s=>s+' import.meta.url',s=>s+' import.meta.dirname']){
    const input=staticInputs(),file=input.files[0];file.bytes=Buffer.from(change(file.bytes.toString()));file.sha256=hash(file.bytes);file.length=file.bytes.length
    assert.throws(()=>assertImportMetaOutputs(input,{methodResults:[result]}),/original assertion/)
  }
})
test('exact helper transform surrounds the unchanged original readiness loop and preserves caught thrown identity and actual start/deadline',async()=>{
  const original=await readFile(new URL('vendor/weapp-vite/e2e/ide/github-issues.runtime.shared.ts',root),'utf8'),changed=instrumentGithubSharedRuntime(original, { caseId: descriptor.caseId, caseSourcePath: descriptor.caseSourcePath, sourceSha256: descriptor.sourceSha256 })
  const tree=ts.createSourceFile('helper.ts',changed,ts.ScriptTarget.Latest,true),node=tree.statements.find(x=>ts.isFunctionDeclaration(x)&&x.name.text==='waitForPageReadiness')
  assert.ok(node);const functionSource=node.getText(tree),javascript=ts.transpileModule(functionSource+'\nglobalThis.testReadiness=waitForPageReadiness',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  const thrown=new Error('actual callback failure'),p=passive([{throw:thrown},{url:'pending'},runtime(),runtime()]),page=await p.program.reLaunch('/'+plan.route);let began,ended
  const context={Date:{now:()=>1000+p.calls.length*220},recordConformanceReadinessStart:metadata=>{began=metadata;return p.collector.readinessStart({...metadata,startedAt:1000})},
    recordConformanceReadinessEnd:token=>{ended=true;p.collector.readinessEnd(token)},runWithTimeout:invoke=>invoke(),delay:async()=>{}}
  runInNewContext(javascript,context,{timeout:500});const value=await context.testReadiness(p.program,page,plan.route,undefined,12000,async current=>policy.ready(await current.callMethod('_runE2E')))
  assert.equal(value.ready,true);assert.equal(began.timeoutMs,12000);assert.equal(began.startedAt,1000);assert.equal(ended,true);assert.equal(p.calls.length,3)
  await page.callMethod('_runE2E');p.collector.checkpoint({evidence:{id:'initial',route:plan.route,nodes:groups()}},{session:p.program,page});p.collector.flush()
  assert.throws(()=>instrumentGithubSharedRuntime(original.replace('async function waitForPageReadiness(','async function changedReadiness('), { caseId: descriptor.caseId, caseSourcePath: descriptor.caseSourcePath, sourceSha256: descriptor.sourceSha256 }),/readiness|anchor/)
})
test('new pinned case and exact producer invocation are additive; unknown source/flags cannot borrow this profile',()=>{
  const checkout='/synthetic/checkout',sourceRoot=checkout+'/.tmp/e2e-projects/github-issues/ide-github-issues.runtime.import-meta.test.ts',input={caseId:descriptor.caseId,caseSourcePath:descriptor.caseSourcePath,sourceSha256:descriptor.sourceSha256,checkout,cwd:sourceRoot,cliPath:'/cli',args:['/cli','build',sourceRoot,'--platform','weapp']}
  assert.equal(githubProducerInvocation(input).profile,'github-static-snapshot-v1')
  for(const changed of [{sourceSha256:'0'.repeat(64)},{args:[...input.args,'--skipNpm']},{cwd:'/foreign'}])assert.equal(githubProducerInvocation({...input,...changed}),null)
})

test('actual runtime trace wrapper forwards readiness scope identities and persists every real synthetic method event',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'importmeta-hook-'));let collector
  try {
    const closure=['import-meta-descriptor.mjs','import-meta-source-policy.mjs','ordered-steps-collector-core.mjs','passive-query-context.mjs','source-method-values.mjs']
    const recipePath=join(directory,'recipe.json'),outputFile=join(directory,'events.json')
    await writeFile(recipePath,JSON.stringify({caseId:descriptor.caseId,sourceSha256:descriptor.sourceSha256,manifestIntegrity:'a'.repeat(64),
      collectorPath:fileURLToPath(new URL('./import-meta-collector.mjs',import.meta.url)),
      collectorInputPaths:closure.map(path=>fileURLToPath(new URL(path,import.meta.url)))}))
    collector=await createRuntimeTraceCollector({recipePath,outputFile})
    const page={path:plan.route,pageId:7,async callMethod(){return runtime()}},program={async reLaunch(){return page},async currentPage(){return page}}
    await collector.attach(program);await program.reLaunch('/'+plan.route)
    const token=collector.readinessStart({session:program,page,route:plan.route,timeoutMs:12000,startedAt:Date.now(),helperSha256:plan.steps[0].readinessHelperSha256})
    assert.ok(token);await page.callMethod('_runE2E');collector.readinessEnd(token);await page.callMethod('_runE2E')
    await collector.checkpoint({evidence:{id:'initial',route:plan.route,nodes:groups()}},{session:program,page});await collector.flush()
    const result=JSON.parse(await readFile(outputFile));assert.equal(result.status,'passed');assert.deepEqual(result.events.map(event=>event.op),['route.active','method.readiness','method.call','dom.checkpoint'])
  }finally{try{await collector?.flush()}catch{}await rm(directory,{recursive:true,force:true})}
})
test('every native readiness IPC deadline is bounded by the remaining original source window',async()=>{
  const samples=[{url:'pending'},runtime(),runtime()],trace=(await passive(samples).run()).trace,wire=native('quickjs',samples);let stamp=1000
  wire.readinessClock=()=>stamp;wire.readinessWait=async()=>{stamp=12900}
  const before=BigInt(Date.now())*1000000n;await replay('quickjs',wire,trace);const after=BigInt(Date.now())*1000000n
  const calls=wire.calls.filter(x=>x.op==='method.call'),deadline=BigInt(calls[1].payload.deadlineNs)
  assert.ok(deadline>=before&&deadline<=after+100000000n)
  assert.ok(BigInt(calls[2].payload.deadlineNs)>=before+7000000000n,'final method owns its distinct ordinary harness budget')
})

test('the passive readiness observer never reads a provider result accessor or replaces its original identity',async()=>{
  let reads=0;const value={get url(){reads++;return '/pages/issue-431/index.js'}},p=passive([value]),page=await p.program.reLaunch('/'+plan.route)
  p.begin();const actual=await page.callMethod('_runE2E');assert.equal(actual,value);assert.equal(reads,0)
  assert.equal(policy.ready(actual),true);assert.equal(reads,1);assert.throws(()=>p.collector.flush(),/accessors/)
})
