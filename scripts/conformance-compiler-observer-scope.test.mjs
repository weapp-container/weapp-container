/** Actual isolated Node loader/observer boundary tests. No compiler build, original e2e assertion, native host or UI executes. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspectCompilerMacroLoads } from './conformance-compiler-observation.mjs'
const moduleDirectory=path.dirname(fileURLToPath(import.meta.url))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function probe(t,{mode='dev',dependency=false,packageFiles=null,customOptions=false,foreign=false,directCjs=false,wrongFixture=false,unsafeParent=false}={}) {
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'compiler-observer-scope-')));t.after(()=>rmSync(root,{recursive:true,force:true}))
 const checkout=path.join(root,'checkout'),project=path.join(checkout,'project'),logs=path.join(root,'evidence','loader-logs')
 mkdirSync(path.join(checkout,'packages/weapp-vite/bin'),{recursive:true});mkdirSync(project);mkdirSync(logs,{recursive:true})
 writeFileSync(path.join(checkout,'package.json'),'{"type":"module"}')
 const observerPath=path.join(moduleDirectory,'conformance-compiler-macro-observer.mjs'),observerBytes=readFileSync(observerPath)
 const cli=path.join(checkout,'packages/weapp-vite/bin/weapp-vite.js')
 const source=`import {observer,currentObserverContext} from 'weapp-container:conformance-observer-v1';
import Module from 'node:module';
const plan=JSON.parse(process.env.SCOPE_TEST_PLAN), sentinel={identity:true};
const result=await observer.span('npm-service-build',{cwd:plan.cwd,platform:'weapp'},async()=>{
 observer.record('npm-service-plan',plan);
 ${foreign?`await import(${JSON.stringify(path.join(root,'foreign.mjs'))});`:''}
 ${directCjs?`observer.spanSync('cjs-compile-loader',{},()=>{const compiled=new Module(${JSON.stringify(path.join(root,'foreign.cts'))});compiled.filename=${JSON.stringify(path.join(root,'foreign.cts'))};compiled._compile('module.exports=1',compiled.filename)});`:''}
 return observer.value('identity-return',sentinel);
});
console.log(JSON.stringify({same:result===sentinel,context:currentObserverContext()}));`
 writeFileSync(cli,source);if(foreign)writeFileSync(path.join(root,'foreign.mjs'),'export const injected=true');if(directCjs)writeFileSync(path.join(root,'foreign.cts'),'module.exports=1')
 const put=value=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);const sha256=hash(bytes);const file=path.join(root,'objects',sha256);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,bytes);return{path:path.relative(root,file).split(path.sep).join('/'),sha256,bytes:bytes.length}}
 const guard=put(JSON.stringify({members:[{path:'packages/weapp-vite/bin/weapp-vite.js',kind:'file',origin:'source',sha256:hash(Buffer.from(source)),bytes:Buffer.byteLength(source)}]}))
 const fixture=put(JSON.stringify({projectPath:wrongFixture?project+'-foreign':project,sourceBefore:[]}))
 const config={runId:'actual-node-synthetic-scope-test',caseId:'ide-scope-probe',sourceSha256:'a'.repeat(64),caseSourcePath:'e2e/scope.test.ts',checkout,evidenceRoot:root,logDirectory:logs,membersReference:guard,runnerFiles:[],outputLoadPolicy:'sealed-esm-v1',macroObservation:{profile:'pinned-json-macro-esm-cjs-v5-npm-support',observerPath,observer:{path:'synthetic-observer',sha256:hash(observerBytes),bytes:observerBytes.length}}}
 const configFile=path.join(root,'config.json');writeFileSync(configFile,JSON.stringify(config))
 const plan={cwd:project,platform:'weapp',packageJsonPath:path.join(project,'package.json'),resolveFrom:project,npmDistDirName:'miniprogram_npm',outDir:path.join(project,'dist/miniprogram_npm'),cachedSourceOutDir:path.join(project,'.weapp-vite/npm-source/miniprogram_npm'),sourceOutDir:path.join(project,'dist/miniprogram_npm'),allDependencies:dependency?['unexpected']:[],mainDependencies:dependency?['unexpected']:[],localSubPackageRoots:[],packageFiles,hasBuildOptions:customOptions}
 if(unsafeParent){writeFileSync(path.join(project,'dist'),'not a directory')}
 const preload=path.join(moduleDirectory,'conformance-compiler-use-preload.cjs')
 const args=mode==='dev'?[cli,'dev','--non-interactive']:[cli,'build',project,'--platform','weapp']
 const environment={...process.env,NODE_PATH:'',NODE_OPTIONS:`--require=${JSON.stringify(preload)}`,WEAPP_CONTAINER_COMPILER_USE_CONFIG:configFile,SCOPE_TEST_PLAN:JSON.stringify(plan)}
 if(mode==='static')environment.WEAPP_CONTAINER_COMPILER_FIXTURE_INPUTS=JSON.stringify(fixture)
 else delete environment.WEAPP_CONTAINER_COMPILER_FIXTURE_INPUTS
 const child=spawnSync(process.execPath,args,{cwd:checkout,env:environment,encoding:'utf8',timeout:15000})
 const files=readdirSync(logs),events=files.length?readFileSync(path.join(logs,files[0]),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]
 const load=ref=>{const bytes=readFileSync(path.join(root,ref.path));assert.equal(hash(bytes),ref.sha256);assert.equal(bytes.length,ref.bytes);return bytes}
 const macro=events.filter(e=>e.kind==='macro').map(e=>JSON.parse(load(e.payload)))
 return{root,checkout,project,events,macro,child,load,members:new Map(),observation:{profile:config.macroObservation.profile}}
}
const inspect=f=>inspectCompilerMacroLoads(f)
test('inactive dev operations preserve identity while complete loader witnesses remain',t=>{
 const after=probe(t)
 assert.equal(after.child.status,0,after.child.stderr)
 assert.deepEqual(JSON.parse(after.child.stdout),{same:true,context:null})
 assert.equal(after.events.at(-1).observerFailed,false);assert.equal(after.macro.length,0)
 assert.ok(after.events.some(e=>e.kind==='load'));assert.ok(after.events.some(e=>e.kind==='hook-ready'))
 assert.equal(inspect(after).size,0)
})
test('active static empty plan records physical absent output, not a cache tree or generated-code admission',t=>{
 const after=probe(t,{mode:'static'})
 assert.equal(after.child.status,0,after.child.stderr);assert.equal(after.events.at(-1).observerFailed,false)
 const terminal=after.macro.find(e=>e.kind==='span-end')
 assert.equal(terminal.noOutputObservation.kind,'empty-npm-plan-absent-output-v1')
 assert.equal(terminal.noOutputObservation.absent,true);assert.equal(terminal.noOutputObservation.root,path.join(after.project,'dist/miniprogram_npm'))
 assert.equal(terminal.noOutputObservation.missingPath,path.join(after.project,'dist'))
 assert.equal(Object.hasOwn(terminal,'cacheObservation'),false)
 assert.equal(inspect(after).size,0)
})
test('missing output with dependencies, package-file policy, build options or ENOTDIR remains an observer failure',t=>{
 for(const extra of [{dependency:true},{packageFiles:{}},{customOptions:true},{unsafeParent:true}]){
  const f=probe(t,{mode:'static',...extra});assert.equal(f.child.status,0,f.child.stderr)
  assert.equal(f.events.at(-1).observerFailed,true)
  assert.equal(f.macro.some(e=>e.noOutputObservation),false)
  const failure=f.events.find(e=>e.kind==='observer-failure');assert.ok(failure.diagnostic.message.length<=512)
  if(failure.diagnostic.code)assert.match(failure.diagnostic.code,/ENOENT|ENOTDIR/)
  else assert.match(failure.diagnostic.message,/physical owned directory/)
  assert.throws(()=>inspect(f),/complete successful terminal/)
 }
})
test('transparent dev does not admit an actual unbound module',t=>{
 const f=probe(t,{foreign:true});assert.equal(f.child.status,0,f.child.stderr)
 assert.equal(f.macro.length,0);assert.ok(f.events.some(e=>e.classification==='unbound'))
 assert.throws(()=>inspect(f),/not the reviewed static CLI/)
})
test('active static empty-plan absence cannot launder an actual unbound module',t=>{
 const f=probe(t,{mode:'static',foreign:true});assert.equal(f.child.status,0,f.child.stderr)
 assert.equal(f.events.at(-1).observerFailed,false);assert.ok(f.events.some(e=>e.classification==='unbound'))
 const admitted=inspect(f)
 assert.equal(admitted.size,0)
 assert.ok(f.events.filter(e=>e.classification==='unbound').every(e=>!admitted.has(e)))
 // The unchanged outer consumer rejects every unbound load absent from this
 // returned admission set. Passive absence records grant no load references.
})
test('static observer activation rejects a rehashed fixture closure for another project',t=>{
 const f=probe(t,{mode:'static',wrongFixture:true});assert.notEqual(f.child.status,0)
 assert.match(f.child.stderr,/fixture belongs to another actual project/)
})

test('inactive facade preserves exact synchronous values, throws and Promise identity without touching observed fields',async()=>{
 const module=await import(pathToFileURL(path.join(moduleDirectory,'conformance-compiler-macro-observer.mjs')).href+'?inactive-contract')
 let touched=0
 const guarded=new Proxy({}, {get(){touched++;throw new Error('must not read')},ownKeys(){touched++;throw new Error('must not enumerate')}})
 module.installObserverSink(()=>{throw new Error('must not emit')},()=>{throw new Error('must not fail')},{active:false})
 const object={},promise=Promise.resolve(object),thrown={};const observer=module.observer
 assert.equal(observer.span('anything',guarded,()=>promise),promise)
 assert.equal(observer.spanSync('anything',guarded,()=>object),object)
 assert.throws(()=>observer.span('anything',guarded,()=>{throw thrown}),error=>error===thrown)
 assert.throws(()=>observer.spanSync('anything',guarded,()=>{throw thrown}),error=>error===thrown)
 assert.equal(observer.value('anything',guarded,guarded,guarded),guarded)
 assert.equal(observer.valueAt(guarded,'anything',guarded,guarded,guarded),guarded)
 observer.record('anything',guarded);observer.recordAt(guarded,'anything',guarded)
 assert.equal(observer.identity(guarded),undefined)
 assert.equal(observer.context(),null);assert.equal(module.currentObserverContext(),null);assert.equal(touched,0)
 await promise
})

test('inactive dev direct CommonJS macro cannot disappear behind an inactive context',t=>{
 const f=probe(t,{directCjs:true});assert.equal(f.child.status,0,f.child.stderr)
 assert.equal(f.macro.length,0);assert.equal(f.events.at(-1).observerFailed,true)
 const failure=f.events.find(event=>event.kind==='observer-failure');assert.ok(failure)
 assert.match(failure.diagnostic.message,/generated-code boundary cjs-compile-loader is outside/)
 // The existing full consumer excludes observer-failure from its allowed
 // event kinds even when no module import reaches Node's load hook.
 assert.equal(['start','resolve','load','macro','hook-ready','hook-registration','hook-rearmed','builtin-load','non-file-load','end'].includes(failure.kind),false)
})

test('inactive bundled execution fails closed and preserves its original Promise and thrown object',async()=>{
 const module=await import(pathToFileURL(path.join(moduleDirectory,'conformance-compiler-macro-observer.mjs')).href+'?inactive-execution-contract')
 const failures=[];module.installObserverSink(()=>{throw new Error('must not emit')},error=>failures.push(error),{active:false})
 const promise=Promise.resolve({value:true}),thrown={same:true}
 assert.equal(module.observer.span('loadFromBundledFile',{},()=>promise),promise)
 assert.throws(()=>module.observer.spanSync('cjs-compile-loader',{},()=>{throw thrown}),error=>error===thrown)
 assert.equal(failures.length,2);assert.ok(failures.every(error=>/outside the static observation operation/.test(error.message)))
 assert.equal(module.currentObserverContext(),null);await promise
})
