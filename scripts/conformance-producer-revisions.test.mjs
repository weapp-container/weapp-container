import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile, rename, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { reviewedMacroObservation, reviewedCompilerProducer, assertReviewedFixtureProducer, assertReviewedSnapshotProducer, assertReviewedSnapshotTransport, REVIEWED_PRODUCER_INPUTS } from './conformance-producer-revisions.mjs'
import { MACRO_OBSERVATION_PROFILE } from './conformance-compiler-observation.mjs'

const directory = new URL('./fixtures/reviewed-producers/sealed-esm-v2-r3-v1/', import.meta.url)
const metadata = JSON.parse(readFileSync(new URL('revision.json', directory)))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = { compilerUseProducer: './conformance-compiler-use.mjs', compilerUsePreload: './conformance-compiler-use-preload.cjs',
  fixtureBuildProducer: './conformance-fixture-build.mjs', fixturePackerPreload: './conformance-fixture-packer-preload.mjs',
  macroProducer: './conformance-compiler-observation.mjs', macroManifest: './conformance-compiler-observation-v1.json',
  macroObserver: './conformance-compiler-macro-observer.mjs', macroValidator: './conformance-compiler-macro-validator.mjs' }

function fixture(legacy) {
  const objects = new Map()
  const put = bytes => { bytes = Buffer.from(bytes); objects.set(hash(bytes), bytes); return {path:`synthetic-inert:${hash(bytes)}`,sha256:hash(bytes),bytes:bytes.length} }
  const sources = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, put(readFileSync(legacy ? new URL(metadata.sources[key].path, directory) : new URL(path, import.meta.url)))]))
  const observation = { profile: legacy ? metadata.profile : MACRO_OBSERVATION_PROFILE, producer:sources.macroProducer, manifest:sources.macroManifest,
    observer:sources.macroObserver, validator:sources.macroValidator, transforms:[] }
  const profileInputs = legacy ? undefined : ['conformance-static-cli-profile.mjs', 'conformance-fixture-project.mjs'].map(name => ({path:`scripts/${name}`,artifact:put(readFileSync(new URL(`./${name}`,import.meta.url)))}))
  if (!legacy) observation.profileInputs=profileInputs
  const consumer = { caseId:metadata.caseIds[0], producer:sources.compilerUseProducer, preload:sources.compilerUsePreload, ...(profileInputs ? {staticProfileInputs:profileInputs} : {}), macroObservation:observation }
  const built = {caseId:consumer.caseId,...(profileInputs ? {staticProfileInputs:profileInputs} : {}),producer:sources.fixtureBuildProducer,packer:{preload:sources.fixturePackerPreload}}
  const load = reference => { const bytes=objects.get(reference.sha256); assert.ok(bytes);assert.equal(bytes.length,reference.bytes);return bytes }
  return {sources,observation,consumer,built,load,put,objects}
}

test('new production selects v6 core-transform observation with its complete current producer group', () => {
  assert.equal(MACRO_OBSERVATION_PROFILE,'pinned-json-macro-esm-cjs-v6-core-transform')
  const f=fixture(false),revision=reviewedCompilerProducer(f.consumer,f.load)
  assert.equal(revision.id,'current-reviewed-source')
  assert.equal(revision.profile,MACRO_OBSERVATION_PROFILE)
  assert.doesNotThrow(()=>assertReviewedFixtureProducer(f.built,revision,f.load))
})

test('fixed legacy producer group selects only the reviewed source revision and its fixed insertion manifest', () => {
  const f=fixture(true),revision=reviewedCompilerProducer(f.consumer,f.load),macro=reviewedMacroObservation(f.observation,f.load)
  assert.equal(revision.id,metadata.id);assert.equal(revision.profile,metadata.profile)
  assert.deepEqual(macro.manifest,JSON.parse(readFileSync(new URL(metadata.sources.macroManifest.path,directory))))
  assert.doesNotThrow(()=>assertReviewedFixtureProducer(f.built,revision,f.load))
  assert.equal(REVIEWED_PRODUCER_INPUTS.filter(path => path === 'scripts/conformance-producer-revisions.mjs' || ['sealed-esm-v2-r3-v1', 'cjs-v4-r5b-v1', 'cjs-v4-r5c-v1'].some(directory => path.startsWith(`scripts/fixtures/reviewed-producers/${directory}/`))).length,53)
  assert.equal(REVIEWED_PRODUCER_INPUTS.filter(path => path === 'scripts/conformance-producer-revisions.mjs' || ['sealed-esm-v2-r3-v1', 'cjs-v4-r5b-v1', 'cjs-v4-r5c-v1', 'cjs-v4-r5f-v1'].some(directory => path.startsWith(`scripts/fixtures/reviewed-producers/${directory}/`))).length,78)
  assert.equal(REVIEWED_PRODUCER_INPUTS.filter(path => path.includes('/cjs-v4-r7-v1/')).length,17)
  assert.equal(new Set(REVIEWED_PRODUCER_INPUTS).size,REVIEWED_PRODUCER_INPUTS.length)
})

test('frozen pre-297 v5 archive adds exactly its seventeen independently scoped inert members', () => {
  const prefix = 'scripts/fixtures/reviewed-producers/cjs-v5-r8-before297-302-v1/'
  const directory = new URL('./fixtures/reviewed-producers/cjs-v5-r8-before297-302-v1/', import.meta.url)
  const metadata = JSON.parse(readFileSync(new URL('revision.json', directory)))
  const expected = ['revision.json', ...Object.values(metadata.sources).map(item => item.path),
    ...metadata.provenance.map(item => item.copy)].map(path => prefix + path)
  assert.equal(expected.length, 17)
  assert.deepEqual(REVIEWED_PRODUCER_INPUTS.filter(path => path.startsWith(prefix)), expected)
  assert.equal(metadata.caseScopes.length, 12)
  assert.ok(metadata.caseScopes.every(scope => !['ide-github-issues-runtime-issue297-302',
    'ide-github-issues-runtime-issue1058', 'ide-github-issues-runtime-issue1185',
    'ide-github-issues-runtime-issue1072'].includes(scope.caseId)))
})

test('frozen r7 bytes retain exactly template, WXML and the blocked item producer scopes', () => {
  const directory = new URL('./fixtures/reviewed-producers/cjs-v4-r7-v1/', import.meta.url)
  const metadata = JSON.parse(readFileSync(new URL('revision.json', directory)))
  assert.deepEqual(metadata.caseScopes.map(scope => scope.caseId), ['ide-template-weapp-vite-multi-platform-template',
    'ide-wxml-transform-runtime', 'ide-github-issues-runtime-subpackage-item'])
  for (const scope of metadata.caseScopes) {
    const f = fixture(false), sources = Object.fromEntries(Object.entries(metadata.sources).map(([key, item]) => [key, f.put(readFileSync(new URL(item.path, directory)))]))
    const staticProfileInputs = metadata.staticProfileModules.map(item => ({ path: item.path, artifact: sources[item.key] }))
    const observation = { profile: metadata.profile, producer: sources.macroProducer, manifest: sources.macroManifest,
      observer: sources.macroObserver, validator: sources.macroValidator, profileInputs: staticProfileInputs }
    const consumer = { ...scope, producer: sources.compilerUseProducer, preload: sources.compilerUsePreload,
      staticProfileInputs, macroObservation: observation }
    const built = { caseId: scope.caseId, sourceSha256: scope.sourceSha256, producer: sources.fixtureBuildProducer,
      packer: { preload: sources.fixturePackerPreload }, staticProfileInputs, producerProfile: scope.snapshotProfile,
      producerInputs: metadata.snapshotModules.map(item => ({ path: item.path, artifact: sources[item.key] })) }
    assert.equal(reviewedCompilerProducer(consumer, f.load).id, metadata.id)
    assert.doesNotThrow(() => assertReviewedFixtureProducer(built, reviewedCompilerProducer(consumer, f.load), f.load))
    for (const caseId of ['ide-github-issues-runtime-subpackage-user', 'ide-template-weapp-vite-multi-platform-sfc-template'])
      assert.throws(() => reviewedCompilerProducer({ ...consumer, caseId }, f.load), /reviewed implementation|unknown or mixed/)
  }
})

test('unknown and unreviewed intermediate profiles cannot select a legacy revision', () => {
  for(const profile of ['unknown','pinned-json-macro-esm-cjs-v3','pinned-json-macro-esm-v1']) {
    const f=fixture(true);f.observation.profile=profile
    assert.throws(()=>reviewedCompilerProducer(f.consumer,f.load),/Unsupported/)
  }
})

test('legacy compiler recorder, preload, macro producer, manifest and validator cannot be mixed with current sources', () => {
  for(const key of ['compilerUseProducer','compilerUsePreload','macroProducer','macroManifest','macroValidator']) {
    const f=fixture(true),current=fixture(false),reference=current.sources[key]
    f.objects.set(reference.sha256,current.objects.get(reference.sha256))
    if(key==='compilerUseProducer')f.consumer.producer=reference
    else if(key==='compilerUsePreload')f.consumer.preload=reference
    else f.observation[{macroProducer:'producer',macroManifest:'manifest',macroValidator:'validator'}[key]]=reference
    assert.throws(()=>reviewedCompilerProducer(f.consumer,f.load),/mixed|differs/)
  }
})

test('current macro profile cannot carry old helper identities or an old recorder pair', () => {
  const f=fixture(true);f.observation.profile=MACRO_OBSERVATION_PROFILE
  assert.throws(()=>reviewedCompilerProducer(f.consumer,f.load),/differs/)
  const current=fixture(false),old=fixture(true)
  current.consumer.preload=old.consumer.preload;current.objects.set(old.consumer.preload.sha256,old.objects.get(old.consumer.preload.sha256))
  assert.throws(()=>reviewedCompilerProducer(current.consumer,current.load),/recorder differs/)
})

test('changing one archived source byte with a matching replacement CAS identity still fails revision admission', () => {
  for(const field of ['producer','manifest','observer','validator']) {
    const f=fixture(true),bytes=f.load(f.observation[field])
    f.observation[field]=f.put(Buffer.concat([bytes,Buffer.from('\n')]))
    assert.throws(()=>reviewedCompilerProducer(f.consumer,f.load),/differs/)
  }
})

test('legacy revision requires its reviewed case scope and explicit macro observation', () => {
  const f=fixture(true);f.consumer.caseId='ide-unreviewed-runtime'
  assert.throws(()=>reviewedCompilerProducer(f.consumer,f.load),/unknown or mixed/)
  const missing=fixture(true);delete missing.consumer.macroObservation
  assert.throws(()=>reviewedCompilerProducer(missing.consumer,missing.load),/recorder differs/)
})

test('fixture recorder must continue its actual compiler revision and cannot introduce snapshot provenance', () => {
  for(const mutate of [f=>{f.built.producerProfile='github'},f=>{f.built.producerInputs=[]},f=>{f.built.caseId='ide-foreign'},
    f=>{f.built.producer=f.put('changed producer')},f=>{f.built.packer.preload=f.put('changed preload')}]) {
    const f=fixture(true),revision=reviewedCompilerProducer(f.consumer,f.load);mutate(f)
    assert.throws(()=>assertReviewedFixtureProducer(f.built,revision,f.load),/unknown or mixed/)
  }
  const f=fixture(true)
  assert.throws(()=>assertReviewedFixtureProducer(f.built,{id:'unknown'},f.load),/unknown or mixed/)
  assert.throws(()=>assertReviewedFixtureProducer(f.built,{id:'current-reviewed-source'},f.load),/unknown or mixed/)
})

test('tampered fixed source and review provenance files fail before any archived JavaScript can execute', async t => {
  for(const path of [metadata.sources.macroProducer.path,metadata.provenance[0].copy]) {
    const temp=await mkdtemp(join(tmpdir(),'reviewed-producer-fixture-'));t.after(()=>rm(temp,{recursive:true,force:true}))
    await mkdir(join(temp,'scripts'),{recursive:true})
    await cp(new URL('./conformance-producer-revisions.mjs',import.meta.url),join(temp,'scripts/conformance-producer-revisions.mjs'))
    await cp(new URL("./conformance-static-cli-profile.mjs", import.meta.url), join(temp, "scripts/conformance-static-cli-profile.mjs"))
    const copy=join(temp,'scripts/fixtures/reviewed-producers/sealed-esm-v2-r3-v1')
    await cp(directory,copy,{recursive:true})
    await writeFile(join(copy,path),'throw new Error("ARCHIVED CODE MUST NEVER EXECUTE")')
    await assert.rejects(import(pathToFileURL(join(temp,'scripts/conformance-producer-revisions.mjs'))),/Fixed reviewed producer fixture hash\/size differs/)
  }
})


test('complete revision identity has all eight fixed source members and profiles alone do not admit any changed member', () => {
  for (const legacy of [false, true]) {
    const f = fixture(legacy), revision = reviewedCompilerProducer(f.consumer, f.load)
    assert.deepEqual(revision.identityTuple.map(item => item.key), Object.keys(files))
    assert.equal(Object.isFrozen(revision), true)
    for (const item of revision.identityTuple) {
      assert.equal(item.sha256, f.sources[item.key].sha256)
      assert.equal(item.bytes, f.sources[item.key].bytes)
      assert.equal(Object.isFrozen(item), true)
    }
    for (const key of Object.keys(files)) {
      const changed = fixture(legacy), reference = changed.put(Buffer.concat([changed.load(changed.sources[key]), Buffer.from('\n// unreviewed same profile')]))
      if (key === 'compilerUseProducer') changed.consumer.producer = reference
      else if (key === 'compilerUsePreload') changed.consumer.preload = reference
      else if (key === 'fixtureBuildProducer') changed.built.producer = reference
      else if (key === 'fixturePackerPreload') changed.built.packer.preload = reference
      else changed.observation[{macroProducer:'producer',macroManifest:'manifest',macroObserver:'observer',macroValidator:'validator'}[key]] = reference
      assert.throws(() => assertReviewedFixtureProducer(changed.built, reviewedCompilerProducer(changed.consumer, changed.load), changed.load), /differs|unknown or mixed/)
    }
  }
})

test('fixture revision selection cannot be forged or reused for a different consumer case', () => {
  const f = fixture(true), revision = reviewedCompilerProducer(f.consumer, f.load)
  for (const forged of [{ ...revision }, { id: metadata.id, profile: metadata.profile }, undefined])
    assert.throws(() => assertReviewedFixtureProducer(f.built, forged, f.load), /unknown or mixed/)
  f.built.caseId = metadata.caseIds[1]
  assert.throws(() => assertReviewedFixtureProducer(f.built, revision, f.load), /unknown or mixed/)
})

test('a matching CAS reference cannot hide different loaded source bytes', () => {
  const f = fixture(true)
  const substituted = reference => reference.sha256 === f.sources.macroObserver.sha256 ? Buffer.from('unreviewed observer') : f.load(reference)
  assert.throws(() => reviewedCompilerProducer(f.consumer, substituted), /differs/)
})

test('fixed fixture base and nested sources reject symbolic link substitution', async t => {
  for (const atBase of [true, false]) {
    const temp = await mkdtemp(join(tmpdir(), 'reviewed-producer-symlink-')); t.after(() => rm(temp, {recursive:true,force:true}))
    await mkdir(join(temp, 'scripts'), {recursive:true})
    await cp(new URL('./conformance-producer-revisions.mjs', import.meta.url), join(temp, 'scripts/conformance-producer-revisions.mjs'))
    await cp(new URL("./conformance-static-cli-profile.mjs", import.meta.url), join(temp, "scripts/conformance-static-cli-profile.mjs"))
    const target = join(temp, 'scripts/fixtures/reviewed-producers/sealed-esm-v2-r3-v1')
    await cp(directory, target, {recursive:true})
    const path = atBase ? target : join(target, 'sources')
    const original = path + '-original'
    await rename(path, original); await symlink(original, path, 'dir')
    await assert.rejects(import(pathToFileURL(join(temp,'scripts/conformance-producer-revisions.mjs'))), /symlink/)
  }
})

const r5bDirectory = new URL('./fixtures/reviewed-producers/cjs-v4-r5b-v1/', import.meta.url)
const r5bMetadata = JSON.parse(readFileSync(new URL('revision.json', r5bDirectory)))
function r5bFixture(caseId = 'ide-issue-1072-json-context-runtime') {
  const f = fixture(false), identity = r5bMetadata.caseScopes.find(scope => scope.caseId === caseId)
  assert(identity)
  f.sources = Object.fromEntries(Object.entries(r5bMetadata.sources).map(([key, reference]) => [key, f.put(readFileSync(new URL(reference.path, r5bDirectory)))]))
  f.consumer = { caseId, sourceSha256: identity.sourceSha256, caseSourcePath: identity.caseSourcePath,
    producer: f.sources.compilerUseProducer, preload: f.sources.compilerUsePreload,
    macroObservation: { profile: r5bMetadata.profile, producer: f.sources.macroProducer, manifest: f.sources.macroManifest,
      observer: f.sources.macroObserver, validator: f.sources.macroValidator, transforms: [] } }
  f.built = { caseId, sourceSha256: identity.sourceSha256, producer: f.sources.fixtureBuildProducer, packer: { preload: f.sources.fixturePackerPreload },
    ...(identity.snapshotProfile ? { producerProfile: identity.snapshotProfile, producerInputs: r5bMetadata.snapshotModules.map(({ key, path }) => ({ path, artifact: f.sources[key] })) } : {}) }
  return { ...f, identity }
}
test('r5b direct and both snapshot profiles complete the exact reviewed primary/conditional source groups', () => {
  for (const caseId of ['ide-issue-1072-json-context-runtime', 'ide-github-issues-runtime-issue1012', 'ide-github-issues-runtime-issue1014', 'ide-wxml-transform-runtime']) {
    const f = r5bFixture(caseId), selection = reviewedCompilerProducer(f.consumer, f.load)
    const complete = assertReviewedFixtureProducer(f.built, selection, f.load)
    assert.equal(complete.id, r5bMetadata.id)
    assert.deepEqual(complete.identityTuple.map(value => value.key), Object.keys(files))
    assert.equal(complete.snapshotIdentityTuple.length, f.identity.snapshotProfile ? 3 : 0)
    assert.equal(Object.isFrozen(complete), true)
    if (f.identity.snapshotProfile) assert.doesNotThrow(() => assertReviewedSnapshotProducer({
      reference: f.sources[f.identity.snapshotProfile.startsWith('github-') ? 'githubProducer' : 'wxmlProducer'],
      profile: f.identity.snapshotProfile, identity: f.identity }, complete, f.load))
  }
})
test('r5b same-profile unknown/mixed primary and all three snapshot members fail closed', () => {
  for (const key of Object.keys(r5bMetadata.sources)) {
    const f = r5bFixture('ide-github-issues-runtime-issue1012')
    const changed = f.put(Buffer.concat([f.load(f.sources[key]), Buffer.from('\n// same-profile unreviewed source')]))
    if (key === 'compilerUseProducer') f.consumer.producer = changed
    else if (key === 'compilerUsePreload') f.consumer.preload = changed
    else if (key === 'fixtureBuildProducer') f.built.producer = changed
    else if (key === 'fixturePackerPreload') f.built.packer.preload = changed
    else if (key.startsWith('macro')) f.consumer.macroObservation[{macroProducer:'producer',macroManifest:'manifest',macroObserver:'observer',macroValidator:'validator'}[key]] = changed
    else f.built.producerInputs[r5bMetadata.snapshotModules.findIndex(item => item.key === key)].artifact = changed
    assert.throws(() => assertReviewedFixtureProducer(f.built, reviewedCompilerProducer(f.consumer, f.load), f.load), /differs|unknown or mixed/)
  }
  for (const key of ['githubProducer', 'wxmlProducer']) {
    const f = r5bFixture('ide-github-issues-runtime-issue1012')
    f.built.producerInputs[r5bMetadata.snapshotModules.findIndex(item => item.key === key)].artifact = f.put(readFileSync(new URL('./conformance-' + (key === 'githubProducer' ? 'github' : 'wxml') + '-producer.mjs', import.meta.url)))
    assert.throws(() => assertReviewedFixtureProducer(f.built, reviewedCompilerProducer(f.consumer, f.load), f.load), /unknown or mixed/)
  }
})
test('snapshot profile alone, incomplete/order/path/extra closures and wrong fixed case scope cannot select r5b', () => {
  for (const mutate of [f => { delete f.built.producerInputs }, f => { f.built.producerInputs.pop() },
    f => { f.built.producerInputs.reverse() }, f => { f.built.producerInputs[1].path = f.built.producerInputs[0].path },
    f => { f.built.producerInputs.push(f.built.producerInputs[0]) }, f => { f.built.producerInputs[0].foreign = true },
    f => { f.built.producerProfile = 'unknown' }, f => { f.built.producerProfile = 'wxml-static-snapshot-v1' },
    f => { f.consumer.sourceSha256 = 'f'.repeat(64) }, f => { f.consumer.caseSourcePath += '.foreign' },
    f => { f.built.sourceSha256 = 'f'.repeat(64) }, f => { delete f.consumer.macroObservation }]) {
    const f = r5bFixture('ide-github-issues-runtime-issue1012'); mutate(f)
    assert.throws(() => assertReviewedFixtureProducer(f.built, reviewedCompilerProducer(f.consumer, f.load), f.load), /differs|unknown or mixed/)
  }
  const f = r5bFixture(); f.built.producerProfile = 'github-static-snapshot-v1'
  f.built.producerInputs = r5bMetadata.snapshotModules.map(({ key, path }) => ({ path, artifact: f.sources[key] }))
  assert.throws(() => assertReviewedFixtureProducer(f.built, reviewedCompilerProducer(f.consumer, f.load), f.load), /unknown or mixed/)
})
test('only an opaque complete snapshot token from the same source case can authorize a transaction producer identity', () => {
  const f = r5bFixture('ide-github-issues-runtime-issue1012'), consumer = reviewedCompilerProducer(f.consumer, f.load)
  const complete = assertReviewedFixtureProducer(f.built, consumer, f.load)
  const input = { reference: f.sources.githubProducer, profile: f.identity.snapshotProfile, identity: f.identity }
  for (const forged of [consumer, { ...complete }, { id: complete.id }, undefined])
    assert.throws(() => assertReviewedSnapshotProducer(input, forged, f.load), /unknown, mixed/)
  for (const key of ['caseId', 'sourceSha256', 'caseSourcePath'])
    assert.throws(() => assertReviewedSnapshotProducer({ ...input, identity: { ...f.identity, [key]: 'foreign' } }, complete, f.load), /another consumer/)
  assert.throws(() => assertReviewedSnapshotProducer({ ...input, reference: f.put('same profile unreviewed producer') }, complete, f.load), /complete reviewed closure/)
  const direct = r5bFixture(), token = assertReviewedFixtureProducer(direct.built, reviewedCompilerProducer(direct.consumer, direct.load), direct.load)
  assert.throws(() => assertReviewedSnapshotProducer(input, token, f.load), /unknown, mixed/)
})

test('the completed r5c 1012 revision retains exactly its actual eleven source members and one source scope', () => {
  const directory = new URL('./fixtures/reviewed-producers/cjs-v4-r5c-v1/', import.meta.url)
  const metadata = JSON.parse(readFileSync(new URL('revision.json', directory)))
  assert.equal(metadata.caseScopes.length, 1)
  const identity = metadata.caseScopes[0]
  assert.equal(identity.caseId, 'ide-github-issues-runtime-issue1012')
  const f = fixture(false)
  const sources = Object.fromEntries(Object.entries(metadata.sources).map(([key, ref]) => [key, f.put(readFileSync(new URL(ref.path, directory)))]))
  const consumer = { ...identity, producer: sources.compilerUseProducer, preload: sources.compilerUsePreload,
    macroObservation: { profile: metadata.profile, producer: sources.macroProducer, manifest: sources.macroManifest,
      observer: sources.macroObserver, validator: sources.macroValidator } }
  const built = { ...identity, producer: sources.fixtureBuildProducer, packer: { preload: sources.fixturePackerPreload },
    producerProfile: identity.snapshotProfile, producerInputs: metadata.snapshotModules.map(({ key, path }) => ({ path, artifact: sources[key] })) }
  const token = assertReviewedFixtureProducer(built, reviewedCompilerProducer(consumer, f.load), f.load)
  assert.equal(token.id, metadata.id)
  assert.equal(token.identityTuple.length, 8)
  assert.equal(token.snapshotIdentityTuple.length, 3)
  assert.doesNotThrow(() => assertReviewedSnapshotProducer({ reference: sources.githubProducer, profile: identity.snapshotProfile, identity }, token, f.load))
  for (const patch of [{ caseId: 'ide-issue-1034-auto-routes-runtime' }, { sourceSha256: 'f'.repeat(64) }, { caseSourcePath: identity.caseSourcePath + '.foreign' }])
    assert.throws(() => reviewedCompilerProducer({ ...consumer, ...patch }, f.load), /unknown or mixed/)
  const extra = { path: 'scripts/conformance-temporary-project-producer.mjs', artifact: f.put(readFileSync(new URL('./conformance-temporary-project-producer.mjs', import.meta.url))) }
  assert.throws(() => assertReviewedFixtureProducer({ ...built, producerInputs: [...built.producerInputs, extra] }, reviewedCompilerProducer(consumer, f.load), f.load), /unknown or mixed/)
})

test('current snapshots require all five actual module identities while unknown profiles and incomplete closures fail', () => {
  const snapshotFiles = { githubProducer: './conformance-github-producer.mjs', wxmlProducer: './conformance-wxml-producer.mjs',
    snapshotTransport: './conformance-snapshot-transport.mjs', temporaryProjectProducer: './conformance-temporary-project-producer.mjs',
    issue1034Producer: './conformance-issue1034-producer.mjs' }
  for (const [profile, key] of [['github-static-snapshot-v1', 'githubProducer'], ['wxml-static-snapshot-v1', 'wxmlProducer'], ['issue1034-static-snapshot-v1', 'issue1034Producer']]) {
    const f = fixture(false)
    const identity = { caseId: 'synthetic-current-source', sourceSha256: 'a'.repeat(64), caseSourcePath: 'e2e/synthetic.ts' }
    const sources = Object.fromEntries(Object.entries(snapshotFiles).map(([key, path]) => [key, f.put(readFileSync(new URL(path, import.meta.url)))]))
    Object.assign(f.consumer, identity); Object.assign(f.built, identity, { producerProfile: profile,
      producerInputs: Object.entries(snapshotFiles).map(([key, path]) => ({ path: 'scripts/' + path.slice(2), artifact: sources[key] })) })
    const consumer = reviewedCompilerProducer(f.consumer, f.load), complete = assertReviewedFixtureProducer(f.built, consumer, f.load)
    assert.equal(complete.snapshotIdentityTuple.length, 5)
    assert.doesNotThrow(() => assertReviewedSnapshotProducer({ reference: sources[key], profile, identity }, complete, f.load))
    for (const inputs of [f.built.producerInputs.slice(0, 3), [...f.built.producerInputs].reverse(), [...f.built.producerInputs, f.built.producerInputs[0]]])
      assert.throws(() => assertReviewedFixtureProducer({ ...f.built, producerInputs: inputs }, consumer, f.load), /unknown or mixed/)
    for (let index = 0; index < 5; index++) {
      const inputs = structuredClone(f.built.producerInputs); inputs[index].artifact = f.put('changed module with the same profile')
      assert.throws(() => assertReviewedFixtureProducer({ ...f.built, producerInputs: inputs }, consumer, f.load), /unknown or mixed/)
    }
    assert.throws(() => assertReviewedFixtureProducer({ ...f.built, producerProfile: 'unknown-snapshot-v1' }, consumer, f.load), /unknown or mixed/)
  }
})

test('every new current consumer, macro and fixture seals both static helper modules; historical shapes cannot borrow them', () => {
  for (const field of ['consumer', 'observation', 'built']) for (const mutate of [v => v.pop(), v => v.reverse(), v => v.push(v[0]), v => v[0].artifact = fixture(false).put('unreviewed helper')]) {
    const f = fixture(false), target = f[field], key = field === 'observation' ? 'profileInputs' : 'staticProfileInputs'
    target[key] = structuredClone(target[key]); mutate(target[key])
    if (field === 'built') { const selected = reviewedCompilerProducer(f.consumer, f.load); assert.throws(() => assertReviewedFixtureProducer(f.built, selected, f.load)) }
    else assert.throws(() => reviewedCompilerProducer(f.consumer, f.load))
  }
  for (const field of ['consumer', 'observation', 'built']) {
    const f = fixture(true), current = fixture(false), key = field === 'observation' ? 'profileInputs' : 'staticProfileInputs'
    f[field][key] = current[field][key]
    if (field === 'built') assert.throws(() => assertReviewedFixtureProducer(f.built, reviewedCompilerProducer(f.consumer, f.load), f.load))
    else assert.throws(() => reviewedCompilerProducer(f.consumer, f.load))
  }
})

const r5fDirectory = new URL('./fixtures/reviewed-producers/cjs-v4-r5f-v1/', import.meta.url)
const r5fMetadata = JSON.parse(readFileSync(new URL('revision.json', r5fDirectory)))
const r5fScope = { caseId: 'ide-issue-1034-auto-routes-runtime',
  sourceSha256: '7af17235a588c76b5cf8cf5f8659b35a7b806ba421ba67e59e5146b2b41f1a4c',
  caseSourcePath: 'e2e/ide/issue-1034-auto-routes.runtime.test.ts', snapshotProfile: 'issue1034-static-snapshot-v1' }
const r5fSnapshotKeys = ['githubProducer', 'wxmlProducer', 'snapshotTransport', 'temporaryProjectProducer', 'issue1034Producer']
function r5fFixture() {
  const f = fixture(false)
  f.sources = Object.fromEntries(Object.entries(r5fMetadata.sources).map(([key, reference]) =>
    [key, f.put(readFileSync(new URL(reference.path, r5fDirectory)))]))
  f.observation = { profile: r5fMetadata.profile, producer: f.sources.macroProducer, manifest: f.sources.macroManifest,
    observer: f.sources.macroObserver, validator: f.sources.macroValidator, transforms: [] }
  f.consumer = { ...r5fScope, producer: f.sources.compilerUseProducer, preload: f.sources.compilerUsePreload, macroObservation: f.observation }
  delete f.consumer.snapshotProfile
  f.built = { caseId: r5fScope.caseId, sourceSha256: r5fScope.sourceSha256,
    producer: f.sources.fixtureBuildProducer, packer: { preload: f.sources.fixturePackerPreload },
    producerProfile: r5fScope.snapshotProfile,
    producerInputs: r5fMetadata.snapshotModules.map(({ key, path }) => ({ path, artifact: f.sources[key] })) }
  return f
}
const completeR5f = f => assertReviewedFixtureProducer(f.built, reviewedCompilerProducer(f.consumer, f.load), f.load)

test('r5f admits exactly the completed actual 1034 eight-plus-five source tuple and one exact scope', () => {
  assert.deepEqual(r5fMetadata.caseScopes, [r5fScope])
  assert.deepEqual(Object.keys(r5fMetadata.sources), [...Object.keys(files), ...r5fSnapshotKeys])
  assert.deepEqual(r5fMetadata.snapshotModules.map(value => value.key), r5fSnapshotKeys)
  const f = r5fFixture(), selected = reviewedCompilerProducer(f.consumer, f.load), complete = completeR5f(f)
  assert.equal(selected.id, r5fMetadata.id); assert.equal(complete.id, 'cjs-v4-r5f-reviewed-v1')
  assert.deepEqual(complete.identityTuple.map(value => value.key), Object.keys(files))
  assert.deepEqual(complete.snapshotIdentityTuple.map(value => value.key), r5fSnapshotKeys)
  for (const item of [...complete.identityTuple, ...complete.snapshotIdentityTuple]) {
    assert.equal(item.sha256, f.sources[item.key].sha256); assert.equal(item.bytes, f.sources[item.key].bytes)
    assert(Object.isFrozen(item))
  }
  assert(Object.isFrozen(complete)); assert.equal(complete.snapshotProfile, r5fScope.snapshotProfile)
  assert.doesNotThrow(() => assertReviewedSnapshotProducer({ reference: f.sources.issue1034Producer, profile: r5fScope.snapshotProfile, identity: r5fScope }, complete, f.load))
  assert.doesNotThrow(() => assertReviewedSnapshotTransport({ reference: f.sources.snapshotTransport, profile: r5fScope.snapshotProfile, identity: r5fScope }, complete, f.load))
})

test('r5f anonymized metadata and runner inputs preserve 211 source pairs and reviewed fixture integrity', () => {
  const expected = {
    'provenance/00-source-freeze.json': '5201915fbe6974710efcbfe7883441e4f1d1487b902acce5c71b4f1c2f09babb',
    'provenance/01-run.json': 'cb48783e43f7be6202edacfb042e892c58abf474002335b722699f969bf820ae',
    'provenance/02-oracle-full-reader-audit.json': '7610e6f2f5e166793e34201ad6a0683534d339e6a0bfb0308677a1dcc19da185',
    'provenance/03-review.json': 'c0611ed7406b22d4ea575bbb8e55542f187ca4d9c114dc8656eb0dd97f9fc100',
  }
  for (const [path, sha256] of Object.entries(expected)) {
    assert.equal(r5fMetadata.provenance.find(value => value.copy === path)?.sha256, sha256)
    assert.equal(hash(readFileSync(new URL(path, r5fDirectory))), sha256)
  }
  const verification = JSON.parse(readFileSync(new URL('provenance/10-source-tuple-verification.json', r5fDirectory)))
  assert.equal(verification.verifiedSourcePairCount, 211); assert.equal(verification.tuple.length, 13)
  assert.equal(verification.archivedJavaScriptExecuted, false)
  const paths = ['revision.json', ...Object.values(r5fMetadata.sources).map(value => value.path), ...r5fMetadata.provenance.map(value => value.copy)]
  assert.equal(paths.length, 25)
  assert.deepEqual(REVIEWED_PRODUCER_INPUTS.filter(path => path.includes('/cjs-v4-r5f-v1/')),
    paths.map(path => 'scripts/fixtures/reviewed-producers/cjs-v4-r5f-v1/' + path))
})

test('every changed r5f primary or snapshot member fails even with a matching replacement CAS reference', () => {
  for (const key of Object.keys(r5fMetadata.sources)) {
    const f = r5fFixture(), changed = f.put(Buffer.concat([f.load(f.sources[key]), Buffer.from('\n// unreviewed member')]))
    if (key === 'compilerUseProducer') f.consumer.producer = changed
    else if (key === 'compilerUsePreload') f.consumer.preload = changed
    else if (key === 'fixtureBuildProducer') f.built.producer = changed
    else if (key === 'fixturePackerPreload') f.built.packer.preload = changed
    else if (r5fSnapshotKeys.includes(key)) f.built.producerInputs[r5fSnapshotKeys.indexOf(key)].artifact = changed
    else f.observation[{ macroProducer: 'producer', macroManifest: 'manifest', macroObserver: 'observer', macroValidator: 'validator' }[key]] = changed
    assert.throws(() => completeR5f(f), /differs|unknown or mixed/, key)
  }
})

test('r5f refuses other case ids, source bytes, source paths and fixture identities', () => {
  for (const [key, value] of [['caseId', 'ide-github-issues-runtime-issue1012'], ['caseId', 'ide-unrun-runtime'],
    ['sourceSha256', 'f'.repeat(64)], ['caseSourcePath', 'e2e/ide/foreign.test.ts']]) {
    const f = r5fFixture(); f.consumer[key] = value
    assert.throws(() => completeR5f(f), /unknown or mixed/)
  }
  for (const mutate of [f => { f.built.caseId = 'ide-unrun-runtime' }, f => { f.built.sourceSha256 = 'f'.repeat(64) }]) {
    const f = r5fFixture(); mutate(f); assert.throws(() => completeR5f(f), /unknown or mixed/)
  }
})

test('r5f cannot become direct or another snapshot profile and requires all five exact ordered paths', () => {
  const schema = JSON.parse(readFileSync(new URL('../schemas/conformance-fixture-build-v1.schema.json', import.meta.url)))
  assert.deepEqual(schema.properties.producerInputs.oneOf, [{ minItems: 3, maxItems: 3 }, { minItems: 5, maxItems: 5 }])
  for (const mutate of [f => { delete f.built.producerInputs; delete f.built.producerProfile },
    f => { f.built.producerProfile = 'github-static-snapshot-v1' }, f => { f.built.producerInputs = f.built.producerInputs.slice(0, 3) },
    f => f.built.producerInputs.reverse(), f => f.built.producerInputs.push(f.built.producerInputs[0]),
    f => { f.built.producerInputs[1].path = f.built.producerInputs[0].path },
    f => { f.built.producerInputs[0].extra = true }]) {
    const f = r5fFixture(); mutate(f); assert.throws(() => completeR5f(f), /unknown or mixed/)
  }
})

test('r5f complete tokens remain opaque and cannot cross case, source, profile or transport boundaries', () => {
  const f = r5fFixture(), selection = reviewedCompilerProducer(f.consumer, f.load), complete = completeR5f(f)
  assert.throws(() => assertReviewedFixtureProducer(f.built, { ...selection }, f.load), /unknown or mixed/)
  const request = { reference: f.sources.issue1034Producer, profile: r5fScope.snapshotProfile, identity: r5fScope }
  for (const forged of [{ ...complete }, { id: complete.id }, undefined])
    assert.throws(() => assertReviewedSnapshotProducer(request, forged, f.load), /unknown, mixed/)
  for (const [key, value] of [['caseId', 'ide-foreign'], ['sourceSha256', 'e'.repeat(64)], ['caseSourcePath', 'e2e/ide/foreign.test.ts']]) {
    const identity = { ...r5fScope, [key]: value }
    assert.throws(() => assertReviewedSnapshotProducer({ ...request, identity }, complete, f.load), /unknown, mixed/)
    assert.throws(() => assertReviewedSnapshotTransport({ ...request, reference: f.sources.snapshotTransport, identity }, complete, f.load), /unknown, mixed/)
  }
  assert.throws(() => assertReviewedSnapshotProducer({ ...request, profile: 'github-static-snapshot-v1' }, complete, f.load), /unknown, mixed/)
  assert.throws(() => assertReviewedSnapshotTransport({ ...request, reference: f.put('changed transport') }, complete, f.load), /differs/)
  assert.throws(() => assertReviewedSnapshotTransport({ ...request, reference: f.sources.snapshotTransport }, { ...complete }, f.load), /unknown, mixed/)
})

test('r5f rejects current helper additions and genuinely mixed earlier or current source groups', () => {
  for (const field of ['consumer', 'observation', 'built']) {
    const f = r5fFixture(), current = fixture(false), key = field === 'observation' ? 'profileInputs' : 'staticProfileInputs'
    f[field][key] = current[field][key]; assert.throws(() => completeR5f(f), /differs|unknown or mixed/)
  }
  for (const key of ['fixtureBuildProducer', 'macroValidator', 'githubProducer', 'wxmlProducer', 'temporaryProjectProducer']) {
    const f = r5fFixture(), path = key in files ? files[key] : './conformance-' + ({ githubProducer: 'github', wxmlProducer: 'wxml', temporaryProjectProducer: 'temporary-project' }[key]) + '-producer.mjs'
    const changed = f.put(readFileSync(new URL(path, import.meta.url)))
    if (changed.sha256 === f.sources[key].sha256) continue
    if (key === 'fixtureBuildProducer') f.built.producer = changed
    else if (key === 'macroValidator') f.observation.validator = changed
    else f.built.producerInputs[r5fSnapshotKeys.indexOf(key)].artifact = changed
    assert.throws(() => completeR5f(f), /differs|unknown or mixed/)
  }
})

test('r5f metadata, inert source and actual provenance substitution fail before archived code can execute', async t => {
  for (const path of ['revision.json', r5fMetadata.sources.issue1034Producer.path,
    'provenance/03-review.json', 'provenance/10-source-tuple-verification.json']) {
    const temp = await mkdtemp(join(tmpdir(), 'r5f-fixed-producer-')); t.after(() => rm(temp, { recursive: true, force: true }))
    await mkdir(join(temp, 'scripts'), { recursive: true })
    await cp(new URL('./conformance-producer-revisions.mjs', import.meta.url), join(temp, 'scripts/conformance-producer-revisions.mjs'))
    await cp(new URL("./conformance-static-cli-profile.mjs", import.meta.url), join(temp, "scripts/conformance-static-cli-profile.mjs"))
    await cp(new URL('./fixtures/reviewed-producers', import.meta.url), join(temp, 'scripts/fixtures/reviewed-producers'), { recursive: true })
    await writeFile(join(temp, 'scripts/fixtures/reviewed-producers/cjs-v4-r5f-v1', path), 'throw new Error("ARCHIVED CODE MUST NEVER EXECUTE")')
    await assert.rejects(import(pathToFileURL(join(temp, 'scripts/conformance-producer-revisions.mjs'))), /Fixed reviewed producer fixture hash\/size differs/)
  }
})


test('frozen pre-readiness r9 archive adds exactly nineteen inert files and six bounded read scopes', () => {
  const prefix = 'scripts/fixtures/reviewed-producers/cjs-v5-r9-before-readiness-v1/'
  const directory = new URL('./fixtures/reviewed-producers/cjs-v5-r9-before-readiness-v1/', import.meta.url)
  const metadata = JSON.parse(readFileSync(new URL('revision.json', directory)))
  const expected = ['revision.json', ...Object.values(metadata.sources).map(item => item.path),
    ...metadata.provenance.map(item => item.copy)].map(path => prefix + path)
  assert.equal(expected.length, 19)
  assert.deepEqual(REVIEWED_PRODUCER_INPUTS.filter(path => path.startsWith(prefix)), expected)
  assert.equal(Object.keys(metadata.sources).length, 15)
  assert.equal(metadata.caseScopes.length, 6)
  assert.ok(metadata.caseScopes.every(scope => !['ide-github-issues-runtime-import-meta',
    'ide-issue-1182-production-mount-runtime'].includes(scope.caseId)))
})


test('frozen r10 tuple admits only its complete actual SFC source scope and never the blocked Web attempt', () => {
  const prefix = 'scripts/fixtures/reviewed-producers/cjs-v5-r10-before-core-transform-v1/'
  const directory = new URL('./fixtures/reviewed-producers/cjs-v5-r10-before-core-transform-v1/', import.meta.url)
  const metadata = JSON.parse(readFileSync(new URL('revision.json', directory)))
  const expected = ['revision.json', ...Object.values(metadata.sources).map(item => item.path), ...metadata.provenance.map(item => item.copy)].map(path => prefix + path)
  assert.equal(expected.length, 21)
  assert.deepEqual(REVIEWED_PRODUCER_INPUTS.filter(path => path.startsWith(prefix)), expected)
  assert.equal(Object.keys(metadata.sources).length, 15)
  assert.deepEqual(metadata.sources.githubProducer, {path:'sources/githubProducer.txt',sha256:'ebea8e3d3f06bf82720fa47a1749e8940c0949cb25020e588c8691991bcdd9b4',bytes:19167})
  const actual=JSON.parse(readFileSync(new URL('provenance/actual-r10-tuple-observation.json',directory)))
  assert.equal(actual.members,15);assert.equal(actual.identicalToRetainedBeforeMacro,14);assert.deepEqual(actual.differentFromRetainedBeforeMacro,['githubProducer'])
  assert.deepEqual(metadata.caseScopes.map(scope => scope.caseId), ['ide-template-weapp-vite-multi-platform-sfc-template'])
  const f = fixture(false), scope = metadata.caseScopes[0]
  const sources = Object.fromEntries(Object.entries(metadata.sources).map(([key, item]) => [key, f.put(readFileSync(new URL(item.path, directory)))]))
  const staticProfileInputs = metadata.staticProfileModules.map(item => ({ path: item.path, artifact: sources[item.key] }))
  const consumer = { ...scope, producer: sources.compilerUseProducer, preload: sources.compilerUsePreload, staticProfileInputs,
    macroObservation: { profile: metadata.profile, producer: sources.macroProducer, manifest: sources.macroManifest, observer: sources.macroObserver, validator: sources.macroValidator, profileInputs: staticProfileInputs } }
  assert.equal(reviewedCompilerProducer(consumer, f.load).id, metadata.id)
  for (const changed of [{caseId:'ide-github-issues-runtime-web-runtime'}, {sourceSha256:'f'.repeat(64)}, {caseSourcePath:'e2e/ide/foreign.test.ts'}])
    assert.throws(() => reviewedCompilerProducer({...consumer,...changed},f.load), /reviewed implementation|unknown or mixed/)
})
