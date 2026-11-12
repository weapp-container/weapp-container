import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { verifyStaticGeneratedSupport, NPM_SUPPORT_PROFILE } from './conformance-fixture-build.mjs'

const capture = readFileSync(new URL('./fixtures/conformance-npm-support-capture.json.gz', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(hash(capture), 'e6d3aacd86e6a2f7c38c6fbd58ba06c28ef42447ca13ea457b317b3f2ea06d9b')
const actual = JSON.parse(gunzipSync(capture))
const portable = process.platform !== 'win32'
function fixture() {
  const { objects, ...value } = actual, f = structuredClone(value), stored = new Map(Object.entries(objects))
  f.load = ref => {
    const bytes = Buffer.from(stored.get(ref.sha256) ?? '', 'base64')
    assert.equal(hash(bytes), ref.sha256, 'anonymized fixture CAS bytes changed'); assert.equal(bytes.length, ref.bytes)
    return bytes
  }
  f.put = value => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    const sha256 = hash(bytes); stored.set(sha256, bytes.toString('base64'))
    return { path: `synthetic-negative-only/${sha256}`, sha256, bytes: bytes.length }
  }
  f.verify = () => verifyStaticGeneratedSupport(f.before, f.after, { identity: f.identity, members: f.members,
    load: f.load, npmSupport: f.build.npmSupport, compilerUse: f.compilerUse, build: f.build })
  // Negative tests rehash modified payloads and the enclosing log, so rejection
  // exercises semantic ownership/closure checks rather than merely a stale CAS.
  f.mutateMacro = (predicate, change) => {
    const old = f.build.npmSupport.log
    const events = f.load(old).toString('utf8').trim().split('\n').map(line => JSON.parse(line))
    const target = events.filter(event => event.kind === 'macro').map(event => ({ event, payload: JSON.parse(f.load(event.payload)) }))
      .find(item => predicate(item.payload))
    assert.ok(target, 'actual producer event exists'); change(target.payload)
    target.event.payload = f.put(target.payload)
    const log = f.put(events.map(event => JSON.stringify(event)).join('\n') + '\n')
    f.build.npmSupport.log = log
    f.compilerUse.logs = f.compilerUse.logs.map(ref => ref.sha256 === old.sha256 ? log : ref)
  }
  return f
}
const run = (name, operation) => test(name, { skip: !portable }, operation)
run('anonymized no-UI static fixture verifies all 1182 cache files plus seven known support members', () => {
  assert.equal(actual.provenance.originalAssertionsExecuted, false)
  assert.equal(actual.provenance.officialStatusPromotion, false)
  const f = fixture(), accepted = f.verify()
  assert.equal(accepted.length, 1189)
  assert.equal(accepted.filter(item => item.path.startsWith('.weapp-vite/npm-source/miniprogram_npm/')).length, 1182)
  assert.equal(f.build.npmSupport.profile, NPM_SUPPORT_PROFILE)
})
run('retained r7 failure is the support boundary; old exit0 output receives no backfilled proof', () => {
  const f = fixture(), h = f.historical
  assert.equal(h.exitCode, 0); assert.equal(h.failure, 'Static CLI added an unreviewed support file')
  assert.equal(h.after.length - h.before.length, 1189)
  assert.throws(() => verifyStaticGeneratedSupport(h.before, h.after, { identity: f.identity, members: f.members, load: f.load }), /no reviewed actual producer/)
})
run('missing proof, unknown producer profile and another case/owner cannot admit actual cached scripts', () => {
  for (const change of [f => { delete f.build.npmSupport }, f => { f.build.npmSupport.profile = 'unknown' },
    f => { f.compilerUse.macroObservation.profile = 'pinned-json-macro-esm-cjs-v4-runtime-input' },
    f => { f.identity.sourceSha256 = '0'.repeat(64) }, f => { f.build.npmSupport.runId = 'foreign-run' },
    f => { f.build.npmSupport.pid++ }, f => { f.compilerUse.logs = [] }]) {
    const f = fixture(); change(f); assert.throws(f.verify, /npm support/)
  }
})
run('added adjacent files, traversal, absolute and duplicate paths remain rejected', () => {
  for (const path of ['.weapp-vite/npm-source/nearby.js', '../outside.js', '/absolute.js', '.weapp-vite/npm-source/miniprogram_npm/../extra.js']) {
    const f = fixture(); f.after.push({ path, kind: 'file', artifact: f.put('unreviewed') }); assert.throws(f.verify)
  }
  const f = fixture(); f.after.push(f.after.at(-1)); assert.throws(f.verify, /Duplicate static source/)
})
run('missing/extra support and content replaced with a fresh valid CAS are rejected by exact cache equality', () => {
  for (const change of [f => { f.after.splice(f.after.findIndex(item => item.path.includes('/npm-source/')), 1) },
    f => { f.after.push({ path: '.weapp-vite/npm-source/miniprogram_npm/extra/index.js', kind: 'file', artifact: f.put('extra') }) },
    f => { f.after.find(item => item.path.includes('/npm-source/')).artifact = f.put('changed output') }]) {
    const f = fixture(); change(f); assert.throws(f.verify, /source closure differs/)
  }
})
run('changed original source bytes fail before npm proof inspection', () => {
  const f = fixture(), source = f.after.find(item => item.path === 'weapp-vite.config.ts')
  source.artifact = f.put('export default { npm: false }')
  assert.throws(f.verify, /mutated its original source/)
})
run('a forged pinned source in both closures cannot substitute the actual compiler source', () => {
  const f = fixture(), replacement = f.put('export default {}')
  f.before.find(item => item.path === 'weapp-vite.config.ts').artifact = replacement
  f.after.find(item => item.path === 'weapp-vite.config.ts').artifact = replacement
  assert.throws(f.verify, /original fixture inputs differ/)
})
run('actual input tree content and complete input member set stay bound to sealed dependencies', () => {
  for (const change of [ (p, f) => { p.inputObservation.files[0].artifact = f.put('changed dependency') },
    p => { p.inputObservation.files.pop() }, p => { p.inputObservation.files.push(p.inputObservation.files[0]) } ]) {
    const f = fixture(); f.mutateMacro(p => p.kind === 'span-start' && p.data?.kind === 'npm-package-build', p => change(p, f))
    assert.throws(f.verify, /input differs|incomplete|duplicate/)
  }
})
run('unsafe output tree paths and missing or extra observed cache members are rejected after rehashing', () => {
  for (const change of [p => { p.cacheObservation.files[0].path = '../escape.js' },
    p => { p.cacheObservation.files[0].path = '/absolute.js' }, p => { p.cacheObservation.files.pop() },
    p => { p.cacheObservation.files.push({ ...p.cacheObservation.files[0], path: 'unknown/index.js' }) }]) {
    const f = fixture(); f.mutateMacro(p => p.kind === 'span-end' && p.data?.kind === 'npm-service-build', change)
    assert.throws(f.verify, /Unsafe fixture|cache closure/)
  }
})
run('effective dependency selection, custom build options and cache redirects cannot borrow the producer profile', () => {
  for (const change of [p => { p.data.allDependencies.pop() }, p => { p.data.mainDependencies = ['camelcase'] },
    p => { p.data.hasBuildOptions = true }, p => { p.data.packageFiles = {} }, p => { p.data.sourceOutDir += '-foreign' },
    p => { p.data.localSubPackageRoots.pop() }]) {
    const f = fixture(); f.mutateMacro(p => p.kind === 'npm-service-plan', change)
    assert.throws(f.verify, /effective configuration/)
  }
})
run('actual package-resolution links and parent dependency edges cannot be replaced', () => {
  const f = fixture(), link = f.members.find(item => item.kind === 'link' && item.path === 'e2e-apps/github-issues/node_modules/camelcase')
  assert.ok(link); link.target = link.target.replace('/camelcase', '/foreign')
  assert.throws(f.verify, /resolution\/dependency edge/)
  const g = fixture(); g.mutateMacro(p => p.kind === 'span-start' && p.data?.kind === 'npm-package-build' && p.data.input.dep === 'rfdc', p => {
    p.span.parentId = 418
  })
  assert.throws(g.verify, /resolution\/dependency edge/)
})
run('the actual bundle entry, production defines, format and copied-package transform remain explicit', () => {
  for (const change of [p => { p.data.entry += '.foreign' }, p => { p.data.build.lib.formats = ['es'] },
    p => { p.data.build.define['import.meta.env.IS_WEB'] = 'true' }, p => { p.data.build.define.extra = '1' },
    p => { p.data.mode = 'copy-normalize' }]) {
    const f = fixture(); f.mutateMacro(p => p.kind === 'npm-package-output' && p.data.mode === 'bundle', change)
    assert.throws(f.verify, /bundle producer\/options/)
  }
  const f = fixture(); f.mutateMacro(p => p.kind === 'npm-package-output' && p.data.mode === 'copy-normalize', p => { p.data.sourceDir += '-foreign' })
  assert.throws(f.verify, /copy\/normalization/)
})
run('changed local publication dependencies, copy bytes, target absence and final published output fail independently', () => {
  for (const change of [p => { p.data.dependencies = ['tdesign-miniprogram'] }, p => { p.targetAbsent = false },
    p => { p.sourceObservation.files.pop() }]) {
    const f = fixture(); f.mutateMacro(p => p.kind === 'npm-subpackage-plan', change); assert.throws(f.verify, /local dependency\/config\/cache/)
  }
  const f = fixture(); f.mutateMacro(p => p.kind === 'npm-subpackage-output', p => { p.outputObservation.files[0].artifact = f.put('wrong copy') })
  assert.throws(f.verify, /local copy differs/)
  const g = fixture(); g.build.generated.find(item => item.path.startsWith('subpackages/item/miniprogram_npm/')).artifact = g.put('wrong published output')
  assert.throws(g.verify, /published static output differs/)
})
run('missing package observations and failed package outcomes cannot authorize existing output bytes', () => {
  const f = fixture(); f.mutateMacro(p => p.kind === 'npm-package-output', p => { p.kind = 'npm-unknown-producer' })
  assert.throws(f.verify, /package production is incomplete/)
  const g = fixture(); g.mutateMacro(p => p.kind === 'span-end' && p.data?.kind === 'npm-package-build', p => { p.data.outcome = 'threw' })
  assert.throws(g.verify, /outcome or event ordering/)
})
test('npm snapshot failure preserves actual operation returns, effects and exact thrown values while failing the terminal witness', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'npm-observer-neutral-')))
  try {
    const logs = join(root, 'loader-logs'); mkdirSync(logs)
    const guard = Buffer.from(JSON.stringify({ members: [] })), guardPath = join(root, 'guard.json'); writeFileSync(guardPath, guard)
    const observerPath = join(root, 'observer.mjs'), observer = readFileSync(new URL('./conformance-compiler-macro-observer.mjs', import.meta.url)); writeFileSync(observerPath, observer)
    const program = join(root, 'packages/weapp-vite/bin/weapp-vite.js'), project = join(root, 'project')
    mkdirSync(join(root, 'packages/weapp-vite/bin'), { recursive: true }); mkdirSync(project)
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    const fixture = Buffer.from(JSON.stringify({ projectPath: project, sourceBefore: [] }))
    writeFileSync(join(root, 'fixture.json'), fixture)
    writeFileSync(program, `import {observer} from ${JSON.stringify(pathToFileURL(observerPath).href)};const value={identity:true};let effects=0;const returned=await observer.span('npm-package-build',{packageRoot:${JSON.stringify(join(root, 'missing'))}},async()=>{effects++;return value});let thrownSame=false;try{await observer.span('npm-package-build',{packageRoot:${JSON.stringify(join(root, 'missing'))}},async()=>{effects++;throw value})}catch(error){thrownSame=error===value}console.log(JSON.stringify({returnedSame:returned===value,thrownSame,effects}));`)
    const config = { runId: 'synthetic-neutral-only', caseId: 'synthetic-neutral-only', sourceSha256: '0'.repeat(64), caseSourcePath: 'synthetic.mjs',
      checkout: root, evidenceRoot: root, logDirectory: logs, runnerFiles: [],
      membersReference: { path: 'guard.json', sha256: hash(guard), bytes: guard.length },
      macroObservation: { profile: 'pinned-json-macro-esm-cjs-v5-npm-support', observerPath, observer: { sha256: hash(observer), bytes: observer.length } } }
    const configPath = join(root, 'config.json'); writeFileSync(configPath, JSON.stringify(config))
    const output = execFileSync(process.execPath, [program, 'build', project, '--platform', 'weapp'],
      { cwd: root, encoding: 'utf8', env: { ...process.env,
        NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL('./conformance-compiler-use-preload.cjs', import.meta.url)))}`,
        WEAPP_CONTAINER_COMPILER_FIXTURE_INPUTS: JSON.stringify({ path: 'fixture.json', sha256: hash(fixture), bytes: fixture.length }),
        WEAPP_CONTAINER_COMPILER_USE_CONFIG: configPath } })
    assert.deepEqual(JSON.parse(output), { returnedSame: true, thrownSame: true, effects: 2 })
    const names = readdirSync(logs); assert.equal(names.length, 1); assert.match(names[0], /^\d+-0\.jsonl$/)
    const events = readFileSync(join(logs, names[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(events.some(event => event.kind === 'observer-failure'))
    assert.equal(events.at(-1).kind, 'end'); assert.equal(events.at(-1).observerFailed, true)
    assert.equal(events.at(-1).exitCode, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
