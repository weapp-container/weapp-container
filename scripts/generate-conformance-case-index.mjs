#!/usr/bin/env node
/**
 * Generate the tracked conformance case inventory from the pinned compiler.
 * Runtime status is deliberately unknown until an official oracle receipt is
 * reviewed and recorded for the exact source and baseline.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const COMPILER_ROOT = resolve(ROOT, 'vendor/weapp-vite')
const CASE_ROOT = resolve(COMPILER_ROOT, 'e2e/ide')
const OUTPUT = resolve(ROOT, 'docs/conformance/case-index-v1.json')
const OUTPUT_SHA = resolve(ROOT, 'docs/conformance/case-index-v1.sha256')
const SOURCE_PATTERN = /\.test\.(?:ts|tsx|js|jsx|mts|mjs)$/
const GLOB = '**/*.test.{ts,tsx,js,jsx,mts,mjs}'

function sourceFiles(directory, prefix = '') {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`compiler case source is a symbolic link: ${relativePath}`)
    if (entry.isDirectory()) files.push(...sourceFiles(path, relativePath))
    else if (entry.isFile() && SOURCE_PATTERN.test(entry.name)) files.push(`e2e/ide/${relativePath}`)
  }
  return files.sort()
}

function caseKind(source) {
  const name = source.toLowerCase()
  if (name.includes('.optional.')) return 'optional'
  if (name.includes('.hmr.')) return 'hmr'
  if (name.includes('worker')) return 'worker'
  if (name.includes('agent-') || name.includes('automator-') || name.includes('devtools-')
    || name.includes('github-issues') || name.includes('lifecycle-compare')
    || name.includes('platform-host') || name.includes('plugin-demo')) return 'integration'
  return 'runtime'
}

function casePlatforms(source) {
  const name = source.toLowerCase()
  if (name.includes('.swan.')) return ['swan']
  if (name.includes('multi-platform')) return ['multi-platform']
  return ['weapp']
}

function caseId(source) {
  return `ide-${source.slice('e2e/ide/'.length).replaceAll(/[^a-zA-Z0-9]+/g, '-').replace(/-$/, '').toLowerCase()}`
}

function compilerCommit() {
  return execFileSync('git', ['-C', COMPILER_ROOT, 'rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim()
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function main() {
  if (!existsSync(CASE_ROOT) || !lstatSync(COMPILER_ROOT).isDirectory()) {
    throw new Error('vendor/weapp-vite/e2e/ide is unavailable')
  }
  const commit = compilerCommit()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('compiler checkout does not have a valid Git commit')
  const sources = sourceFiles(CASE_ROOT)
  if (sources.length === 0) throw new Error('no compiler case sources were found')
  const cases = sources.map(source => ({
    id: caseId(source),
    source,
    sourceSha256: sha256(resolve(COMPILER_ROOT, source)),
    kind: caseKind(source),
    platforms: casePlatforms(source),
    oracles: ['wechat-devtools', 'mpcore'],
    status: 'unknown',
  }))
  const index = {
    schemaVersion: 1,
    suite: 'weapp-vite-e2e-ide',
    compiler: { name: 'weapp-vite', commit, platform: 'weapp' },
    oracle: {
      devtoolsVersion: '2.02.2609250',
      baseLibraryVersion: '3.17.3',
      primary: 'wechat-devtools',
      auxiliary: ['mpcore', 'weapp-vite-web'],
    },
    generatedFrom: { root: 'vendor/weapp-vite/e2e/ide', glob: GLOB, fileCount: cases.length },
    cases,
  }
  const output = `${JSON.stringify(index, null, 2)}\n`
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, output, 'utf8')
  writeFileSync(OUTPUT_SHA, `${sha256(OUTPUT)}  ${relative(dirname(OUTPUT_SHA), OUTPUT)}\n`, 'utf8')
  process.stdout.write(`generated ${relative(ROOT, OUTPUT)} with ${cases.length} cases\n`)
}

main()
