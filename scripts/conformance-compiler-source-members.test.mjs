/** Synthetic native claims only. Exercises the complete macro reader plumbing;
 * no compiler, addon, SDK or UI is loaded by this portable contract test. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { inspectCompilerMacroLoads } from './conformance-compiler-observation.mjs'
import { cjsFixture } from './fixtures/conformance-compiler-macro-cjs.mjs'
import { pins } from './fixtures/conformance-compiler-macro-runtime.mjs'
import { TEMPLATE_SFC_STATIC_CASE, parseStaticCliInvocation, staticFixtureInputClosure } from './conformance-static-cli-profile.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

test('patched template source authority cannot replace original native dependency provenance', () => {
  const f = cjsFixture({ runtimeInput: true }), identity = TEMPLATE_SFC_STATIC_CASE
  const checkout = f.options.checkout, oldProject = f.options.projectPath, projectPath = join(checkout, identity.templateRelativePath)
  const oldPackage = f.options.sourceSnapshots.get(join(oldProject, 'package.json')).source
  const packageBytes = Buffer.from(oldPackage.replace('synthetic-cjs-project', identity.templateRelativePath.slice('templates/'.length)))
  const oldPackageHash = hash(oldPackage), newPackageHash = hash(packageBytes)
  const objects = new Map(f.objects)
  objects.set(newPackageHash, packageBytes)
  const put = value => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), sha256 = hash(bytes)
    objects.set(sha256, bytes)
    return { path: 'explicit-synthetic:' + sha256, sha256, bytes: bytes.length }
  }
  const load = reference => {
    const bytes = objects.get(reference.sha256)
    assert.ok(bytes); assert.equal(hash(bytes), reference.sha256); assert.equal(bytes.length, reference.bytes)
    return bytes
  }
  const remap = value => {
    if (typeof value === 'string') return value.replaceAll(pathToFileURL(join(checkout, '\0rolldown/runtime.js')).href, pathToFileURL(join(projectPath, '\0rolldown/runtime.js')).href)
      .replaceAll(oldProject, projectPath).replaceAll('synthetic-cjs-project', identity.templateRelativePath.slice('templates/'.length))
    if (Array.isArray(value)) return value.map(remap)
    if (!value || typeof value !== 'object') return value
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]))
    if (result.sha256 === oldPackageHash) {
      result.sha256 = newPackageHash; result.bytes = packageBytes.length
      if (result.path?.startsWith('synthetic-unread-artifact:')) result.path = 'explicit-synthetic:' + newPackageHash
    }
    return result
  }
  const sourceBefore = [...f.options.sourceSnapshots].map(([file, item]) => ({
    path: relative(oldProject, file), kind: 'file', artifact: put(file.endsWith('/package.json') ? packageBytes.toString() : item.source),
  }))
  const config = put('{"miniprogramRoot":"dist","compileType":"miniprogram","libVersion":"SYNTHETIC-PATCHED"}')
  sourceBefore.push({ path: 'config/weapp/project.config.json', kind: 'file', artifact: config })
  const sourceMembers = new Map(f.options.members)
  for (const item of sourceBefore) sourceMembers.set(join(identity.templateRelativePath, item.path), {
    path: join(identity.templateRelativePath, item.path), kind: 'file',
    origin: item.artifact === config ? 'patch' : 'source', sha256: item.artifact.sha256, bytes: item.artifact.bytes,
  })
  const members = new Map(sourceMembers), configPath = join(identity.templateRelativePath, 'config/weapp/project.config.json')
  const originalConfig = put('{"miniprogramRoot":"dist","compileType":"miniprogram","libVersion":"SYNTHETIC-ORIGINAL"}')
  members.set(configPath, { ...members.get(configPath), origin: 'source', sha256: originalConfig.sha256, bytes: originalConfig.bytes })
  const cli = join(checkout, 'packages/weapp-vite/bin/weapp-vite.js')
  const argv = [process.execPath, cli, 'build', projectPath, '--platform', 'weapp', '--skipNpm']
  const invocation = parseStaticCliInvocation({ args: argv.slice(1), cliPath: cli, cwd: projectPath, checkout, ...identity })
  assert.ok(invocation)
  const original = [...f.events.map(event => ({ eventSeq: event.eventSeq, kind: 'macro', payload: put(remap(event)) })),
    ...f.options.loads.map(remap), ...f.options.resolves.map(remap)].sort((a, b) => a.eventSeq - b.eventSeq)
  const events = [
    { kind: 'start', argv, cwd: projectPath, ...identity, isMainThread: true, threadId: 0, execArgv: [],
      hookWitness: 'terminal-rearm-registerHooks-v1', cjsCompileWitness: 'captured-node-cjs-compile-v1',
      fixtureInputClosure: put(staticFixtureInputClosure(invocation, sourceBefore)) },
    { kind: 'hook-ready', witnessToken: 1 }, ...original,
    { kind: 'end', witnessToken: 1, observerFailed: false, exitCode: 0 },
  ].map((event, index) => ({ ...event, runId: 'explicit-synthetic-cjs-run', pid: 424243, threadId: 0,
    witnessToken: 1, terminalResult: true, eventSeq: index + 1 }))
  const options = { events, observation: { profile: f.options.macroProfile, transforms: [] }, checkout, members, sourceMembers, load }
  assert.equal(inspectCompilerMacroLoads(options).size, 1)
  assert.throws(() => inspectCompilerMacroLoads({ ...options, sourceMembers: members }), /original source\/input bytes differ/)
  const nativePath = pins.find(pin => pin.role === 'addon').path
  for (const mutation of [{ origin: 'patch' }, { sha256: 'f'.repeat(64) }, { bytes: 1 }]) {
    const invalid = new Map(members); invalid.set(nativePath, { ...members.get(nativePath), ...mutation })
    assert.throws(() => inspectCompilerMacroLoads({ ...options, members: invalid }), /runtime dependency differs/)
  }
})
