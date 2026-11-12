/** Read-only original inputs and synthetic unit data only. No compiler, packer,
 * official test, SDK, native host or browser executes. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import { TEMPLATE_STATIC_CASE, TEMPLATE_SFC_STATIC_CASE, TEMPLATE_STATIC_CASES, templateStaticCase, parseStaticCliInvocation } from './conformance-static-cli-profile.mjs'
import { templateProducerCase, templateProducerGuards, templateProducerInvocation, verifyTemplateProducerGuards } from './conformance-fixture-project.mjs'
import { reviewedCompilerProducer, assertReviewedFixtureProducer } from './conformance-producer-revisions.mjs'
import { MACRO_OBSERVATION_PROFILE } from './conformance-compiler-observation.mjs'
import { instrumentSnapshotAutomator } from './conformance-snapshot-transport.mjs'
import { descriptor } from '../conformance/recipes/template-multi-platform-sfc-descriptor.mjs'
import snapshots from '../conformance/recipes/template-multi-platform-sfc-snapshots.json' with { type: 'json' }
import { readConformanceRecipes } from './conformance-recipes.mjs'
import { RUNNER_INPUTS } from './conformance-devtools-runner.mjs'
const root=fileURLToPath(new URL('..',import.meta.url)), hash=b=>createHash('sha256').update(b).digest('hex')
const originalRoot=process.env.WEAPP_CONFORMANCE_ORIGINAL_ROOT??root,COMMIT='0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e'
const policyIdentity=value=>({caseId:value.caseId,caseSourcePath:value.caseSourcePath,sourceSha256:value.sourceSha256,templateRelativePath:value.templateRelativePath})

async function originalCases(){
 const index=JSON.parse(await readFile(originalRoot+'/docs/conformance/case-index-v1.json'))
 const reviewed=[]
 for(const name of ['weapp-vite-multi-platform-template','weapp-vite-multi-platform-sfc-template']){
  const recipe=JSON.parse(await readFile(root+'/conformance/recipes/template-'+(name.includes('-sfc-')?'multi-platform-sfc':'multi-platform')+'-v1.json')).recipes[0]
  const module=await import('../conformance/recipes/template-'+(name.includes('-sfc-')?'multi-platform-sfc':'multi-platform')+'-descriptor.mjs'),source=module.descriptor
  const item=index.cases.find(value=>value.id===recipe.caseId);assert.ok(item,'recipe case must exist in actual root index')
  const identity={caseId:item.id,caseSourcePath:item.source,sourceSha256:item.sourceSha256,templateRelativePath:'templates/'+name}
  const pinned=execFileSync('git',['-C',originalRoot+'/vendor/weapp-vite','show',COMMIT+':'+item.source])
  assert.equal(hash(pinned),item.sourceSha256);assert.deepEqual(await readFile(originalRoot+'/vendor/weapp-vite/'+item.source),pinned)
  assert.equal(recipe.sourceSha256,item.sourceSha256);assert.deepEqual(policyIdentity(source),identity)
  reviewed.push({identity,source,recipe})
 }
 return reviewed
}

test('actual root index and pinned Git source join descriptor, recipe, CLI policy and producer guards to the same two exact identities',async()=>{
 const cases=await originalCases();assert.deepEqual(TEMPLATE_STATIC_CASES.map(policyIdentity),cases.map(value=>value.identity))
 for(const {identity,source,recipe}of cases){
  assert.deepEqual(policyIdentity(templateStaticCase(identity)),identity);assert.deepEqual(policyIdentity(templateProducerCase(identity)),identity)
  const first=templateProducerGuards(identity)[0];assert.deepEqual(first,{path:identity.caseSourcePath,sha256:identity.sourceSha256})
  const checkout='/owned/pinned-checkout',sourceRoot=checkout+'/'+identity.templateRelativePath,cliPath=checkout+'/packages/weapp-vite/bin/weapp-vite.js'
  const args=[cliPath,'build',sourceRoot,'--platform','weapp','--skipNpm'],options={...identity,args,checkout,cliPath,cwd:sourceRoot}
  assert.equal(parseStaticCliInvocation(options).templateRelativePath,identity.templateRelativePath)
  assert.deepEqual(policyIdentity({...templateProducerInvocation(options),templateRelativePath:identity.templateRelativePath}),identity)
  const other=cases.find(value=>value.identity.caseId!==identity.caseId).identity
  for(const patch of [{caseId:identity.caseId.replace('ide-template-','ide-')},{caseId:'ide-foreign-template'},...['caseId','caseSourcePath','sourceSha256'].map(key=>({[key]:other[key]})),{sourceSha256:'f'.repeat(64)},{caseSourcePath:identity.caseSourcePath+'.foreign'}]){
   const mixed={...identity,...patch};assert.equal(templateStaticCase(mixed),null);assert.equal(templateProducerCase(mixed),null);assert.equal(parseStaticCliInvocation({...options,...patch}),null);assert.equal(templateProducerInvocation({...options,...patch}),null);assert.throws(()=>templateProducerGuards(mixed),/not reviewed/)
  }
 }
})

test('the current fixture policy uses those same actual template identities and rejects source/profile mismatches',async()=>{
 const cases=await originalCases(),files={compilerUseProducer:'conformance-compiler-use.mjs',compilerUsePreload:'conformance-compiler-use-preload.cjs',fixtureBuildProducer:'conformance-fixture-build.mjs',fixturePackerPreload:'conformance-fixture-packer-preload.mjs',macroProducer:'conformance-compiler-observation.mjs',macroManifest:'conformance-compiler-observation-v1.json',macroObserver:'conformance-compiler-macro-observer.mjs',macroValidator:'conformance-compiler-macro-validator.mjs',githubProducer:'conformance-github-producer.mjs',wxmlProducer:'conformance-wxml-producer.mjs',snapshotTransport:'conformance-snapshot-transport.mjs',temporaryProjectProducer:'conformance-temporary-project-producer.mjs',issue1034Producer:'conformance-issue1034-producer.mjs',staticCliProfile:'conformance-static-cli-profile.mjs',fixtureProject:'conformance-fixture-project.mjs'}
 const objects=new Map(),put=bytes=>{objects.set(hash(bytes),bytes);return{path:'synthetic-inert:'+hash(bytes),sha256:hash(bytes),bytes:bytes.length}},load=reference=>objects.get(reference.sha256),sources={}
 for(const[key,path]of Object.entries(files))sources[key]=put(await readFile(root+'/scripts/'+path))
 const staticInputs=['staticCliProfile','fixtureProject'].map(key=>({path:'scripts/'+files[key],artifact:sources[key]})),snapshotKeys=['githubProducer','wxmlProducer','snapshotTransport','temporaryProjectProducer','issue1034Producer']
 const macroObservation={profile:MACRO_OBSERVATION_PROFILE,producer:sources.macroProducer,manifest:sources.macroManifest,observer:sources.macroObserver,validator:sources.macroValidator,profileInputs:staticInputs}
 for(const {identity}of cases){
  const consumer={...identity,producer:sources.compilerUseProducer,preload:sources.compilerUsePreload,staticProfileInputs:staticInputs,macroObservation},built={caseId:identity.caseId,sourceSha256:identity.sourceSha256,producer:sources.fixtureBuildProducer,packer:{preload:sources.fixturePackerPreload},staticProfileInputs:staticInputs,producerProfile:'template-native-static-snapshot-v1',producerInputs:snapshotKeys.map(key=>({path:'scripts/'+files[key],artifact:sources[key]}))}
  assert.doesNotThrow(()=>assertReviewedFixtureProducer(built,reviewedCompilerProducer(consumer,load),load))
  for(const patch of [{sourceSha256:'f'.repeat(64)},{producerProfile:'wxml-static-snapshot-v1'},{producerProfile:'github-static-snapshot-v1'},{producerProfile:undefined}])
   assert.throws(()=>assertReviewedFixtureProducer({...built,...patch},reviewedCompilerProducer(consumer,load),load),/differs|unknown or mixed/)
  for(const patch of [{caseId:'ide-foreign-template'},{caseId:identity.caseId.replace('ide-template-','ide-')},{sourceSha256:'f'.repeat(64)},{caseSourcePath:identity.caseSourcePath+'.foreign'},...cases.filter(value=>value.identity.caseId!==identity.caseId).flatMap(value=>['caseId','caseSourcePath','sourceSha256'].map(key=>({[key]:value.identity[key]})))]){
   const changed={...consumer,...patch},fixture={...built,caseId:changed.caseId,sourceSha256:changed.sourceSha256}
   assert.throws(()=>assertReviewedFixtureProducer(fixture,reviewedCompilerProducer(changed,load),load),/differs|unknown or mixed/)
  }
 }
})

test('SFC recognition requires one complete original case/source/hash/path tuple without admitting mixed siblings',()=>{
 const checkout='/owned/checkout',cliPath=checkout+'/packages/weapp-vite/bin/weapp-vite.js'
 for(const identity of [TEMPLATE_STATIC_CASE,TEMPLATE_SFC_STATIC_CASE]){
  const sourceRoot=checkout+'/'+identity.templateRelativePath,args=[cliPath,'build',sourceRoot,'--platform','weapp','--skipNpm'],options={checkout,cliPath,cwd:sourceRoot,args,...identity}
  assert.equal(templateStaticCase(identity),identity);assert.equal(parseStaticCliInvocation(options).sourceRoot,sourceRoot)
  const other=identity===TEMPLATE_STATIC_CASE?TEMPLATE_SFC_STATIC_CASE:TEMPLATE_STATIC_CASE
  for(const key of ['caseId','caseSourcePath','sourceSha256'])assert.equal(parseStaticCliInvocation({...options,[key]:other[key]}),null)
  assert.equal(parseStaticCliInvocation({...options,args:[cliPath,'build',checkout+'/'+other.templateRelativePath,...args.slice(3)]}),null)
 }
 for(const value of [{...TEMPLATE_SFC_STATIC_CASE,caseId:TEMPLATE_SFC_STATIC_CASE.caseId+'-extra'}, {...TEMPLATE_SFC_STATIC_CASE,sourceSha256:'f'.repeat(64)},{}]){
  assert.equal(templateStaticCase(value),null);assert.throws(()=>templateProducerGuards(value),/not reviewed/)
 }
})

test('SFC snapshot literals and descriptor retain exact original source identities, six queries and doubled coverage',async()=>{
 const source=await readFile(new URL('../vendor/weapp-vite/'+descriptor.caseSourcePath,import.meta.url))
 assert.equal(hash(source),descriptor.sourceSha256);assert.equal(descriptor.sourceSha256,TEMPLATE_SFC_STATIC_CASE.sourceSha256)
 assert.deepEqual(descriptor.checkpoints.map(step=>step.queries.length),[6,6])
 assert.deepEqual(descriptor.checkpoints[0].queries[3],{selector:'#component-platform',scope:['#platform-card-host']})
 assert.equal(descriptor.checkpoints[0].queries[5].selector,'#counter-doubled')
 const bytes=await readFile(new URL('../'+snapshots.source.path,import.meta.url));assert.equal(bytes.length,1430);assert.equal(hash(bytes),snapshots.source.sha256)
 const tree=ts.createSourceFile(snapshots.source.path,bytes.toString(),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),values={}
 assert.equal(tree.parseDiagnostics.length,0);assert.equal(tree.statements.length,2)
 for(const [at,statement]of tree.statements.entries()){
  const e=statement.expression;assert.ok(ts.isBinaryExpression(e));assert.ok(ts.isElementAccessExpression(e.left));assert.equal(e.left.expression.text,'exports');assert.ok(ts.isNoSubstitutionTemplateLiteral(e.left.argumentExpression));assert.ok(ts.isNoSubstitutionTemplateLiteral(e.right))
  const value=e.right.text;values[e.left.argumentExpression.text]=at===0?value.slice(2,-2):value.slice(1,-1)
 }
 assert.deepEqual(snapshots.snapshots,values)
})

test('SFC producer guards bind its own source and the seven unchanged original helpers',async()=>{
 const identity=TEMPLATE_SFC_STATIC_CASE,expected=templateProducerGuards(identity),guards=[],members=[]
 assert.equal(expected.length,8);assert.equal(expected[0].path,identity.caseSourcePath)
 for(const guard of expected){
  const original=await readFile(new URL('./fixtures/template-producer-guards/'+guard.path.replaceAll('/','__')+'.txt',import.meta.url))
  assert.equal(hash(original),guard.sha256)
  const observed=guard.path==='e2e/utils/automator.ts'?Buffer.from(instrumentSnapshotAutomator(original.toString())):original
  guards.push({path:guard.path,original,observed});members.push({path:guard.path,kind:'file',origin:guard.path==='e2e/utils/automator.ts'?'patch':'source',sha256:hash(observed),bytes:observed.length})
 }
 const options={identity,guards,members,load:value=>value}
 verifyTemplateProducerGuards(options)
 assert.throws(()=>verifyTemplateProducerGuards({...options,identity:TEMPLATE_STATIC_CASE}),/guard differs/)
 const changed=guards.map(value=>({...value}));changed[0].original=Buffer.from('changed source')
 assert.throws(()=>verifyTemplateProducerGuards({...options,guards:changed}),/guard differs/)
})

test('both exact recipes retain the same 360 portable files and one conflict-checked official runner closure',async()=>{
 const portablePrefix='conformance/recipes/template-format-dependencies/',sets=[]
 for(const name of ['template-multi-platform-v1.json','template-multi-platform-sfc-v1.json']){
  const file=root+'/conformance/recipes/'+name,recipe=JSON.parse(await readFile(file)).recipes[0]
  assert.equal((await readConformanceRecipes({root,file,index:{cases:[{id:recipe.caseId,sourceSha256:recipe.sourceSha256}]}})).size,1)
  assert.equal(recipe.collectorInputs.length,364)
  const portable=recipe.collectorInputs.filter(input=>input.path.startsWith(portablePrefix));assert.equal(portable.length,360);sets.push(portable)
  for(const input of [recipe.collector,...recipe.collectorInputs]){const bytes=await readFile(root+'/'+input.path);assert.equal(hash(bytes),input.sha256);assert.equal(bytes.length,input.bytes);assert.ok(RUNNER_INPUTS.includes(input.path))}
 }
 assert.deepEqual(sets[0],sets[1]);assert.equal(new Set(RUNNER_INPUTS).size,RUNNER_INPUTS.length)
 assert.deepEqual(RUNNER_INPUTS.filter(path=>path.startsWith(portablePrefix)).sort(),sets[0].map(input=>input.path).sort())
})
