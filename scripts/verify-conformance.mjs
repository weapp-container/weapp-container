#!/usr/bin/env node
/** Validate the case index, normalized traces and optional conformance report. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspectConformanceEvidence, schemaErrors } from './conformance-evidence.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const INDEX = join(ROOT, 'docs', 'conformance', 'case-index-v1.json')
const GOLDEN = join(ROOT, 'docs', 'conformance', 'case-index-v1.sha256')
const CASE_ID = /^ide-[a-z0-9][a-z0-9-]*$/
const STATUS = new Set(['passed', 'failed', 'blocked', 'unknown'])
const TRACE_SCHEMA = readJson(join(ROOT, 'schemas/conformance-trace-v1.schema.json'))
const REPORT_SCHEMA = readJson(join(ROOT, 'schemas/conformance-report-v1.schema.json'))

function fail(message) { throw new Error(message) }
function readJson(path) {
  if (!existsSync(path)) fail(`missing ${path}`)
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) { fail(`invalid JSON ${path}: ${error.message}`) }
}
function digest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }

function validateIndex(index) {
  if (index.schemaVersion !== 1 || index.suite !== 'weapp-vite-e2e-ide') fail('invalid conformance index header')
  if (!index.compiler || !/^[0-9a-f]{40}$/.test(index.compiler.commit)) fail('index compiler.commit must be a full SHA')
  if (index.oracle?.primary !== 'wechat-devtools') fail('index oracle must use WeChat DevTools as primary')
  if (!index.generatedFrom || index.generatedFrom.fileCount !== index.cases?.length) fail('index fileCount does not match cases')
  if (!Array.isArray(index.cases) || index.cases.length === 0) fail('index cases must be non-empty')
  const ids = new Set()
  for (const item of index.cases) {
    if (!CASE_ID.test(item.id)) fail(`invalid case id: ${item.id}`)
    if (ids.has(item.id)) fail(`duplicate case id: ${item.id}`)
    ids.add(item.id)
    if (!item.source || !/^[^/].+\.(ts|tsx|js|jsx|mts|mjs)$/.test(item.source)) fail(`invalid source for ${item.id}`)
    if (!/^[0-9a-f]{64}$/.test(item.sourceSha256)) fail(`invalid source hash for ${item.id}`)
    if (!STATUS.has(item.status)) fail(`invalid status for ${item.id}: ${item.status}`)
    if (!Array.isArray(item.oracles) || !item.oracles.includes('wechat-devtools')) fail(`missing DevTools oracle for ${item.id}`)
    // A reviewed status must point at committed, reviewable evidence.  Without
    // this check a hand-edited case index could promote a case to passed (or
    // hide a failure) while leaving no authoritative artifact to inspect.
    if (item.status !== 'unknown' && (!Array.isArray(item.evidence) || item.evidence.length === 0)) {
      fail(`${item.id} has status ${item.status} but no evidence[]`)
    }
    if (item.evidence !== undefined) {
      if (!Array.isArray(item.evidence) || item.evidence.some((path) => typeof path !== 'string' || !path || isAbsolute(path) || path.replaceAll('\\', '/').split('/').includes('..'))) {
        fail(`${item.id} has invalid evidence path(s)`)
      }
      for (const evidencePath of item.evidence) {
        const absoluteEvidence = resolve(ROOT, evidencePath)
        const relativeEvidence = relative(ROOT, absoluteEvidence)
        if (!relativeEvidence || relativeEvidence === '..' || relativeEvidence.startsWith(`..${sep}`) || isAbsolute(relativeEvidence) || !existsSync(absoluteEvidence)) {
          fail(`${item.id} references missing evidence: ${evidencePath}`)
        }
      }
    }
  }
  return ids
}

export function validateTrace(trace, ids) {
  const errors = schemaErrors(trace, TRACE_SCHEMA)
  if (errors.length) fail(`trace schema: ${errors.slice(0, 8).join('; ')}`)
  if (!ids.has(trace.caseId)) fail(`trace references unknown case: ${trace.caseId}`)
  let previous = -1
  for (const event of trace.events) {
    if (event.seq <= previous) fail(`trace ${trace.caseId} event sequence is not strictly increasing`)
    previous = event.seq
  }
  const assertions = trace.assertions || []
  if (new Set(assertions.map(item => item.id)).size !== assertions.length) fail(`trace ${trace.caseId} has duplicate assertion IDs`)
  if (trace.run.status === 'passed' && assertions.some(item => !item.passed)) fail(`trace ${trace.caseId} passed with a failed assertion`)
  if (trace.run.startedAt && trace.run.endedAt && Date.parse(trace.run.endedAt) < Date.parse(trace.run.startedAt)) fail(`trace ${trace.caseId} timestamps are reversed`)
  return trace
}

function tracePath(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.includes('\0')
      || path.split('/').some(part => !part || part === '.' || part === '..')) fail(`unsafe report trace path: ${path}`)
  let current = root
  const parts = path.split('/')
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index])
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) fail(`report trace is not a regular file: ${path}`)
  }
  return current
}

export function validateReport(report, ids, root = ROOT) {
  const errors = schemaErrors(report, REPORT_SCHEMA)
  if (errors.length) fail(`report schema: ${errors.slice(0, 8).join('; ')}`)
  const counts = { passed: 0, failed: 0, blocked: 0, unknown: 0 }
  const identities = new Set()
  for (const run of report.runs) {
    if (!ids.has(run.caseId)) fail(`report references unknown case: ${run.caseId}`)
    // Validate referenced bytes too; a count/status-only report cannot pass by
    // pointing at a missing trace or another case/provider's observations.
    const trace = validateTrace(readJson(tracePath(root, run.trace)), ids)
    if (trace.caseId !== run.caseId || trace.run.status !== run.status) fail(`report and trace case/status differ: ${run.caseId}`)
    const identity = JSON.stringify([run.caseId, trace.oracle, trace.run.host, trace.run.engine])
    if (identities.has(identity)) fail(`duplicate report case/provider/host/engine: ${run.caseId}`)
    identities.add(identity)
    counts[run.status] += 1
  }
  const summary = report.summary
  if (!summary || summary.total !== report.runs.length || ['passed', 'failed', 'blocked', 'unknown'].some((key) => summary[key] !== counts[key])) fail('report summary does not match runs')
}

function parseArgs(argv) {
  const options = { report: null, traces: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    else if (arg === '--report' || arg === '--trace') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) fail(`${arg} requires a path`)
      if (arg === '--report') options.report = resolve(ROOT, value)
      else options.traces.push(resolve(ROOT, value))
    }
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('Usage: node scripts/verify-conformance.mjs [--report path] [--trace path ...]\n')
    return
  }
  const index = readJson(INDEX)
  const ids = validateIndex(index)
  const actualIndexHash = digest(INDEX)
  const expectedIndexHash = readFileSync(GOLDEN, 'utf8').trim().split(/\s+/)[0]
  if (actualIndexHash !== expectedIndexHash) fail(`case index golden mismatch: ${actualIndexHash} != ${expectedIndexHash}`)
  const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const report = options.report ? readJson(options.report) : null
  const differential = report?.kind === 'weapp-container-differential'
  const audit = inspectConformanceEvidence({ path: INDEX, value: index },
    differential ? { path: options.report, value: report } : null, { root: ROOT, expectedCommit })
  if (audit.sourceValidation.status !== 'passed') fail(`pinned source validation: ${audit.sourceValidation.errors.join('; ')}`)
  for (const path of options.traces) validateTrace(readJson(path), ids)
  if (options.report) {
    if (report.indexSha256 !== actualIndexHash) fail('report indexSha256 does not match case index')
    if (differential) {
      if (audit.status !== 'passed') {
        const errors = [...audit.sourceValidation.errors, ...audit.differential.errors,
          ...audit.differential.cases.filter(item => item.status !== 'passed').slice(0, 5)
            .map(item => `${item.caseId}: ${item.errors.join('; ') || `${item.missingPairs.length} missing/invalid host-engine pairs`}`)]
        fail(`differential incomplete: ${errors.join('\n')}`)
      }
    } else validateReport(report, ids)
  }
  process.stdout.write(`conformance index: ok (${index.cases.length} cases, ${actualIndexHash})\n`)
  if (options.traces.length) process.stdout.write(`traces: ok (${options.traces.length})\n`)
  if (options.report) process.stdout.write(`report: ok (${options.report})\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) {
    process.stderr.write(`${error.message || error}\n`)
    process.exitCode = 1
  }
}
