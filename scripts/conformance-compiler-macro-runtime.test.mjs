import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { MACRO_VALIDATION_PROFILE, validateMacroEvents } from './conformance-compiler-macro-validator.mjs'
import { fixture, digest, pins, runtimeId, runtimeText } from './fixtures/conformance-compiler-macro-runtime.mjs'

const outcome = f => validateMacroEvents(f.events, f.options)
const native = f => f.options.loads.find(load => load.format === 'addon')
const input = f => f.events.find(event => event.kind === 'actual-bundler-input' && event.data.id === runtimeId)
const edge = f => f.options.resolves.find(event => event.specifier === 'node:module')
const failClosed = (f, pattern) => {
  const result = outcome(f)
  assert.ok(result.errors.length, 'synthetic mutation must fail closed')
  if (pattern) assert.match(result.errors.join('\n'), pattern)
  assert.deepEqual(result.admittedLoads, []); assert.deepEqual(result.invocations, [])
}

test('the portable text fixture is the exact fixed runtime; its native identities remain synthetic claims', () => {
  assert.deepEqual(digest(runtimeText), { sha256: 'b8df5474d4a98c5b38ab10fc6806a9d8d8a3e78b367e3ff0fda8934739e4dcc8', bytes: 5296 })
  assert.equal(pins.length, 4)
  assert.ok(fixture().options.loads.every(load => load.runId === 'explicit-synthetic-portable-run'))
})

test('portable synthetic legacy and five fixed-runtime flows preserve distinct returned load references', () => {
  for (const runtime of [false, true]) {
    const f = fixture({ runtime, invocations: 5 }), result = outcome(f)
    assert.deepEqual(result.errors, [])
    assert.equal(result.admittedLoads.length, 5)
    assert.equal(new Set(result.invocations.map(item => item.requireSpanId)).size, 5)
    assert.equal(new Set(result.invocations.map(item => item.outputFile)).size, 5)
    assert.ok(result.admittedLoads.every(load => f.options.loads.includes(load)))
    assert.ok(result.invocations.every(item => item.profile === (runtime ? MACRO_VALIDATION_PROFILE : 'pinned-json-macro-esm-v1')))
  }
})

test('open hooks, source detachment, incomplete spans and unsupported fixed options reject synthetic flows', () => {
  const mutations = [
    f => { f.options.hookChainClosed = false },
    f => { f.options.validatedTransforms = false },
    f => { f.options.sourceSnapshots = new Map() },
    f => { f.events.find(event => event.kind === 'evalSource').data.originalContent += 'changed' },
    f => { f.events = f.events.slice(0, -1) },
    f => { f.events.find(event => event.kind === 'internalOptions').data.internalOptions.source = 'override' },
    f => { f.events.find(event => event.kind === 'cacheConfig').data.cacheConfig.enabled = true },
  ]
  for (const mutate of mutations) { const f = fixture(); mutate(f); failClosed(f) }
})

test('exact synthetic input/result pairs, moduleIds and both dependency arrays cannot be relaxed independently', () => {
  const mutations = [
    f => { const event = input(f); event.data.code += '\n'; f.events.find(item => item.kind === 'file-scope-result' && item.data.id === runtimeId).data.code += '\n' },
    f => { input(f).data.id = '\0other/runtime.js' },
    f => { const event = input(f); f.events = f.events.filter(item => item !== event) },
    f => { f.events = f.events.filter(item => !(item.kind === 'file-scope-result' && item.data.id === runtimeId)) },
    f => { f.events.find(item => item.kind === 'file-scope-result' && item.data.id === runtimeId).data.map = {} },
    f => { f.events.find(event => event.kind === 'entryChunk').data.output[0].moduleIds.reverse() },
    f => { f.events.find(event => event.kind === 'entryChunk').data.output[0].moduleIds.push('/unknown/input.json') },
    f => { f.events.find(event => event.kind === 'entryChunk').data.output[0].imports.push('node:fs') },
    f => { f.events.find(event => event.kind === 'entryChunk').data.output[0].imports = [] },
    f => { f.events.find(event => event.kind === 'entryChunk').data.output[0].dynamicImports.push('node:module') },
    f => { f.events.find(event => event.kind === 'span-start' && event.span.kind === 'loadFromBundledFile').data.input.dependencies = [] },
    f => { f.events.find(event => event.kind === 'span-start' && event.span.kind === 'loadFromBundledFile').data.input.dependencies = ['/unknown/dependency'] },
    f => { f.events.find(event => event.kind === 'req').data.dependencies = [] },
    f => { f.events.find(event => event.kind === 'req').data.dependencies = ['/unknown/dependency'] },
  ]
  for (const mutate of mutations) { const f = fixture(); mutate(f); failClosed(f) }
})

test('synthetic native witness and version closure require the exact prior successful dlopen contract', () => {
  const mutations = [
    f => { const event = native(f); f.options.loads = f.options.loads.filter(item => item !== event) },
    f => { native(f).sha256 = 'f'.repeat(64) },
    f => { native(f).bytes += 1 },
    f => { native(f).format = 'module' },
    f => { native(f).boundary = 'resolve-only' },
    f => { native(f).nativeFileStable = false },
    f => { native(f).witnessToken = '' },
    f => { native(f).witnessToken = 0 },
    f => { native(f).loadedSourceSha256 = native(f).sha256 },
    f => { native(f).eventSeq = f.events.at(-1).eventSeq + 1 },
    f => { native(f).runId += '-foreign' },
    f => { native(f).pid += 1 },
    f => { native(f).threadId += 1 },
    f => { native(f).path = native(f).path.replace('@1.2.14/', '@1.2.15/') },
    f => { native(f).classification = 'unbound' },
    f => { f.options.loads.push(structuredClone(native(f))) },
    f => { const member = f.options.members.get(native(f).path); f.options.members.set(member.path, { ...member, sha256: 'f'.repeat(64) }) },
    f => { const member = f.options.members.get(pins[0].path); f.options.members.set(member.path, { ...member, origin: 'output' }) },
    f => { f.options.loads.find(load => load.path === pins[1].path).loadedSourceSha256 = 'f'.repeat(64) },
    f => { f.options.loads = f.options.loads.filter(load => load.path !== pins[2].path) },
    f => { f.options.members = new Map() },
    f => { f.options.macroProfile = 'pinned-json-macro-esm-v1' },
    f => { f.options.cliCwd += '-foreign' },
  ]
  for (const mutate of mutations) { const f = fixture(); mutate(f); failClosed(f) }
})

test('synthetic generated-parent builtin resolution cannot be absent, remapped, duplicated or moved', () => {
  const mutations = [
    f => { const event = edge(f); f.options.resolves = f.options.resolves.filter(item => item !== event) },
    f => { edge(f).url = 'node:fs' },
    f => { edge(f).specifier = 'node:fs' },
    f => { edge(f).parentURL = 'file:///foreign-output.mjs' },
    f => { edge(f).runId += '-foreign' },
    f => { edge(f).eventSeq = 1 },
    f => { f.options.resolves.push(structuredClone(edge(f))) },
    f => { f.options.resolves.push({ ...edge(f), specifier: 'node:fs', url: 'node:fs' }) },
  ]
  for (const mutate of mutations) { const f = fixture(); mutate(f); failClosed(f) }
})

test('synthetic final bytes, regular-file lifecycle and actual import ownership remain mandatory', () => {
  const mutations = [
    f => { f.events.find(event => event.kind === 'before:fsp.writeFile(target').fileObservation.absent = false },
    f => { f.events.find(event => event.kind === 'after:fsp.writeFile(target').fileObservation.regular = false },
    f => { f.events.find(event => event.kind === 'req').data.defaultRequire = false },
    f => { f.options.loads.find(load => load.classification === 'unbound').loadedSourceSha256 = 'f'.repeat(64) },
    f => { f.options.loads.find(load => load.classification === 'unbound').macroContext.id += 1 },
    f => { f.options.resolves.find(event => event.specifier !== 'node:module').parentURL = 'file:///foreign-importer.mjs' },
  ]
  for (const mutate of mutations) { const f = fixture(); mutate(f); failClosed(f) }
})

test('the unchanged v4 validator remains a synchronous builtin-only module', () => {
  const file = fileURLToPath(new URL('./conformance-compiler-macro-validator.mjs', import.meta.url))
  execFileSync(process.execPath, ['--check', file])
  execFileSync(process.execPath, ['-e', 'require(process.argv[1])', file])
})
