/** Portable synthetic CAS tests using the fixed inert source archive.
 * Actual receipt/CAS audits run separately and retain their original evidence.
 * No archived JavaScript, compiler, packer, SDK or native host executes. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { reviewedCompilerProducer, assertReviewedFixtureProducer, assertReviewedSnapshotProducer, assertReviewedSnapshotTransport, REVIEWED_PRODUCER_INPUTS } from './conformance-producer-revisions.mjs'
const directory=new URL('./fixtures/reviewed-producers/cjs-v4-r6-v2/',import.meta.url)
const metadata=JSON.parse(readFileSync(new URL('revision.json',directory))),provenance=JSON.parse(readFileSync(new URL('provenance/verified-source-tuple.json',directory)))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),staticKeys=['staticCliProfile','fixtureProject'],primaryKeys=['compilerUseProducer','compilerUsePreload','fixtureBuildProducer','fixturePackerPreload','macroProducer','macroManifest','macroObserver','macroValidator'],snapshotKeys=['githubProducer','wxmlProducer','snapshotTransport','temporaryProjectProducer','issue1034Producer']
const expectedRevision=process.env.WEAPP_R6_EXPECT_REVISION??metadata.id
function fixture(index=0){
 const record=provenance.cases[index],identity=metadata.caseScopes[index],objects=new Map(),load=reference=>{const bytes=objects.get(reference.sha256);assert.ok(bytes,'synthetic CAS reference must belong to this fixture');assert.equal(hash(bytes),reference.sha256);assert.equal(bytes.length,reference.bytes);return bytes}
 const put=bytes=>{objects.set(hash(bytes),bytes);return{path:'synthetic-inert:'+hash(bytes),sha256:hash(bytes),bytes:bytes.length}}
 const sources=Object.fromEntries(Object.entries(metadata.sources).map(([key,item])=>[key,put(readFileSync(new URL(item.path,directory)))]))
 const staticInputs=metadata.staticProfileModules.map(({key,path})=>({path,artifact:sources[key]}))
 const consumer={caseId:identity.caseId,caseSourcePath:identity.caseSourcePath,sourceSha256:identity.sourceSha256,
  producer:sources.compilerUseProducer,preload:sources.compilerUsePreload,staticProfileInputs:structuredClone(staticInputs),
  macroObservation:{profile:metadata.profile,producer:sources.macroProducer,manifest:sources.macroManifest,
   observer:sources.macroObserver,validator:sources.macroValidator,profileInputs:structuredClone(staticInputs)}}
 const built={caseId:identity.caseId,sourceSha256:identity.sourceSha256,producer:sources.fixtureBuildProducer,
  packer:{preload:sources.fixturePackerPreload},staticProfileInputs:structuredClone(staticInputs),producerProfile:identity.snapshotProfile,
  producerInputs:metadata.snapshotModules.map(({key,path})=>({path,artifact:sources[key]}))}
 return{record,load,put,consumer,built,sources,identity}
}
const complete=f=>assertReviewedFixtureProducer(f.built,reviewedCompilerProducer(f.consumer,f.load),f.load)
test('r6 fixed metadata has exactly fifteen source members, two ordered static modules and only the independently completed real scopes',()=>{
 assert.deepEqual(Object.keys(metadata.sources),[...primaryKeys,...snapshotKeys,...staticKeys])
 assert.deepEqual(metadata.staticProfileModules,[{key:'staticCliProfile',path:'scripts/conformance-static-cli-profile.mjs'},{key:'fixtureProject',path:'scripts/conformance-fixture-project.mjs'}])
 assert.deepEqual(metadata.caseScopes.map(value=>value.caseId),['ide-github-issues-runtime-issue1014','ide-github-issues-runtime-issue1013'])
 assert.equal(provenance.sourcePairs.length,15);assert.equal(provenance.largeInventoriesCopied,0)
 assert.deepEqual(provenance.cases.map(record=>record.identity),metadata.caseScopes.map(({snapshotProfile,...identity})=>identity))
 for(const record of provenance.cases)for(const reference of [record.fullReader,record.independentReview]){
  assert.match(reference.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(reference.bytes)&&reference.bytes>0)
 }
 // Select the original three archives positively. Later inert archives must
 // never enter the fixed legacy closure merely because a new exclusion is absent.
 const archiveInputs=name=>{
  const prefix='scripts/fixtures/reviewed-producers/'+name+'/',fixed=JSON.parse(readFileSync(new URL('./fixtures/reviewed-producers/'+name+'/revision.json',import.meta.url)))
  return ['revision.json',...Object.values(fixed.sources).map(value=>value.path),...fixed.provenance.map(value=>value.copy)].map(path=>prefix+path)
 }
 const legacyNames=['sealed-esm-v2-r3-v1','cjs-v4-r5b-v1','cjs-v4-r5c-v1']
 const legacy=['scripts/conformance-producer-revisions.mjs',...legacyNames.flatMap(archiveInputs)]
 assert.equal(legacy.length,53)
 assert.deepEqual(REVIEWED_PRODUCER_INPUTS.filter(path=>legacy.includes(path)),legacy)
 const additions=[['cjs-v4-r5f-v1',25],['cjs-v4-r6-v2',17],['cjs-v4-r7-v1',17],['cjs-v5-r8-before297-302-v1',17],['cjs-v5-r9-before-readiness-v1',19],['cjs-v5-r10-before-core-transform-v1',21]]
 const expected=[...legacy]
 for(const [name,count] of additions){
  const members=archiveInputs(name)
  assert.equal(members.length,count,name)
  assert.deepEqual(REVIEWED_PRODUCER_INPUTS.filter(path=>path.startsWith('scripts/fixtures/reviewed-producers/'+name+'/')),members,name)
  expected.push(...members)
 }
 assert.equal(new Set(expected).size,expected.length)
 assert.deepEqual(REVIEWED_PRODUCER_INPUTS,expected,'fixed legacy and each additive archive must retain complete ordered independent membership')
 const r9=JSON.parse(readFileSync(new URL('./fixtures/reviewed-producers/cjs-v5-r9-before-readiness-v1/revision.json',import.meta.url)))
 assert.equal(Object.keys(r9.sources).length,15);assert.equal(r9.provenance.length,3);assert.equal(r9.caseScopes.length,6)
})
test('synthetic r6 consumer and fixture identities complete the same-case eight-plus-five-plus-two opaque tuple',()=>{
 for(let index=0;index<metadata.caseScopes.length;index++){
  const f=fixture(index),token=complete(f);assert.equal(token.id,expectedRevision)
  assert.deepEqual([...token.identityTuple,...token.snapshotIdentityTuple,...token.staticProfileIdentityTuple].map(value=>value.key),[...primaryKeys,...snapshotKeys,...staticKeys])
  for(const item of [...token.identityTuple,...token.snapshotIdentityTuple,...token.staticProfileIdentityTuple]){assert.equal(item.sha256,f.sources[item.key].sha256);assert.equal(item.bytes,f.sources[item.key].bytes);assert.ok(Object.isFrozen(item))}
  assert.ok(Object.isFrozen(token));assert.doesNotThrow(()=>assertReviewedSnapshotProducer({reference:f.sources.githubProducer,profile:f.identity.snapshotProfile,identity:f.identity},token,f.load));assert.doesNotThrow(()=>assertReviewedSnapshotTransport({reference:f.sources.snapshotTransport,profile:f.identity.snapshotProfile,identity:f.identity},token,f.load))
 }
})
test('every changed r6 member fails despite its correctly rehashed replacement CAS identity',()=>{
 for(const key of Object.keys(metadata.sources)){
  const f=fixture(),changed=f.put(Buffer.concat([f.load(f.sources[key]),Buffer.from('\n// unreviewed same-profile member')]))
  if(key==='compilerUseProducer')f.consumer.producer=changed
  else if(key==='compilerUsePreload')f.consumer.preload=changed
  else if(key==='fixtureBuildProducer')f.built.producer=changed
  else if(key==='fixturePackerPreload')f.built.packer.preload=changed
  else if(key.startsWith('macro'))f.consumer.macroObservation[{macroProducer:'producer',macroManifest:'manifest',macroObserver:'observer',macroValidator:'validator'}[key]]=changed
  else if(snapshotKeys.includes(key))f.built.producerInputs[snapshotKeys.indexOf(key)].artifact=changed
  else f.consumer.staticProfileInputs[staticKeys.indexOf(key)].artifact=changed
  assert.throws(()=>complete(f),/differs|unknown or mixed/,key)
 }
})
test('all three static closures require both exact paths, order, key shape, lengths and loaded bytes',()=>{
 for(const field of ['consumer','macro','fixture'])for(const mutate of [value=>value.pop(),value=>value.reverse(),value=>value.push(value[0]),value=>{value[0].path=value[1].path},value=>{value[0].extra=true},value=>{value[0].artifact.bytes++},value=>{value[0].artifact.sha256='f'.repeat(64)}]){
  const f=fixture(),target=field==='consumer'?f.consumer:field==='macro'?f.consumer.macroObservation:f.built,key=field==='macro'?'profileInputs':'staticProfileInputs';mutate(target[key]);assert.throws(()=>complete(f))
 }
 for(const field of ['consumer','macro','fixture']){const f=fixture(),target=field==='consumer'?f.consumer:field==='macro'?f.consumer.macroObservation:f.built;delete target[field==='macro'?'profileInputs':'staticProfileInputs'];assert.throws(()=>complete(f),/differs|unknown or mixed/)}
 const f=fixture(),original=f.load;f.load=reference=>reference.sha256===f.sources.fixtureProject.sha256?Buffer.from('substituted loaded static helper'):original(reference);assert.throws(()=>complete(f),/differs|unknown or mixed/)
})
test('r6 scopes and opaque complete tokens cannot cross case, source, profile, helper or transport boundaries',()=>{
 const f=fixture(),token=complete(f),request={reference:f.sources.githubProducer,profile:f.identity.snapshotProfile,identity:f.identity}
 for(const value of [{...token},{id:token.id},undefined])assert.throws(()=>assertReviewedSnapshotProducer(request,value,f.load),/unknown, mixed/)
 for(const key of ['caseId','sourceSha256','caseSourcePath']){const identity={...f.identity,[key]:'foreign'};assert.throws(()=>assertReviewedSnapshotProducer({...request,identity},token,f.load),/unknown, mixed/);assert.throws(()=>assertReviewedSnapshotTransport({...request,reference:f.sources.snapshotTransport,identity},token,f.load),/unknown, mixed/)}
 assert.throws(()=>assertReviewedSnapshotProducer({...request,profile:'template-native-static-snapshot-v1'},token,f.load),/unknown, mixed/)
 const other=fixture(1);assert.throws(()=>assertReviewedFixtureProducer(other.built,reviewedCompilerProducer(f.consumer,f.load),other.load),/unknown or mixed/)
 if(expectedRevision===metadata.id)for(const patch of [{caseId:'ide-template-weapp-vite-multi-platform-template'},{caseId:'ide-wxml-transform-runtime'},{sourceSha256:'f'.repeat(64)},{caseSourcePath:f.consumer.caseSourcePath+'.foreign'}]){const x=fixture();Object.assign(x.consumer,patch);assert.throws(()=>complete(x),/unknown or mixed/)}
})
test('fixed r6 static module metadata cannot change key, path, order or cardinality even when its catalog digest is rebound in an isolated reader',async t=>{
 for(const mutate of [value=>value.reverse(),value=>{value[0].key='fixtureProject'},value=>{value[0].path='scripts/foreign.mjs'},value=>value.push(value[0])]){
  const temp=await mkdtemp(join(tmpdir(),'r6-static-metadata-'));t.after(()=>rm(temp,{recursive:true,force:true}));await mkdir(join(temp,'scripts'),{recursive:true})
  await cp(new URL('./fixtures/reviewed-producers/',import.meta.url),join(temp,'scripts/fixtures/reviewed-producers'),{recursive:true})
  await cp(new URL('./conformance-static-cli-profile.mjs',import.meta.url),join(temp,'scripts/conformance-static-cli-profile.mjs'))
  const bytes=readFileSync(new URL('revision.json',directory)),changed=JSON.parse(bytes);mutate(changed.staticProfileModules);const replacement=Buffer.from(JSON.stringify(changed,null,2)+'\n')
  const source=readFileSync(new URL('./conformance-producer-revisions.mjs',import.meta.url),'utf8'),needle=`sha256: '${hash(bytes)}', bytes: ${bytes.length}`;assert.equal(source.split(needle).length,2)
  await writeFile(join(temp,'scripts/conformance-producer-revisions.mjs'),source.replace(needle,`sha256: '${hash(replacement)}', bytes: ${replacement.length}`));await writeFile(join(temp,'scripts/fixtures/reviewed-producers/cjs-v4-r6-v2/revision.json'),replacement)
  await assert.rejects(import(pathToFileURL(join(temp,'scripts/conformance-producer-revisions.mjs'))),/Fixed static profile module order or paths differ/)
 }
})
test('tampered r6 inert source or compact provenance is rejected before any archived code executes',async t=>{
 for(const path of [metadata.sources.fixtureProject.path,metadata.provenance[0].copy]){
  const temp=await mkdtemp(join(tmpdir(),'r6-static-fixed-file-'));t.after(()=>rm(temp,{recursive:true,force:true}));await mkdir(join(temp,'scripts'),{recursive:true})
  await cp(new URL('./fixtures/reviewed-producers/',import.meta.url),join(temp,'scripts/fixtures/reviewed-producers'),{recursive:true});await cp(new URL('./conformance-static-cli-profile.mjs',import.meta.url),join(temp,'scripts/conformance-static-cli-profile.mjs'))
  await cp(new URL('./conformance-producer-revisions.mjs',import.meta.url),join(temp,'scripts/conformance-producer-revisions.mjs'));await writeFile(join(temp,'scripts/fixtures/reviewed-producers/cjs-v4-r6-v2',path),'throw new Error("ARCHIVED_CODE_MUST_NOT_EXECUTE")')
  await assert.rejects(import(pathToFileURL(join(temp,'scripts/conformance-producer-revisions.mjs'))),/Fixed reviewed producer fixture hash\/size differs/)
 }
})
