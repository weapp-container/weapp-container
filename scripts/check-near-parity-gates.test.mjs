import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = resolve(root, 'scripts/check-near-parity-gates.mjs')

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function matrixReport(compilerCommit, repository = root, checkedOutCommit = compilerCommit) {
  const command = 'node ../../scripts/build-weapp-vite-platforms.mjs'
  const runner = readFileSync(join(repository, 'scripts/build-weapp-vite-platforms.mjs'))
  return {
    schemaVersion: 1,
    mode: 'run',
    command,
    commandScope: 'aggregate',
    root: repository,
    runner: {
      path: 'scripts/build-weapp-vite-platforms.mjs',
      sha256: createHash('sha256').update(runner).digest('hex'),
    },
    submodule: {
      path: 'vendor/weapp-vite',
      initialized: true,
      pinnedCommit: compilerCommit,
      checkedOutCommit,
      matches: true,
    },
    targets: ['weapp', 'alipay', 'swan', 'tt', 'jd', 'xhs'].map(id => ({ id, status: 'passed' })),
    runs: [{
      index: 1,
      total: 1,
      target: 'matrix',
      command,
      cwd: join(repository, 'vendor/weapp-vite'),
      startedAt: '2026-11-20T00:00:00.000Z',
      durationMs: 1,
      status: 'passed',
      exitCode: 0,
      signal: null,
    }],
  }
}

function git(repository, ...args) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
}

function createTestRepository(repository, { withCompiler = true, configured = true, advanceCompiler = false, dirtyCompiler = false } = {}) {
  mkdirSync(repository, { recursive: true })
  mkdirSync(join(repository, 'scripts'), { recursive: true })
  mkdirSync(join(repository, 'schemas'), { recursive: true })
  for (const file of [
    'build-weapp-vite-platforms.mjs',
    'check-near-parity-gates.mjs',
    'evidence-source.mjs',
    'mobile-module-evidence.mjs',
    'pack-execution-evidence.mjs',
    'modern-view-pack-resources.mjs',
  ]) {
    copyFileSync(join(root, 'scripts', file), join(repository, 'scripts', file))
  }
  for (const file of ['container-manifest-v1.schema.json', 'container-manifest-v2.schema.json', 'container-manifest-v3.schema.json']) {
    copyFileSync(join(root, 'schemas', file), join(repository, 'schemas', file))
  }

  git(repository, 'init', '--quiet')
  git(repository, 'config', 'user.name', 'Near parity test')
  git(repository, 'config', 'user.email', 'near-parity-test@example.invalid')

  let pinnedCommit = null
  let checkedOutCommit = null
  if (withCompiler) {
    const compiler = join(repository, 'vendor', 'weapp-vite')
    mkdirSync(compiler, { recursive: true })
    git(compiler, 'init', '--quiet')
    git(compiler, 'config', 'user.name', 'Near parity test')
    git(compiler, 'config', 'user.email', 'near-parity-test@example.invalid')
    mkdirSync(join(compiler, 'e2e', 'ide', 'feature'), { recursive: true })
    writeFileSync(join(compiler, 'README.md'), 'pinned test compiler\n')
    writeFileSync(join(compiler, 'e2e', 'ide', 'app.test.ts'), 'export const appCase = true\n')
    writeFileSync(join(compiler, 'e2e', 'ide', 'feature', 'route.runtime.test.mjs'), 'export const routeCase = true\n')
    git(compiler, 'add', 'README.md', 'e2e/ide')
    git(compiler, 'commit', '--quiet', '-m', 'initial compiler')
    pinnedCommit = git(compiler, 'rev-parse', 'HEAD')
    if (advanceCompiler) {
      writeFileSync(join(compiler, 'README.md'), 'updated test compiler\n')
      git(compiler, 'add', 'README.md')
      git(compiler, 'commit', '--quiet', '-m', 'advance compiler')
    }
    checkedOutCommit = git(compiler, 'rev-parse', 'HEAD')
    if (dirtyCompiler) writeFileSync(join(compiler, 'working-tree.txt'), 'dirty\n')
    if (configured) {
      writeFileSync(join(repository, '.gitmodules'), [
        '[submodule "weapp-vite"]',
        '\tpath = vendor/weapp-vite',
        '\turl = https://example.invalid/weapp-vite.git',
        '',
      ].join('\n'))
    }
  }

  git(repository, 'add', 'scripts', 'schemas')
  if (configured) git(repository, 'add', '.gitmodules')
  if (withCompiler) git(repository, 'update-index', '--add', '--cacheinfo', `160000,${pinnedCommit},vendor/weapp-vite`)
  git(repository, 'commit', '--quiet', '-m', 'test source revision')
  return { pinnedCommit, checkedOutCommit }
}

function conformanceIndex(compilerRoot) {
  const sources = ['e2e/ide/app.test.ts', 'e2e/ide/feature/route.runtime.test.mjs']
  return {
    suite: 'weapp-vite-e2e-ide',
    compiler: {
      name: 'weapp-vite',
      commit: git(compilerRoot, 'rev-parse', 'HEAD'),
      platform: 'weapp',
    },
    oracle: {
      devtoolsVersion: '2.02.2609250',
      baseLibraryVersion: '3.17.3',
      primary: 'wechat-devtools',
      auxiliary: ['mpcore', 'weapp-vite-web'],
    },
    generatedFrom: {
      root: 'vendor/weapp-vite/e2e/ide',
      glob: '**/*.test.{ts,tsx,js,jsx,mts,mjs}',
      fileCount: sources.length,
    },
    cases: sources.map(source => ({
      id: source.replaceAll(/[^a-zA-Z0-9]+/g, '-').replace(/-$/, ''),
      source,
      sourceSha256: createHash('sha256').update(readFileSync(join(compilerRoot, source))).digest('hex'),
      kind: 'runtime',
      platforms: ['weapp'],
      oracles: ['wechat-devtools', 'mpcore'],
      status: 'passed',
    })),
  }
}

function runInPinnedRepository({
  withCompiler = true,
  configured = true,
  advanceCompiler = false,
  dirtyCompiler = false,
  expectedCompilerCommit,
  reportedCommit,
  withoutRun = false,
  includeConformanceIndex = false,
  mutateConformanceIndex,
  mutateMatrixReport,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'weapp-near-parity-fixture-'))
  try {
    const repository = join(directory, 'repo')
    const checkout = createTestRepository(repository, { withCompiler, configured, advanceCompiler, dirtyCompiler })
    const reportCommit = reportedCommit || checkout.pinnedCommit || 'a'.repeat(40)
    const report = matrixReport(reportCommit, repository, checkout.pinnedCommit)
    if (mutateMatrixReport) mutateMatrixReport(report)
    if (withoutRun) report.runs = []
    const matrixPath = join(directory, 'matrix.json')
    writeFileSync(matrixPath, JSON.stringify(report))
    const args = ['--matrix', matrixPath]
    if (includeConformanceIndex) {
      const indexPath = join(directory, 'case-index.json')
      const index = conformanceIndex(join(repository, 'vendor/weapp-vite'))
      writeFileSync(indexPath, JSON.stringify(mutateConformanceIndex ? mutateConformanceIndex(index) : index))
      args.push('--index', indexPath)
    }
    if (expectedCompilerCommit) args.push('--expected-compiler-commit', expectedCompilerCommit)
    const result = spawnSync(process.execPath, [resolve(repository, 'scripts/check-near-parity-gates.mjs'), ...args], {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const gates = JSON.parse(result.stdout).gates
    return { result, matrix: gates.matrix, conformance: gates.conformance, checkout }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function runWithMatrix(report, expectedCompilerCommit) {
  const directory = mkdtempSync(join(tmpdir(), 'weapp-near-parity-matrix-'))
  try {
    const path = join(directory, 'matrix.json')
    writeFileSync(path, JSON.stringify(report))
    const args = ['--matrix', path]
    if (expectedCompilerCommit) args.push('--expected-compiler-commit', expectedCompilerCommit)
    const result = run(args)
    return { result, matrix: JSON.parse(result.stdout).gates.matrix }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('near-parity CLI documents the compiler trust anchor', () => {
  const result = run(['--help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--expected-compiler-commit sha/)
})

test('near-parity CLI rejects unknown, missing, repeated and malformed arguments', () => {
  for (const args of [
    ['--unknown'],
    ['--out'],
    ['--index', 'one.json', '--index', 'two.json'],
    ['--expected-compiler-commit', 'not-a-commit'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 1, JSON.stringify(args))
    assert.match(result.stderr, /unknown option|requires a value|only be supplied once|40-character lowercase Git SHA/)
  }
})

test('matrix gate does not trust an expected commit without a usable compiler checkout', () => {
  const compilerCommit = 'a'.repeat(40)
  const { result, matrix } = runWithMatrix(matrixReport(compilerCommit), compilerCommit)

  assert.equal(result.status, 1, 'other release gates remain incomplete in this checkout')
  assert.equal(matrix.status, 'incomplete')
  assert.equal(matrix.runEvidenceComplete, true)
  assert.equal(matrix.compilerCheckout.explicitExpectedCommit, compilerCommit)
  assert.match(matrix.reason, /submodule|checkout|gitlink|compiler pin/)
})

test('matrix gate accepts a clean checkout matching the HEAD compiler gitlink', () => {
  const { result, matrix, checkout } = runInPinnedRepository({ expectedCompilerCommit: undefined })

  assert.equal(result.status, 1, 'other release gates remain incomplete in this isolated fixture')
  assert.equal(matrix.status, 'passed', JSON.stringify(matrix))
  assert.equal(matrix.runEvidenceComplete, true)
  assert.equal(matrix.expectedCompilerCommit, checkout.pinnedCommit)
  assert.equal(matrix.compilerCheckout.checkedOutCommit, checkout.pinnedCommit)
})

test('matrix gate rejects a dirty compiler checkout and a checked-out commit drift', () => {
  const dirty = runInPinnedRepository({ dirtyCompiler: true })
  assert.equal(dirty.matrix.status, 'incomplete')
  assert.match(dirty.matrix.reason, /dirty/)

  const drift = runInPinnedRepository({ advanceCompiler: true })
  assert.equal(drift.matrix.status, 'incomplete')
  assert.match(drift.matrix.reason, /does not match the HEAD gitlink/)
})

test('matrix gate binds the report to the current tracked build runner', () => {
  const { matrix } = runInPinnedRepository({
    mutateMatrixReport: report => {
      report.runner.sha256 = 'f'.repeat(64)
    },
  })

  assert.equal(matrix.status, 'incomplete')
  assert.equal(matrix.runner.matches, false)
  assert.match(matrix.reason, /runner provenance/)
})

test('matrix gate requires committed submodule registration and treats an explicit SHA as an assertion', () => {
  const unregistered = runInPinnedRepository({ configured: false })
  assert.equal(unregistered.matrix.status, 'incomplete')
  assert.match(unregistered.matrix.reason, /not registered in \.gitmodules/)

  const mismatch = runInPinnedRepository({ expectedCompilerCommit: 'f'.repeat(40) })
  assert.equal(mismatch.matrix.status, 'incomplete')
  assert.match(mismatch.matrix.reason, /explicit expected compiler commit does not match/)
})

test('conformance gate binds passing cases to the full source set and pinned oracle', () => {
  const complete = runInPinnedRepository({ includeConformanceIndex: true })
  assert.equal(complete.conformance.status, 'passed')
  assert.equal(complete.conformance.expectedSources, 2)
  assert.equal(complete.conformance.sourceHashMismatches.length, 0)

  const omitted = runInPinnedRepository({
    includeConformanceIndex: true,
    mutateConformanceIndex: index => ({
      ...index,
      generatedFrom: { ...index.generatedFrom, fileCount: 1 },
      cases: index.cases.slice(0, 1),
    }),
  })
  assert.equal(omitted.conformance.status, 'incomplete')
  assert.match(omitted.conformance.reason, /complete current compiler case set/)
})

test('matrix gate rejects stale compiler provenance even when every target reports passed', () => {
  const expectedCompilerCommit = 'a'.repeat(40)
  const staleCompilerCommit = 'b'.repeat(40)
  const { matrix } = runWithMatrix(matrixReport(staleCompilerCommit), expectedCompilerCommit)

  assert.equal(matrix.status, 'incomplete')
  assert.equal(matrix.expectedCompilerCommit, null)
  assert.match(matrix.reason, /compiler pin is unavailable/)
})

test('matrix gate rejects passing summaries without a current compiler pin or successful run receipt', () => {
  const unpinned = runWithMatrix(matrixReport('c'.repeat(40)))
  assert.equal(unpinned.matrix.status, 'incomplete')
  assert.match(unpinned.matrix.reason, /compiler pin is unavailable/)

  const expectedCompilerCommit = 'd'.repeat(40)
  const summaryOnly = matrixReport(expectedCompilerCommit)
  summaryOnly.runs = []
  const missingRun = runWithMatrix(summaryOnly, expectedCompilerCommit)
  assert.equal(missingRun.matrix.status, 'incomplete')
  assert.match(missingRun.matrix.reason, /compiler pin is unavailable|no complete successful build run evidence/)
})
