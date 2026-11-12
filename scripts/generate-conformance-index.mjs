#!/usr/bin/env node
/**
 * Generate the versioned map of upstream IDE tests used by the conformance
 * harness. The generated file is intentionally deterministic: a changed
 * submodule commit or source file changes the index hash and must be reviewed.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewedCasesForBaseline } from './conformance-index-policy.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TEST_ROOT = join(ROOT, 'vendor', 'weapp-vite', 'e2e', 'ide')
const OUTPUT = join(ROOT, 'docs', 'conformance', 'case-index-v1.json')
const GOLDEN = join(ROOT, 'docs', 'conformance', 'case-index-v1.sha256')
const TEST_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'])
const BASELINE = JSON.parse(readFileSync(join(ROOT, 'docs/conformance/baseline-v1.json'), 'utf8'))

function walk(directory) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (entry.isFile() && entry.name.includes('.test.') && TEST_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) files.push(path)
  }
  return files
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function submoduleCommit() {
  try {
    return execFileSync('git', ['-C', join(ROOT, 'vendor', 'weapp-vite'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch (error) {
    throw new Error(`vendor/weapp-vite is not initialized: ${error.message || error}`)
  }
}

function caseId(source) {
  const stem = source
    .replace(/\\/g, '/')
    .replace(/\.(?:test)\.(?:ts|tsx|js|jsx|mts|mjs)$/i, '')
    .replace(/\.(?:ts|tsx|js|jsx|mts|mjs)$/i, '')
  return `ide-${stem.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}`
}

function classify(source) {
  const lower = source.toLowerCase()
  let kind = 'static'
  if (lower.includes('optional')) kind = 'optional'
  else if (lower.includes('worker')) kind = 'worker'
  else if (lower.includes('.hmr') || lower.includes('hmr.')) kind = 'hmr'
  else if (lower.includes('.runtime') || lower.includes('runtime.') || lower.includes('lifecycle')) kind = 'runtime'
  else if (lower.includes('acceptance') || lower.includes('devtools')) kind = 'integration'

  const platforms = lower.includes('swan')
    ? ['swan']
    : lower.includes('multi-platform')
      ? ['multi-platform']
      : ['weapp']
  return { kind, platforms }
}

/** Both runtime identity and source bytes must match the reviewed observation. */
function readReviewedCases() {
  if (!existsSync(OUTPUT)) {
    return new Map()
  }
  try {
    const parsed = JSON.parse(readFileSync(OUTPUT, 'utf8'))
    return reviewedCasesForBaseline(parsed, BASELINE)
  } catch {
    return new Map()
  }
}

function buildIndex() {
  if (!existsSync(TEST_ROOT)) throw new Error(`missing test root: ${TEST_ROOT}`)
  const commit = submoduleCommit()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`unexpected submodule commit: ${commit}`)
  if (commit !== BASELINE.compiler.commit) throw new Error('compiler checkout differs from the selected conformance baseline')
  const reviewedCases = readReviewedCases()
  const files = walk(TEST_ROOT)
  const cases = files.map((absolutePath) => {
    const source = relative(join(ROOT, 'vendor', 'weapp-vite'), absolutePath).replace(/\\/g, '/')
    const { kind, platforms } = classify(source)
    const id = caseId(source.replace(/^e2e\/ide\//, ''))
    const sourceSha256 = sha256(readFileSync(absolutePath))
    const reviewed = reviewedCases.get(id)
    const metadata = reviewed?.sourceSha256 === sourceSha256
      ? { status: reviewed.status, ...(Array.isArray(reviewed.evidence) && reviewed.evidence.length ? { evidence: reviewed.evidence } : {}) }
      : { status: 'unknown' }
    return {
      id,
      source,
      sourceSha256,
      kind,
      platforms,
      oracles: ['wechat-devtools', 'mpcore'],
      ...metadata,
    }
  }).sort((a, b) => a.id.localeCompare(b.id))

  const ids = new Set()
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`case id collision: ${item.id}`)
    ids.add(item.id)
  }
  return {
    schemaVersion: 1,
    suite: 'weapp-vite-e2e-ide',
    compiler: { name: 'weapp-vite', commit, platform: 'weapp' },
    oracle: {
      devtoolsVersion: BASELINE.devtoolsVersion,
      baseLibraryVersion: BASELINE.baseLibraryVersion,
      primary: 'wechat-devtools',
      auxiliary: ['mpcore', 'weapp-vite-web'],
    },
    generatedFrom: {
      root: 'vendor/weapp-vite/e2e/ide',
      glob: '**/*.test.{ts,tsx,js,jsx,mts,mjs}',
      fileCount: files.length,
    },
    cases,
  }
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function parseArgs(argv) {
  const options = { check: false }
  for (const arg of argv) {
    if (arg === '--check') options.check = true
    else if (arg === '--write') options.check = false
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('Usage: node scripts/generate-conformance-index.mjs [--check|--write]\n')
    return
  }
  const output = canonical(buildIndex())
  const digest = sha256(output)
  if (options.check) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : null
    const expectedDigest = existsSync(GOLDEN) ? readFileSync(GOLDEN, 'utf8').trim().split(/\s+/)[0] : null
    if (current !== output) throw new Error(`case index is stale; run node scripts/generate-conformance-index.mjs --write (expected ${digest})`)
    if (expectedDigest !== digest) throw new Error(`case index golden hash mismatch: ${expectedDigest || 'missing'} != ${digest}`)
    process.stdout.write(`conformance case index: ok (${buildIndex().generatedFrom.fileCount} cases, ${digest})\n`)
    return
  }
  writeFileSync(OUTPUT, output, 'utf8')
  writeFileSync(GOLDEN, `${digest}  case-index-v1.json\n`, 'utf8')
  process.stdout.write(`wrote ${relative(ROOT, OUTPUT)} (${JSON.parse(output).generatedFrom.fileCount} cases)\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error.message || error}\n`)
  process.exitCode = 1
}
