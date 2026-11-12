/** Strict revised profile: dependency-free ESM or the exact pinned Rolldown
 * native runtime plus one macro entry. All accepted
 * output bytes must have a complete observed producer flow; names/directories
 * grant no admission. Callers first verify CAS, fixed insertion transforms,
 * process startup, fixture input closure, and the absence of unknown hooks. */
import { createHash } from 'node:crypto'
import { dirname, extname, isAbsolute, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const same = (a, b) => canonical(a) === canonical(b)
const digest = text => ({ sha256: hash(Buffer.from(text)), bytes: Buffer.byteLength(text) })
const identity = item => item?.artifact ?? item
const inside = (root, file) => file === root || file.startsWith(root + sep)
const processKey = item => `${item.runId}:${item.pid}:${item.threadId}`
const fail = message => { throw new Error(message) }
const ensure = (value, message) => { if (!value) fail(message) }

export const MACRO_VALIDATION_PROFILE = 'pinned-json-macro-esm-v2-rolldown-runtime'
export const CJS_MACRO_VALIDATION_PROFILE = 'pinned-json-macro-esm-cjs-v3'
export const CJS_RUNTIME_MACRO_VALIDATION_PROFILE = 'pinned-json-macro-esm-cjs-v4-runtime-input'
export const NPM_SUPPORT_MACRO_VALIDATION_PROFILE = 'pinned-json-macro-esm-cjs-v5-npm-support'
export const CORE_TRANSFORM_MACRO_VALIDATION_PROFILE = 'pinned-json-macro-esm-cjs-v6-core-transform'
export const NPM_SUPPORT_MACRO_PROFILES = Object.freeze([NPM_SUPPORT_MACRO_VALIDATION_PROFILE, CORE_TRANSFORM_MACRO_VALIDATION_PROFILE])
export const RUNTIME_INPUT_MACRO_PROFILES = Object.freeze([CJS_RUNTIME_MACRO_VALIDATION_PROFILE, ...NPM_SUPPORT_MACRO_PROFILES])
export const CJS_MACRO_PROFILES = Object.freeze([CJS_MACRO_VALIDATION_PROFILE, ...RUNTIME_INPUT_MACRO_PROFILES])
const runtimeId = '\0rolldown/runtime.js'
const runtimeDigest = { sha256: 'b8df5474d4a98c5b38ab10fc6806a9d8d8a3e78b367e3ff0fda8934739e4dcc8', bytes: 5296 }
// This CJS variant is an actual native input, even when no runtime module is
// emitted. Keep it separate from the ESM runtime, which imports node:module.
const cjsRuntimeDigest = { sha256: '967258928d5ea00be66165ef77f636512a5b0882bac3548cc7d1c917b6abac06', bytes: 5878 }
const rolldownRoot = 'node_modules/.pnpm/rolldown@1.2.14_patch_hash=61de75b4db18dfb15bfc1a547cbf43938d0602149f61d9a2e81e14b117aeb6a0/node_modules/rolldown'
const nativeRoot = 'node_modules/.pnpm/@rolldown+binding-darwin-arm64@1.2.14/node_modules/@rolldown/binding-darwin-arm64'
const nativeClosure = [
  { role: 'package', path: `${rolldownRoot}/package.json`, sha256: 'f46fa23bccbb2a1ee76a763b02a55853cdfea4aaf8b0f3b82e8d16bad8778020', bytes: 6101 },
  { role: 'wrapper', path: `${rolldownRoot}/dist/shared/binding-CUpfdq6A.mjs`, sha256: 'c0bca197e7c7819c84f6b0f1ab5e3923895c5aa140e5243df72ab375554f19a1', bytes: 35052 },
  { role: 'nativePackage', path: `${nativeRoot}/package.json`, sha256: 'b453dd4db5ea29e4a14fdfeada50b19aff59e64286dbc8b28fd219bf9be63d27', bytes: 855 },
  { role: 'addon', path: `${nativeRoot}/rolldown-binding.darwin-arm64.node`, sha256: '4e4ecbcd8bbdf4b189127493f79fef124c5c3dee1a68c02b2953bf29e9aebf1f', bytes: 17084304 },
]

const installerTargets = Object.freeze(['fetch', 'Headers', 'Request', 'Response', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'XMLHttpRequest', 'WebSocket', 'atob', 'btoa', 'queueMicrotask', 'performance', 'crypto', 'Event', 'CustomEvent'])
function pinnedInstallerCode(targets, options) {
  ensure(Array.isArray(targets) && targets.length && new Set(targets).size === targets.length
    && targets.every(value => installerTargets.includes(value)), 'Core installer targets are outside the pinned explicit contract')
  ensure(options && typeof options === 'object' && !Array.isArray(options)
    && Object.keys(options).every(key => ['localBindings', 'networkDefaults', 'passiveLocalBindings', 'setup', 'sourceMap'].includes(key))
    && ['localBindings', 'passiveLocalBindings', 'setup', 'sourceMap'].every(key => options[key] === undefined || typeof options[key] === 'boolean')
    && options.passiveLocalBindings !== true, 'Core installer options require the pinned active installer contract')
  const parameters = [`targets: ${JSON.stringify(targets)}`]
  if (options.networkDefaults !== undefined) parameters.push(`networkDefaults: ${JSON.stringify(options.networkDefaults)}`)
  const argument = `{ ${parameters.join(', ')} }`
  const lines = ['import { installWebRuntimeGlobals as __weappViteInstallRequestGlobals } from "weapp-vite/web-apis"']
  if (options.localBindings) {
    const bindings = [...targets]
    if (targets.some(value => ['fetch', 'Request', 'Response', 'XMLHttpRequest', 'WebSocket'].includes(value))) bindings.push('TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'Blob', 'File', 'FormData')
    if (targets.includes('CustomEvent')) bindings.push('Event')
    lines.push(`const __rh = __weappViteInstallRequestGlobals(${argument}) || globalThis`,
      ...[...new Set(bindings)].map(value => `var ${value} = __rh.${value}`))
  } else lines.push(`__weappViteInstallRequestGlobals(${argument})`)
  lines.push('')
  return lines.join('\n')
}

function verifyNativeRuntimeOwner(bundle, options) {
  const { checkout, projectPath, loads, members, macroProfile, cliCwd, cjs = false } = options
  ensure([MACRO_VALIDATION_PROFILE, ...CJS_MACRO_PROFILES].includes(macroProfile)
    && (cliCwd === checkout || cjs && RUNTIME_INPUT_MACRO_PROFILES.includes(macroProfile) && cliCwd === projectPath),
    'Pinned Rolldown runtime requires its explicit profile revision and bound CLI cwd')
  ensure(members instanceof Map, 'Pinned Rolldown runtime lacks the verified dependency member closure')
  for (const pin of nativeClosure) {
    const member = members.get(pin.path)
    ensure(member?.kind === 'file' && member.origin === 'dependency' && member.sha256 === pin.sha256 && member.bytes === pin.bytes,
      `Pinned Rolldown runtime dependency differs: ${pin.role}`)
    if (pin.role === 'package') continue
    const matches = loads.filter(load => processKey(load) === processKey(bundle.start)
      && load.file === join(checkout, pin.path) && load.path === pin.path
      && Number.isSafeInteger(load.eventSeq) && load.eventSeq < bundle.start.eventSeq)
    ensure(matches.length === 1, `Pinned Rolldown runtime requires one actual prior ${pin.role} load; observed ${matches.length}`)
    const load = matches[0]
    ensure(load.classification === 'bound' && load.sha256 === pin.sha256 && load.bytes === pin.bytes,
      `Pinned Rolldown runtime actual ${pin.role} load differs from its dependency member`)
    if (pin.role === 'addon') {
      ensure(load.format === 'addon' && load.boundary === 'process.dlopen' && load.nativeFileStable === true
        && Number.isSafeInteger(load.witnessToken) && load.witnessToken > 0 && load.loadedSourceSha256 === null,
      'Pinned Rolldown runtime lacks an actual successful stable dlopen witness')
    } else ensure(load.format === (pin.role === 'wrapper' ? 'module' : 'json') && load.loadedSourceSha256 === pin.sha256,
      `Pinned Rolldown runtime loaded ${pin.role} bytes/format differ`)
  }
}

function verifyFileScope(actual, transformed, cliCwd) {
  ensure(transformed.id === actual.id && transformed.map === null, 'Native file-scope result identity differs')
  const injected = `const __vite_injected_original_dirname = ${JSON.stringify(dirname(actual.id))};const __vite_injected_original_filename = ${JSON.stringify(actual.id)};const __vite_injected_original_import_meta_url = ${JSON.stringify(pathToFileURL(isAbsolute(actual.id) ? actual.id : join(cliCwd, actual.id)).href)};`
  ensure(transformed.code === injected + actual.code, 'Native file-scope transform differs from the pinned original transform')
}

export function validateMacroEvents(events, options) {
  const admittedLoads = [], invocations = [], errors = []
  try {
    const { checkout, projectPath, sourceSnapshots, loads = [], resolves = [], hookChainClosed, validatedTransforms } = options
    ensure(hookChainClosed === true && validatedTransforms === true, 'Macro validation requires verified fixed transforms and a closed CLI hook chain')
    ensure(isAbsolute(checkout) && isAbsolute(projectPath) && inside(checkout, projectPath), 'Macro project is not the bound CLI project')
    const sources = sourceSnapshots instanceof Map ? sourceSnapshots : new Map(Object.entries(sourceSnapshots ?? {}))
    const streams = new Map()
    for (const event of events) {
      ensure(Number.isInteger(event.pid) && Number.isInteger(event.threadId) && typeof event.runId === 'string'
        && Number.isInteger(event.eventSeq) && Number.isInteger(event.sequence), 'Macro event process/sequence identity is incomplete')
      const key = processKey(event), stream = streams.get(key) ?? { events: [], spans: new Map(), sequence: -1, eventSeq: -1 }
      ensure(event.sequence > stream.sequence && event.eventSeq > stream.eventSeq, 'Macro event sequence was duplicated or reordered')
      stream.sequence = event.sequence; stream.eventSeq = event.eventSeq
      const context = event.span
      ensure(context && Number.isInteger(context.id) && typeof context.kind === 'string', 'Macro event has no explicit causal span')
      if (event.kind === 'span-start') {
        ensure(!stream.spans.has(context.id), 'Macro span was reused')
        ensure(context.parentId === null || stream.spans.has(context.parentId) && !stream.spans.get(context.parentId).end, 'Macro parent span is missing or already closed')
        ensure(event.data.kind === context.kind, 'Macro span kind differs')
        stream.spans.set(context.id, { context, start: event, events: [] })
      }
      const span = stream.spans.get(context.id)
      ensure(span && same(span.context, context) && !span.end, 'Macro event context is unknown, changed, or closed')
      span.events.push(event); stream.events.push(event)
      if (event.kind === 'span-end') {
        ensure(event.data.kind === context.kind && ['returned', 'threw'].includes(event.data.outcome), 'Macro span outcome differs')
        ensure(![...stream.spans.values()].some(child => child.context.parentId === context.id && !child.end), 'Macro span closed before its child')
        span.end = event
      }
      streams.set(key, stream)
    }
    for (const stream of streams.values()) {
      const spans = stream.spans
      ensure([...spans.values()].every(span => span.end), 'Macro observation has an incomplete span')
      const chain = span => {
        const output = [], visited = new Set()
        while (span) {
          ensure(!visited.has(span.context.id), 'Macro span parent cycle')
          visited.add(span.context.id); output.push(span)
          span = span.context.parentId === null ? undefined : spans.get(span.context.parentId)
        }
        return output
      }
      const one = (items, label) => { ensure(items.length === 1, `Macro flow requires one ${label}; observed ${items.length}`); return items[0] }
      const direct = (span, kind) => one(span.events.filter(event => event.kind === kind), kind)
      const children = (span, kind) => [...spans.values()].filter(item => item.context.parentId === span.context.id && item.context.kind === kind)
      const returned = span => ensure(span.end.data.outcome === 'returned', `Macro ${span.context.kind} did not return successfully`)
      const requireText = (value, label) => { ensure(typeof value === 'string', `Macro ${label} bytes are missing`); return value }
      const bindSource = (filename, text) => {
        ensure(isAbsolute(filename) && inside(projectPath, filename), 'Macro original source escapes the bound project')
        const expected = identity(sources.get(filename))
        ensure(expected && same(digest(requireText(text, 'original source')), { sha256: expected.sha256, bytes: expected.bytes }), 'Macro original source differs from the CLI input closure')
      }
      const bindBlock = (source, block) => {
        if (!block) return undefined
        ensure(!block.src && typeof block.content === 'string' && Number.isInteger(block.loc?.start?.offset) && Number.isInteger(block.loc?.end?.offset)
          && source.slice(block.loc.start.offset, block.loc.end.offset) === block.content, 'Macro SFC block differs from the actual parsed source or uses an unsupported external block')
        return block.content
      }
      const verifySfcResolution = (resolution, injectionInput) => {
        returned(resolution)
        ensure(same(resolution.start.data.input, injectionInput), 'SFC resolution targets/options/source differ from the injection owner')
        const descriptor = direct(resolution, 'request-globals-sfc-descriptor')
        ensure(descriptor.data.source === injectionInput.source && descriptor.data.errors === 0, 'SFC injection requires the actual successful original parse')
        const script = descriptor.data.script, setup = descriptor.data.scriptSetup
        bindBlock(injectionInput.source, script); bindBlock(injectionInput.source, setup)
        const codeOptions = setup ? { ...injectionInput.options, localBindings: false } : injectionInput.options
        let expected = null, expectedOptions = [codeOptions]
        if (script && !script.src) expected = { index: script.loc.start.offset, code: pinnedInstallerCode(injectionInput.targets, codeOptions) }
        else if (setup && !setup.src || !script) {
          expectedOptions.push(codeOptions)
          expected = { index: 0, code: `<script lang="ts">\n${pinnedInstallerCode(injectionInput.targets, codeOptions)}</script>\n` }
        } else if (!setup) {
          const options = { ...injectionInput.options, setup: true }; expectedOptions.push(options)
          expected = { index: 0, code: `<script setup lang="ts">\n${pinnedInstallerCode(injectionInput.targets, options)}</script>\n` }
        }
        const generators = children(resolution, 'request-installer-code').sort((a, b) => a.start.eventSeq - b.start.eventSeq)
        ensure(generators.length === expectedOptions.length, 'SFC injection installer generation is missing, duplicated or foreign')
        generators.forEach((generator, index) => {
          returned(generator)
          ensure(generator.start.eventSeq > descriptor.eventSeq
            && same(generator.start.data.input.targets, injectionInput.targets)
            && same(generator.start.data.input.options, expectedOptions[index])
            && direct(generator, 'request-installer-code-result').data === pinnedInstallerCode(injectionInput.targets, expectedOptions[index]),
          'SFC installer bytes/options differ from the pinned actual generator')
        })
        const resolved = direct(resolution, 'request-globals-sfc-resolution-result')
        ensure(generators.every(generator => generator.end.eventSeq < resolved.eventSeq), 'SFC resolution returned before its actual generators')
        ensure(same(resolved.data, expected), 'SFC injection position/code differ from the exact pinned operation')
        const output = expected ? injectionInput.source.slice(0, expected.index) + expected.code + injectionInput.source.slice(expected.index) : injectionInput.source
        return { output, expected, resolved }
      }
      const claimedLoads = new Set()
      const bindLoadedCoreSource = (core, filename, original) => {
        const load = one([...spans.values()].filter(span => span.context.kind === 'core-source-load'
          && span.start.data.input.compilerContext === original.compilerContext
          && span.start.data.input.id === original.id && span.end.eventSeq < core.start.eventSeq
          && !claimedLoads.has(span.context.id)), 'unclaimed preceding load for the actual context and ID')
        returned(load)
        const entry = one(children(load, 'load-profiled-entry'), 'actual profiled entry load'); returned(entry)
        const entryInput = entry.start.data.input, entryResult = direct(entry, 'load-profiled-entry-result')
        ensure(entryInput.compilerContext === original.compilerContext && entryInput.sourceId === original.id
          && ['app', 'page', 'component'].includes(entryInput.type) && entryResult.data && typeof entryResult.data.code === 'string',
          'Entry load source/context/type differs from the actual hook')
        bindSource(filename, entryResult.data.code)
        const profiled = one(children(load, 'load-request-globals-profiled'), 'actual profiled globals injection'); returned(profiled)
        const profileInput = profiled.start.data.input
        ensure(profiled.start.eventSeq > entry.end.eventSeq && profileInput.compilerContext === original.compilerContext
          && profileInput.sourceId === original.id && same(profileInput.result, entryResult.data)
          && typeof profileInput.sourceMap === 'boolean', 'Profiled globals input differs from the actual completed entry load')
        const injection = one(children(profiled, 'load-request-globals'), 'actual load globals injection'); returned(injection)
        const input = injection.start.data.input
        ensure(input.sourceId === original.id && same(input.result, entryResult.data)
          && same(input.targets, profileInput.targets) && same(input.options, { ...profileInput.options, sourceMap: profileInput.sourceMap })
          && original.id === filename && original.id.endsWith('.vue'), 'Load globals input/options/source identity differs')
        const resolution = one(children(injection, 'request-globals-sfc-resolution'), 'actual load SFC injection resolution')
        const { output, expected, resolved } = verifySfcResolution(resolution, { source: input.result.code, targets: input.targets, options: input.options })
        ensure(expected, 'Load source rewrite has no actual insertion')
        const edit = one(children(injection, 'code-transform-edit'), 'actual MagicString edit'); returned(edit)
        ensure(edit.start.eventSeq > resolution.end.eventSeq && edit.start.data.input.sourceId === original.id
          && same(edit.start.data.input.result, entryResult.data) && same(edit.start.data.input.options, {sourceMap: input.options.sourceMap}),
          'MagicString edit input or operation order differs from its resolved injection')
        const append = direct(edit, 'load-sfc-append-left'), code = direct(edit, 'code-transform-edit-code'), edited = direct(edit, 'code-transform-edit-result')
        ensure(same(append.data, { sourceId: original.id, index: expected.index, code: expected.code })
          && append.eventSeq > edit.start.eventSeq && code.eventSeq > append.eventSeq && code.data.sourceId === original.id
          && code.data.code === output && edited.eventSeq > code.eventSeq && edited.data?.code === output,
          'MagicString actual appendLeft arguments, output bytes or operation order differ from the exact source splice')
        // Maps are retained as actual original return data. They cannot grant
        // source authority; every executable source byte is checked above.
        const injectionResult = direct(injection, 'load-request-globals-result'), profiledResult = direct(profiled, 'load-request-globals-profiled-result'), loaded = direct(load, 'core-source-load-result')
        ensure(injectionResult.eventSeq > edit.end.eventSeq && same(injectionResult.data, edited.data)
          && profiledResult.eventSeq > injection.end.eventSeq && same(profiledResult.data, injectionResult.data)
          && loaded.eventSeq > profiled.end.eventSeq && same(loaded.data, profiledResult.data)
          && loaded.data?.code === original.code, 'Actual load return differs from its completed injection chain or the core hook input')
        claimedLoads.add(load.context.id)
      }
      const coreBindings = new Map(), claimedCores = new Set()
      const bindCoreSource = (transform, filename, read) => {
        if (coreBindings.has(transform.context.id)) {
          ensure(coreBindings.get(transform.context.id) === read.source, 'Core transform owner source changed across macro invocations')
          return
        }
        const input = transform.start.data.input
        ensure(Number.isSafeInteger(input.compilerContext) && input.compilerContext > 0
          && typeof input.id === 'string' && input.code === read.source, 'Vue source lacks its actual compiler-context identity and hook input')
        const preceding = [...spans.values()].filter(span => span.context.kind === 'core-source-transform'
          && span.start.data.input.compilerContext === input.compilerContext && span.start.data.input.id === input.id
          && span.end.eventSeq < transform.start.eventSeq && !claimedCores.has(span.context.id))
        const core = one(preceding, 'unclaimed preceding core transform for the actual context and ID')
        returned(core)
        const original = core.start.data.input
        const snapshot = identity(sources.get(filename))
        if (snapshot && same(digest(requireText(original.code, 'core hook input')), {sha256:snapshot.sha256,bytes:snapshot.bytes})) bindSource(filename, original.code)
        else bindLoadedCoreSource(core, filename, original)
        ensure(typeof original.platformEnabled === 'boolean', 'Core platform transform selection was not observed')
        const resultEvent = direct(core, 'core-source-transform-result'), result = resultEvent.data
        const stages = core.events.filter(event => event.kind === 'core-import-meta')
        if (!stages.length) {
          ensure(result === null && !children(core, 'request-globals-transform').length
            && !core.events.some(event => ['core-request-globals', 'core-platform'].includes(event.kind)), 'Core early return acquired unobserved source changes')
          ensure(read.source === original.code, 'Core early return differs from the downstream Vue input')
        } else {
          const imported = one(stages, 'actual core import-meta stage')
          ensure(imported.data.id === input.id && typeof imported.data.code === 'string', 'Core import-meta stage is detached from its actual hook')
          const requests = one(children(core, 'request-globals-transform'), 'request globals transform child')
          returned(requests)
          ensure(requests.start.eventSeq > imported.eventSeq && requests.start.data.input.id === input.id
            && requests.start.data.input.code === imported.data.code, 'Request globals input or operation order differs from its core owner')
          const requestResult = direct(requests, 'request-globals-transform-result')
          const injected = children(requests, 'request-globals-sfc-inject')
          if (requestResult.data === null) ensure(!injected.length, 'A null request transform has an unrelated SFC injection')
          else {
            ensure(typeof requestResult.data === 'string', 'Core request globals result is not actual source text')
            const injection = one(injected, 'actual SFC injection child'); returned(injection)
            const injectionInput = injection.start.data.input
            ensure(injectionInput.source === imported.data.code, 'SFC injection source differs from its actual request input')
            const resolution = one(children(injection, 'request-globals-sfc-resolution'), 'SFC injection resolution'); returned(resolution)
            const { output } = verifySfcResolution(resolution, injectionInput)
            const injectedResult = direct(injection, 'request-globals-sfc-inject-result')
            ensure(injectedResult.eventSeq > resolution.end.eventSeq, 'SFC source splice preceded its actual insertion resolution')
            ensure(injectedResult.data === output && requestResult.data === output
              && requestResult.eventSeq > injection.end.eventSeq, 'Request globals output differs from its exact source splice or child order')
          }
          const next = direct(core, 'core-request-globals')
          ensure(next.data.id === input.id && next.data.code === (requestResult.data ?? imported.data.code)
            && next.eventSeq > requests.end.eventSeq, 'Core request result or operation order differs')
          let finalCode = next.data.code
          const platform = core.events.filter(event => event.kind === 'core-platform')
          if (original.platformEnabled) {
            const actual = one(platform, 'actual platform transform result')
            ensure(actual.data.id === input.id && typeof actual.data.code === 'string' && actual.eventSeq > next.eventSeq, 'Core platform result ownership/order differs')
            finalCode = actual.data.code
          } else ensure(!platform.length, 'Disabled platform transform acquired source authority')
          ensure(resultEvent.eventSeq > (platform.at(-1)?.eventSeq ?? next.eventSeq), 'Core actual return preceded its final observed stage')
          ensure(result === null ? finalCode === original.code : result && result.code === finalCode && result.map === null
            && Object.keys(result).sort().join(',') === 'code,map', 'Core actual return differs from its observed transformation stages')
          ensure(read.source === (result === null ? original.code : result.code), 'Core actual return differs from the downstream Vue source')
        }
        claimedCores.add(core.context.id); coreBindings.set(transform.context.id, read.source)
      }
      for (const requireSpan of [...spans.values()].filter(span => span.context.kind === 'bundleRequire')) {
        returned(requireSpan)
        const ancestors = chain(requireSpan), macro = one(ancestors.filter(span => span.context.kind === 'evaluateScriptSetupJsonMacro'), 'macro ancestor')
        ancestors.forEach(returned)
        const macroInput = macro.start.data.input, generated = direct(macro, 'evalSource').data, temp = direct(macro, 'after:writeFile(tempFile').data
        ensure(['defineAppJson', 'definePageJson', 'defineComponentJson', 'defineSitemapJson', 'defineThemeJson'].includes(macroInput.macroName), 'Unsupported macro kind')
        const filename = macroInput.filename
        ensure(generated.filename === filename && generated.originalContent === macroInput.originalContent && generated.preambleContent === macroInput.preambleContent
          && generated.lang === macroInput.lang && generated.macroName === macroInput.macroName, 'Macro evaluation input was detached from its generated source')
        ensure(generated.combinedContent === (macroInput.preambleContent ? `${macroInput.preambleContent}\n${macroInput.originalContent}` : macroInput.originalContent), 'Macro combined preamble/source differs')
        requireText(generated.evalSource, 'generated TypeScript')
        ensure(temp.filename === filename && temp.evalSource === generated.evalSource && dirname(temp.tempFile) === generated.tempDir, 'Macro temporary input write differs from evalSource')

        // chain() is ordered from the actual require towards its ancestors.
        // Route snapshot resolution can recursively extract the same Vue file;
        // only the nearest extraction owns this invocation's effective input.
        // Do not filter by filename: a foreign nearest owner must fail below.
        const configOwner = ancestors.find(span => span.context.kind === 'extractConfigFromVue')
        if (configOwner) {
          const owner = configOwner, content = direct(owner, 'content').data, blocks = direct(owner, 'setupContent').data
          const effective = direct(owner, 'macroEvalPreamble').data
          ensure(owner.start.data.input.vueFilePath === filename && content.filename === filename && blocks.filename === filename && effective.filename === filename
            && blocks.source === content.source, 'Vue config source ownership differs')
          bindSource(filename, content.source)
          const setup = bindBlock(content.source, blocks.scriptSetup), preamble = bindBlock(content.source, blocks.script)
          ensure(setup === effective.setupContent && preamble === effective.preambleContent, 'Vue config script/preamble extraction differs')
          const inlines = children(owner, 'inlineAutoRoutesImports')
          const inlineValue = original => {
            if (!effective.autoRoutesInline || !original) return original
            const matches = inlines.filter(span => span.start.data.input.source === original)
            const item = one(matches, 'inline source transform'); returned(item)
            ensure(same(item.start.data.input.inlineRoutes, effective.autoRoutesInline), 'Inline routes differ from the config extraction snapshot')
            const snapshots = children(owner, 'resolveAutoRoutesInlineSnapshot').flatMap(span => { returned(span); return span.events.filter(event => event.kind === 'inline-routes-snapshot') })
            ensure(snapshots.some(event => same(event.data, effective.autoRoutesInline)), 'Config inline routes have no actual service snapshot')
            return one(item.events.filter(event => ['inline-routes-result', 'inline-routes-unmodified'].includes(event.kind)), 'actual inline result').data
          }
          ensure(macroInput.originalContent === inlineValue(setup) && macroInput.preambleContent === inlineValue(preamble)
            && macroInput.preambleContent === effective.macroEvalPreamble, 'Macro effective setup/preamble differs from the observed inline transformation')
        } else {
          const owner = one(ancestors.filter(span => span.context.kind === 'parseVueFile'), 'parsed Vue owner'), block = direct(owner, 'scriptSetup').data
          const transforms = ancestors.filter(span => span.context.kind === 'transformVueLikeFile')
          let effectiveSource
          if (transforms.length) {
            const transform = one(transforms, 'Vue transform owner'), read = direct(transform, 'source').data
            ensure(read.filename === filename, 'Vue transform source filename differs')
            if (options.macroProfile === CORE_TRANSFORM_MACRO_VALIDATION_PROFILE) bindCoreSource(transform, filename, read)
            else bindSource(filename, read.source)
            const inlineTransforms = children(transform, 'resolveTransformAutoRoutesSource')
            if (inlineTransforms.length) {
              const inline = one(inlineTransforms, 'app routes transform'); returned(inline)
              ensure(inline.start.data.input.source === read.source, 'App routes transform input differs from the actual source')
              const unmodified = inline.events.filter(event => event.kind === 'auto-routes-unmodified')
              if (unmodified.length) {
                const result = one(unmodified, 'unmodified routes result').data
                ensure(result.source === read.source && result.signature === undefined && !read.source.includes('weapp-vite/auto-routes')
                  && !read.source.includes('virtual:weapp-vite-auto-routes'), 'App routes early return differs from the original condition')
                effectiveSource = result.source
              } else {
                const reference = direct(inline, 'signature').data
                ensure(same(reference.inlineRoutes, {
                  pages: reference.routesRef?.pages ?? [], entries: reference.routesRef?.entries ?? [], subPackages: reference.routesRef?.subPackages ?? [],
                }), 'App routes transformation is detached from its actual service reference')
                const result = direct(inline, 'auto-routes-result').data
                ensure(result.signature === reference.signature, 'App routes output signature differs from the actual reference')
                effectiveSource = result.source
              }
            } else effectiveSource = read.source
          } else {
            const compile = one(ancestors.filter(span => span.context.kind === 'compileVueLikeFile'), 'static direct Vue compilation owner'), input = compile.start.data.input
            ensure(input.filename === filename && (input.rawSource === undefined || input.rawSource === input.source), 'Direct Vue compilation has an unobserved source transform')
            bindSource(filename, input.source); effectiveSource = input.source
          }
          ensure(owner.start.data.input.filename === filename && block.filename === filename && block.source === owner.start.data.input.source, 'Vue transform source ownership differs')
          ensure(owner.start.data.input.source === effectiveSource, 'Parsed Vue source differs from the actual routes transformation')
          ensure(block.normalizedSource === effectiveSource.replace(/\r\n?/g, '\n'), 'Parsed Vue normalization differs')
          ensure(!block.scriptResolvedId && !block.scriptSetupResolvedId && !(block.sfcSrcDeps?.length), 'External Vue script inputs are unsupported')
          const setup = bindBlock(block.normalizedSource, block.scriptSetup), preamble = bindBlock(block.normalizedSource, block.script)
          ensure(macroInput.originalContent === setup && macroInput.preambleContent === preamble, 'Macro input differs from the actual Vue descriptor')
        }

        const requested = requireSpan.start.data.input.options
        ensure(same(Object.keys(requested).sort(), ['cwd', 'filepath', 'tsconfig']) && requested.filepath === temp.tempFile && requested.cwd === dirname(filename) && requested.tsconfig === false, 'Macro bundleRequire options are outside the fixed profile')
        const internal = direct(requireSpan, 'internalOptions').data
        const fixedOptions = internal.internalOptions
        const cjs = fixedOptions.isESM === false && fixedOptions.format === 'cjs'
        ensure(internal.resolvedPath === temp.tempFile && (fixedOptions.isESM === true && fixedOptions.format === 'esm'
          || cjs && CJS_MACRO_PROFILES.includes(options.macroProfile)) && fixedOptions.tsconfig === false
          && (fixedOptions.sourcemap === undefined || fixedOptions.sourcemap === false)
          && Object.keys(fixedOptions).every(key => ['isESM', 'format', 'tsconfig', 'sourcemap'].includes(key)), 'Macro effective options are outside the fixed cache-free default-require profile')
        if (cjs) {
          ensure(isAbsolute(temp.tempFile) && inside(projectPath, temp.tempFile) && extname(temp.tempFile) === '.ts',
            'CJS macro source is not the reviewed absolute TypeScript file')
          const detection = one(children(requireSpan, 'detectModuleType'), 'actual module type detection'); returned(detection)
          ensure(same(detection.start.data.input, { resolvedPath: temp.tempFile })
            && same(direct(detection, 'module-type-result').data, { resolvedPath: temp.tempFile, isESM: false, deno: false })
            && detection.end.eventSeq < direct(requireSpan, 'internalOptions').eventSeq,
            'CJS macro options lack their original module type decision')
          const stats = detection.events.filter(event => event.kind === 'module-type-stat')
          const packages = detection.events.filter(event => event.kind === 'module-type-package')
          const parsed = one(packages, 'actual nearest package JSON read')
          let directory = dirname(temp.tempFile)
          ensure(stats.length > 0, 'CJS module type decision has no actual package search')
          for (const [index, stat] of stats.entries()) {
            const pkgPath = join(directory, 'package.json'), last = index === stats.length - 1
            ensure(inside(projectPath, pkgPath) && stat.data.pkgPath === pkgPath && stat.fileObservation?.path === pkgPath
              && (!last ? stat.data.regular === undefined && stat.fileObservation.absent === true
                : stat.data.regular === true && stat.fileObservation.regular === true && stat.fileObservation.absent === false),
              'CJS module type package search is incomplete, nonregular or outside the project')
            if (index) ensure(stats[index - 1].eventSeq < stat.eventSeq, 'CJS package search was reordered')
            if (last) {
              const source = sources.get(pkgPath), expected = identity(source)
              ensure(expected && typeof source.source === 'string' && parsed.data.pkgPath === pkgPath
                && stat.eventSeq < parsed.eventSeq && parsed.eventSeq < direct(detection, 'module-type-result').eventSeq
                && parsed.fileObservation?.path === pkgPath && parsed.fileObservation.regular === true && parsed.fileObservation.absent === false
                && same(digest(source.source), { sha256: expected.sha256, bytes: expected.bytes })
                && same({ sha256: stat.fileObservation.sha256, bytes: stat.fileObservation.bytes }, { sha256: expected.sha256, bytes: expected.bytes })
                && same({ sha256: stat.fileObservation.artifact?.sha256, bytes: stat.fileObservation.artifact?.bytes }, { sha256: expected.sha256, bytes: expected.bytes })
                && same({ sha256: parsed.fileObservation.sha256, bytes: parsed.fileObservation.bytes }, { sha256: expected.sha256, bytes: expected.bytes })
                && same({ sha256: parsed.fileObservation.artifact?.sha256, bytes: parsed.fileObservation.artifact?.bytes }, { sha256: expected.sha256, bytes: expected.bytes })
                && same(parsed.data.data, JSON.parse(source.source.replace(/^\uFEFF/, ''))) && parsed.data.data?.type !== 'module',
                'CJS nearest package differs from the actual original fixture JSON or selects ESM')
            }
            directory = dirname(directory)
          }
        }
        ensure(direct(requireSpan, 'cacheConfig').data.cacheConfig.enabled === false, 'Macro cache path is unsupported')
        const bundle = one(children(requireSpan, 'bundleFile'), 'native bundle operation'); returned(bundle)
        ensure(bundle.start.data.input.fileName === temp.tempFile && same(bundle.start.data.input.options, fixedOptions), 'Native bundler input/options differ')
        const inputs = bundle.events.filter(event => event.kind === 'actual-bundler-input')
        const results = bundle.events.filter(event => event.kind === 'file-scope-result')
        const hasRuntime = inputs.some(event => event.data.id === runtimeId)
        ensure(!cjs || !hasRuntime || RUNTIME_INPUT_MACRO_PROFILES.includes(options.macroProfile),
          'CJS macro virtual runtime dependencies are outside the reviewed profile')
        const expectedIds = hasRuntime ? [runtimeId, temp.tempFile] : [temp.tempFile]
        ensure(same(inputs.map(event => event.data.id), expectedIds) && same(results.map(event => event.data.id), expectedIds),
          'Native bundler inputs/results are outside the exact macro/runtime profile')
        for (const [index, input] of inputs.entries()) {
          const result = results[index]
          ensure(input.eventSeq < result.eventSeq && (index === inputs.length - 1 || result.eventSeq < inputs[index + 1].eventSeq),
            'Native bundler input/result pairs are reordered or detached')
          verifyFileScope(input.data, result.data, cjs && RUNTIME_INPUT_MACRO_PROFILES.includes(options.macroProfile) ? options.cliCwd : checkout)
        }
        const actual = inputs.at(-1).data
        ensure(actual.id === temp.tempFile && actual.code === generated.evalSource,
          'Actual native bundler input is missing or differs from evalSource')
        if (hasRuntime) {
          ensure(same(digest(requireText(inputs[0].data.code, 'pinned runtime')), cjs ? cjsRuntimeDigest : runtimeDigest), 'Pinned Rolldown virtual runtime bytes differ')
          verifyNativeRuntimeOwner(bundle, { ...options, loads, cjs })
        } else if (cjs) verifyNativeRuntimeOwner(bundle, { ...options, loads, cjs })
        const output = direct(bundle, 'entryChunk').data
        ensure(output.fileName === temp.tempFile && output.output.length === 1, 'Macro native output is not one closed entry chunk')
        const chunk = output.output[0]
        // Native transform inputs and emitted modules describe different stages.
        // The reviewed CJS runtime input is tree-shaken completely; it cannot
        // grant an emitted runtime module or any external import admission.
        const emittedIds = cjs ? [temp.tempFile] : expectedIds
        ensure(chunk.type === 'chunk' && chunk.isEntry === true && same(chunk.moduleIds, emittedIds)
          && same(chunk.imports, hasRuntime && !cjs ? ['node:module'] : []) && same(chunk.dynamicImports, []), 'Macro output has an unobserved/native/external dependency')
        // The pinned collectReferencedModules visits this sole chunk's moduleIds
        // in order, then bundleFile deletes exactly the source entry id.
        const expectedDependencies = chunk.moduleIds.filter(id => id !== temp.tempFile)
        requireText(chunk.code, 'native output')
        const loader = one(children(requireSpan, 'loadFromBundledFile'), 'bundled module loader'); returned(loader)
        const loaderInput = loader.start.data.input
        ensure(loaderInput.fileName === temp.tempFile && loaderInput.bundledCode === chunk.code && same(loaderInput.options, fixedOptions) && same(loaderInput.dependencies, expectedDependencies), 'Bundled loader was detached from native output/dependencies')
        ensure(direct(loader, 'cacheConfig').data.cacheConfig.enabled === false, 'Bundled loader used a cache path')
        const codeIdentity = digest(chunk.code)
        if (cjs) {
          ensure(children(loader, 'resolveTempOutputFile').length === 0 && !loader.events.some(event => ['req', 'after:mod = await req(outfile'].includes(event.kind)),
            'CJS macro was substituted with an ESM temporary-output/import path')
          const sourceWrite = direct(macro, 'after:writeFile(tempFile'), inputIdentity = digest(generated.evalSource)
          ensure(sourceWrite.fileObservation?.path === temp.tempFile && sourceWrite.fileObservation.regular === true
            && sourceWrite.fileObservation.absent === false
            && same({ sha256: sourceWrite.fileObservation.sha256, bytes: sourceWrite.fileObservation.bytes }, inputIdentity)
            && same({ sha256: sourceWrite.fileObservation.artifact?.sha256, bytes: sourceWrite.fileObservation.artifact?.bytes }, inputIdentity),
            'CJS original temporary input write has no actual physical source bytes')
          const before = direct(loader, 'cjs-extension-before'), installed = direct(loader, 'cjs-extension-installed')
          const cleared = direct(loader, 'cjs-cache-cleared'), request = direct(loader, 'cjs-require-before')
          const finished = direct(loader, 'cjs-require-after'), restored = direct(loader, 'cjs-extension-restored')
          const fileFields = { fileName: temp.tempFile, realFileName: temp.tempFile, extension: '.ts' }
          ensure(same(before.data, { ...fileFields, originalLoaderType: before.data.originalLoaderType, fallbackLoaderType: 'function' })
            && ['undefined', 'function'].includes(before.data.originalLoaderType)
            && same(installed.data, { ...fileFields, installed: true })
            && same(cleared.data, { fileName: temp.tempFile, realFileName: temp.tempFile, cacheAbsent: true })
            && same(request.data, { ...fileFields, defaultRequire: true, bundledCode: chunk.code, dependencies: expectedDependencies })
            && same(finished.data, fileFields) && same(restored.data, { ...fileFields, restored: true }),
            'CJS macro requireExtensions/cache/default-require lifecycle differs')
          const compile = one(children(loader, 'cjs-compile-loader'), 'actual CJS compile loader'); returned(compile)
          ensure(same(compile.start.data.input, { ...fileFields, filename: temp.tempFile, bundledCode: chunk.code, selected: true }),
            'CJS macro compile loader selected a fallback, URL, foreign file or other output bytes')
          const load = one(loads.filter(item => processKey(item) === processKey(request) && item.file === temp.tempFile
            && same(item.macroContext, compile.context)), 'actual captured Node CJS compilation')
          ensure(!admittedLoads.includes(load) && load.classification === 'unbound' && load.boundary === 'Module.prototype._compile'
            && load.format === 'commonjs' && load.terminalResult === true && load.executionReturned === true
            && load.filename === temp.tempFile && load.receiver === 'Module' && load.argumentCount === 2
            && same({ sha256: load.sha256, bytes: load.bytes }, inputIdentity)
            && same({ sha256: load.sourceArtifact?.sha256, bytes: load.sourceArtifact?.bytes }, inputIdentity)
            && same({ sha256: load.loadedSourceArtifact?.sha256, bytes: load.loadedSourceArtifact?.bytes }, codeIdentity)
            && load.loadedSourceSha256 === codeIdentity.sha256,
            'Actual CJS physical input or captured Node compile argument differs from its producer')
          const resolution = resolves.filter(event => processKey(event) === processKey(load)
            && event.url === pathToFileURL(temp.tempFile).href && event.eventSeq > installed.eventSeq && event.eventSeq < compile.start.eventSeq)
          ensure(resolution.length === 2 && resolution.every(event => event.specifier === temp.tempFile
            && event.parentURL === pathToFileURL(join(checkout, 'packages/rolldown-require/dist/index.mjs')).href)
            && resolution[0].eventSeq < cleared.eventSeq && resolution[1].eventSeq > request.eventSeq,
            'CJS macro lacks the actual absolute-file cache resolution and default require resolution')
          ensure(!resolves.some(event => processKey(event) === processKey(load) && event.parentURL === pathToFileURL(temp.tempFile).href
            && event.eventSeq > compile.start.eventSeq && event.eventSeq < compile.end.eventSeq),
            'Dependency-free CJS macro performed an unobserved external resolution')
          const order = [loader.start.eventSeq, before.eventSeq, installed.eventSeq, resolution[0].eventSeq, cleared.eventSeq,
            request.eventSeq, resolution[1].eventSeq, compile.start.eventSeq, load.eventSeq, compile.end.eventSeq, finished.eventSeq, restored.eventSeq, loader.end.eventSeq]
          ensure(order.every((value, index) => Number.isSafeInteger(value) && (index === 0 || order[index - 1] < value))
            && sourceWrite.eventSeq < bundle.start.eventSeq && bundle.end.eventSeq < loader.start.eventSeq,
            'CJS macro source/native output/require/compile/restore phases are reordered')
          admittedLoads.push(load)
          invocations.push({ runId: load.runId, pid: load.pid, threadId: load.threadId, macroSpanId: macro.context.id, requireSpanId: requireSpan.context.id,
            filename, inputSha256: inputIdentity.sha256, outputFile: temp.tempFile, ...codeIdentity, profile: options.macroProfile })
          continue
        }
        const writer = one(children(loader, 'resolveTempOutputFile'), 'temporary output writer'); returned(writer)
        ensure(writer.start.data.input.sourceFile === temp.tempFile && writer.start.data.input.code === chunk.code && same(writer.start.data.input.options, fixedOptions), 'Temporary writer input differs')
        const before = direct(writer, 'before:fsp.writeFile(target'), after = direct(writer, 'after:fsp.writeFile(target')
        ensure(before.data.target === after.data.target && before.data.code === chunk.code && after.data.code === chunk.code
          && before.data.sourceFile === temp.tempFile && after.data.sourceFile === temp.tempFile, 'Temporary output write lifecycle differs')
        ensure(before.fileObservation?.path === before.data.target && before.fileObservation.absent === true
          && after.fileObservation?.path === after.data.target && after.fileObservation.regular === true
          && same({ sha256: after.fileObservation.sha256, bytes: after.fileObservation.bytes }, codeIdentity), 'Temporary output was reused, not regular, or its physical bytes differ')
        const request = direct(loader, 'req'), finished = direct(loader, 'after:mod = await req(outfile')
        const requestData = request.data, outputFile = after.data.target
        ensure(isAbsolute(outputFile) && requestData.outfile === pathToFileURL(outputFile).href && requestData.defaultRequire === true
          && requestData.format === 'esm' && requestData.fileName === temp.tempFile && requestData.bundledCode === chunk.code && same(requestData.dependencies, expectedDependencies)
          && finished.data.outfile === requestData.outfile, 'Macro import is not the original default ESM import of the written output')
        const matches = loads.filter(load => processKey(load) === processKey(request) && load.file === outputFile && same(load.macroContext, loader.context))
        const load = one(matches, 'actual Node load of this invocation')
        ensure(!admittedLoads.includes(load), 'A Node load was reused across macro invocations')
        ensure(load.format === 'module' && load.eventSeq > request.eventSeq && load.eventSeq < finished.eventSeq && request.eventSeq > after.eventSeq
          && same({ sha256: load.sha256, bytes: load.bytes }, codeIdentity)
          && same({ sha256: load.sourceArtifact?.sha256, bytes: load.sourceArtifact?.bytes }, codeIdentity)
          && same({ sha256: load.loadedSourceArtifact?.sha256, bytes: load.loadedSourceArtifact?.bytes }, codeIdentity)
          && load.loadedSourceSha256 === codeIdentity.sha256, 'Actual Node source bytes/format/causal lifecycle differ from the archived native output')
        const resolutions = resolves.filter(event => processKey(event) === processKey(load) && event.url === requestData.outfile
          && event.parentURL === pathToFileURL(join(checkout, 'packages/rolldown-require/dist/index.mjs')).href
          && event.eventSeq > request.eventSeq && event.eventSeq < load.eventSeq)
        one(resolutions, 'actual default-import resolution')
        const externalResolutions = resolves.filter(event => processKey(event) === processKey(load)
          && event.parentURL === requestData.outfile && event.eventSeq > load.eventSeq && event.eventSeq < finished.eventSeq)
        if (hasRuntime) {
          const builtin = one(externalResolutions, 'actual pinned builtin resolution')
          ensure(Number.isSafeInteger(builtin.eventSeq) && builtin.specifier === 'node:module' && builtin.url === 'node:module',
            'Pinned Rolldown runtime builtin resolution was remapped or detached')
        } else ensure(externalResolutions.length === 0, 'Dependency-free macro has an unobserved external resolution')
        ensure(after.eventSeq < request.eventSeq && direct(macro, 'after:writeFile(tempFile').eventSeq < bundle.start.eventSeq
          && bundle.end.eventSeq < loader.start.eventSeq, 'Macro input/native output/import phases are reordered')
        admittedLoads.push(load)
        invocations.push({ runId: load.runId, pid: load.pid, threadId: load.threadId, macroSpanId: macro.context.id, requireSpanId: requireSpan.context.id,
          filename, inputSha256: digest(generated.evalSource).sha256, outputFile, ...codeIdentity,
          profile: hasRuntime ? MACRO_VALIDATION_PROFILE : 'pinned-json-macro-esm-v1' })
      }
    }
  } catch (error) { errors.push(error.message) }
  return { errors, admittedLoads: errors.length ? [] : admittedLoads, invocations: errors.length ? [] : invocations }
}
