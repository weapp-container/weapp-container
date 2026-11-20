import { spawnSync } from 'node:child_process'
import { readFile, mkdir, writeFile, access } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = resolve(ROOT, 'dependency-audit.config.json')
const DEFAULT_REPORT = resolve(ROOT, 'artifacts/dependency-audit/report.json')
const UPDATE_KINDS = new Set(['patch', 'minor'])
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  scopes: [],
  reportOnly: [],
  exclusions: [],
  protected: [],
}

function normalize(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')
}

function relativePath(path) {
  return normalize(relative(ROOT, path)) || '.'
}

function globToRegExp(glob) {
  const source = normalize(glob).split('').map((char, index, chars) => {
    if (char === '*' && chars[index + 1] === '*') return index === 0 || chars[index - 1] === '/' ? '(?:.*\/)?' : '.*'
    if (char === '*') return '[^/]*'
    if (char === '?') return '[^/]'
    return /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char
  }).join('').replaceAll('(?:.*\/)?[^/]*\/', '(?:.*\/)?')
  return new RegExp(`^${source}$`)
}

export function matchesPattern(path, pattern) {
  return globToRegExp(normalize(path)).test(normalize(pattern)) || globToRegExp(normalize(pattern)).test(normalize(path))
}

export function isExcluded(path, exclusions = []) {
  const value = normalize(path)
  return exclusions.some(pattern => matchesPattern(value, pattern))
}

export function parseArgs(argv = []) {
  const options = { mode: 'check', strict: false, apply: false, json: DEFAULT_REPORT, scope: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--strict') options.strict = true
    else if (arg === '--apply') options.apply = true
    else if (arg === '--mode') options.mode = argv[++index]
    else if (arg === '--json') options.json = resolve(ROOT, argv[++index])
    else if (arg === '--scope') options.scope = argv[++index]
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!['check', 'upgrade'].includes(options.mode)) throw new Error(`Unsupported mode: ${options.mode}`)
  if (options.apply && options.mode !== 'upgrade') throw new Error('--apply is only valid with --mode upgrade')
  options.scopes = options.scope ? options.scope.split(',').map(value => value.trim()).filter(Boolean) : null
  return options
}

function parseVersion(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2] || 0), patch: Number(match[3] || 0), pre: match[4] || '' }
}

export function compareVersions(left, right) {
  const a = parseVersion(left); const b = parseVersion(right)
  if (!a || !b) return null
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  if (a.pre === b.pre) return 0
  if (!a.pre) return 1
  if (!b.pre) return -1
  return a.pre > b.pre ? 1 : -1
}

export function updateKind(current, target) {
  const a = parseVersion(current); const b = parseVersion(target)
  if (!a || !b) return 'unknown'
  if (a.major !== b.major) return 'major'
  if (a.minor !== b.minor) return 'minor'
  if (a.patch !== b.patch || a.pre !== b.pre) return 'patch'
  return 'current'
}

export function satisfiesRange(version, range) {
  const target = parseVersion(version)
  if (!target || !range || typeof range !== 'string') return false
  const value = range.trim().replace(/^workspace:/, '')
  if (value === '*' || value === 'latest') return true
  if (value.startsWith('file:') || value.startsWith('workspace:') || value.startsWith('git')) return false
  const exact = value.match(/^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/)
  if (exact) {
    if (exact[1] !== String(target.major)) return false
    if (!exact[2] || /x|\*/i.test(exact[2])) return true
    if (Number(exact[2]) !== target.minor) return false
    return !exact[3] || /x|\*/i.test(exact[3]) || Number(exact[3]) === target.patch
  }
  const op = value.match(/^([~^])\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (op) {
    const base = { major: Number(op[2]), minor: Number(op[3] || 0), patch: Number(op[4] || 0) }
    if (target.major !== base.major || compareVersions(version, `${base.major}.${base.minor}.${base.patch}`) < 0) return false
    if (op[1] === '~') return target.minor === base.minor
    return base.major === 0 ? target.minor === base.minor : true
  }
  const comparator = value.match(/^(>=|>|<=|<)\s*v?(\d+(?:\.\d+){0,2})$/)
  if (comparator) {
    const result = compareVersions(version, comparator[2]); if (result === null) return false
    return { '>': result > 0, '>=': result >= 0, '<': result < 0, '<=': result <= 0 }[comparator[1]]
  }
  return false
}

export function classifyUpdate(current, target, range = null, protectedPin = false) {
  const kind = updateKind(current, target)
  const newer = compareVersions(target, current) === 1
  const compatible = newer && (!range || satisfiesRange(target, range))
  return { kind, newer, compatible, eligible: !protectedPin && compatible && UPDATE_KINDS.has(kind) }
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

async function loadConfig(configPath = CONFIG_PATH) {
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  return { ...DEFAULT_CONFIG, ...config }
}

export async function discoverProjects({ root = ROOT, config = DEFAULT_CONFIG } = {}) {
  const projects = []
  const add = async (entry, reportOnly = false) => {
    const path = resolve(root, entry.path)
    const manifestNames = { pnpm: ['package.json'], npm: ['package.json'], cargo: ['Cargo.toml'], flutter: ['pubspec.yaml'], gradle: ['build.gradle', 'build.gradle.kts', 'app/build.gradle', 'app/build.gradle.kts'], cocoapods: ['Podfile'], swiftpm: ['Package.swift'], bundler: ['Gemfile'] }
    const candidates = (manifestNames[entry.kind] || ['']).map(name => resolve(path, name))
    let resolvedManifest = candidates[0] || resolve(path, '')
    for (const candidate of candidates) if (await exists(candidate)) { resolvedManifest = candidate; break }
    const present = await exists(resolvedManifest)
    projects.push({ ...entry, reportOnly, path, relativePath: relative(root, path) || '.', manifest: resolvedManifest, manifestPresent: present })
  }
  for (const scope of config.scopes || []) await add(scope)
  for (const scope of config.reportOnly || []) await add(scope, true)
  return projects.filter(project => !isExcluded(project.relativePath, config.exclusions || []))
}

function runCommand(command, args, cwd, { timeout = 120_000 } = {}) {
  try {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: process.env.CI || '1' } })
    return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message || null }
  } catch (error) { return { status: 1, stdout: '', stderr: '', error: error.message } }
}

function parseJsonOutput(output) {
  const text = String(output || '').trim()
  if (!text) return null
  try { return JSON.parse(text) } catch {}
  const start = Math.min(...['{', '['].map(token => { const index = text.indexOf(token); return index < 0 ? Number.POSITIVE_INFINITY : index }))
  if (!Number.isFinite(start)) return null
  try { return JSON.parse(text.slice(start)) } catch { return null }
}

async function readPackageManifest(project) {
  try { return JSON.parse(await readFile(project.manifest, 'utf8')) } catch { return null }
}

function packageRanges(manifest = {}) {
  const ranges = new Map()
  for (const section of DEPENDENCY_SECTIONS) for (const [name, range] of Object.entries(manifest[section] || {})) ranges.set(name, { range, section })
  return ranges
}

function dependencyRecord({ name, current, wanted, latest, range, section, manager, project, deprecated = false, advisory = false }) {
  const target = wanted && compareVersions(wanted, current) === 1 ? wanted : latest
  const classification = classifyUpdate(current, target, range, project.protected)
  const record = { name, current, wanted: wanted || null, latest: latest || null, range: range || null, section: section || 'transitive', manager, kind: classification.kind, compatible: classification.compatible, eligible: classification.eligible, project: project.name, path: project.relativePath }
  if (deprecated) record.issue = { severity: 'error', code: 'deprecated', message: `${name}@${current} is deprecated.` }
  if (advisory) record.issue = { severity: 'error', code: 'security', message: `${name}@${current} is affected by a security advisory.` }
  return record
}

function parsePnpmOutdated(data, ranges, project) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  return Object.entries(data).map(([name, item]) => dependencyRecord({ name, current: item.current, wanted: item.wanted, latest: item.latest, range: ranges.get(name)?.range, section: item.dependencyType || ranges.get(name)?.section, manager: 'pnpm', project, deprecated: item.isDeprecated, advisory: item.isCurrentAffectedByAdvisory }))
}

function parseNpmOutdated(data, ranges, project) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  return Object.entries(data).map(([name, item]) => dependencyRecord({ name, current: item.current, wanted: item.wanted, latest: item.latest, range: ranges.get(name)?.range, section: ranges.get(name)?.section, manager: 'npm', project }))
}

function parseFlutterOutdated(data, project) {
  if (!data || !Array.isArray(data.packages)) return []
  return data.packages.filter(item => item.current?.version && item.latest?.version && compareVersions(item.latest.version, item.current.version) === 1).map(item => dependencyRecord({ name: item.package, current: item.current.version, wanted: item.resolvable?.version || item.upgradable?.version, latest: item.latest.version, manager: 'flutter', project, deprecated: item.isDiscontinued, advisory: item.isCurrentAffectedByAdvisory }))
}

function cargoUpdates(output, project) {
  const records = []
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.includes('Updating ') || !line.includes('->')) continue
    const sides = line.split('->'); const currentMatch = sides[0].match(/(\d+(?:\.\d+){1,2})\s*$/); const targetMatch = sides[1].match(/(\d+(?:\.\d+){1,2})/)
    if (!currentMatch || !targetMatch) continue
    const current = currentMatch[1]; const target = targetMatch[1]; const kind = updateKind(current, target)
    records.push({ name: 'cargo dependency', current, wanted: target, latest: target, range: null, section: 'transitive', manager: 'cargo', kind, compatible: true, eligible: UPDATE_KINDS.has(kind), project: project.name, path: project.relativePath })
  }
  return records
}

function makeIssue(severity, code, message, project) { return { severity, code, message, project: project.name, path: project.relativePath } }

async function auditPnpm(project, options, ranges, run) {
  const args = ['outdated', '--format', 'json', '--silent']; if (project.recursive) args.push('--recursive')
  const outdated = run('pnpm', args, project.path)
  const data = parseJsonOutput(outdated.stdout)
  const issues = []; const dependencies = parsePnpmOutdated(data, ranges, project)
  if (outdated.error || (outdated.status !== 0 && !data && outdated.stderr.trim())) issues.push(makeIssue('error', 'scanner-failure', outdated.error || outdated.stderr.trim(), project))
  const lockCheck = run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--offline'], project.path)
  if (lockCheck.status !== 0 && !/Unsupported platform|already up to date/i.test(lockCheck.stderr + lockCheck.stdout)) issues.push(makeIssue('error', 'lockfile-drift', 'pnpm frozen install could not validate the lockfile.', project))
  // The release gate covers packages that ship to consumers. Development
  // tooling is reported by the package manager but cannot block a runtime
  // release when it is not present in the published dependency graph.
  const security = run('pnpm', ['audit', '--prod', '--json'], project.path)
  const auditData = parseJsonOutput(security.stdout)
  const advisories = auditData?.advisories ? Object.keys(auditData.advisories).length : auditData?.metadata?.vulnerabilities ? Object.values(auditData.metadata.vulnerabilities).reduce((sum, value) => sum + Number(value || 0), 0) : 0
  if (advisories) issues.push(makeIssue('error', 'security', `${advisories} pnpm security advisories reported.`, project))
  else if (security.error || (security.status !== 0 && !auditData)) issues.push(makeIssue('error', 'security-scan-failure', security.error || security.stderr.trim() || 'pnpm audit failed.', project))
  return { dependencies, issues, lockfile: { status: lockCheck.status === 0 ? 'passed' : 'failed' }, security: { status: advisories ? 'failed' : security.status === 0 ? 'passed' : 'unknown', advisories } }
}

async function auditNpm(project, options, ranges, run) {
  const outdated = run('npm', ['outdated', '--json', '--no-audit', '--no-fund'], project.path)
  const data = parseJsonOutput(outdated.stdout)
  const issues = []; const dependencies = parseNpmOutdated(data, ranges, project)
  if (outdated.error || (outdated.status !== 0 && !data && outdated.stderr.trim())) issues.push(makeIssue('error', 'scanner-failure', outdated.error || outdated.stderr.trim(), project))
  const hasLockfile = await exists(resolve(project.path, 'package-lock.json'))
  const lockNotApplicable = !hasLockfile && project.lockfilePolicy === 'optional'
  const lockCheck = lockNotApplicable
    ? { status: 0, stdout: '', stderr: '', error: null }
    : run('npm', ['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'], project.path)
  if (lockCheck.status !== 0 && !/Unsupported platform|up to date/i.test(lockCheck.stderr + lockCheck.stdout)) issues.push(makeIssue('error', 'lockfile-drift', 'npm ci dry-run could not validate the lockfile.', project))
  const security = lockNotApplicable
    ? { status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: {} } }), stderr: '', error: null }
    : run('npm', ['audit', '--omit=dev', '--json', '--no-fund'], project.path)
  const auditData = parseJsonOutput(security.stdout)
  const advisories = auditData?.metadata?.vulnerabilities ? Object.values(auditData.metadata.vulnerabilities).reduce((sum, value) => sum + Number(value || 0), 0) : Object.keys(auditData?.vulnerabilities || {}).length
  if (advisories) issues.push(makeIssue('error', 'security', `${advisories} npm security advisories reported.`, project))
  else if (security.error || (security.status !== 0 && !auditData)) issues.push(makeIssue('error', 'security-scan-failure', security.error || security.stderr.trim() || 'npm audit failed.', project))
  return { dependencies, issues, lockfile: { status: lockNotApplicable ? 'not-applicable' : lockCheck.status === 0 ? 'passed' : 'failed' }, security: { status: lockNotApplicable ? 'not-applicable' : advisories ? 'failed' : security.status === 0 ? 'passed' : 'unknown', advisories } }
}

async function auditFlutter(project, options, run) {
  const outdated = run('flutter', ['pub', 'outdated', '--json'], project.path)
  const data = parseJsonOutput(outdated.stdout)
  const dependencies = parseFlutterOutdated(data, project); const issues = []
  if (outdated.error || (outdated.status !== 0 && !data && outdated.stderr.trim())) issues.push(makeIssue('error', 'scanner-failure', outdated.error || outdated.stderr.trim(), project))
  const lockCheck = run('flutter', ['pub', 'get', '--dry-run', '--enforce-lockfile', '--offline'], project.path)
  const lockText = lockCheck.stdout + lockCheck.stderr
  const changedLines = lockText.split(/\r?\n/).filter(line => /^\s*\*\s+/.test(line))
  const pathOnly = /Would change \d+ dependencies/i.test(lockText) && changedLines.length > 0 && changedLines.every(line => /\bfrom path\b/i.test(line))
  const lockStatus = lockCheck.status === 0 || pathOnly ? 'passed' : project.lockfilePolicy === 'optional' && /without an existing[\s\S]*pubspec\.lock/i.test(lockText) ? 'not-applicable' : 'failed'
  if (lockStatus === 'failed') issues.push(makeIssue('error', 'lockfile-drift', 'flutter pub enforce-lockfile could not validate the lockfile.', project))
  return { dependencies, issues, lockfile: { status: lockStatus, pathOnly }, security: { status: 'unsupported', advisories: 0 } }
}

async function auditCargo(project, options, run) {
  const metadata = run('cargo', ['metadata', '--format-version', '1', '--locked', '--no-deps'], project.path)
  const dryRun = run('cargo', ['update', '--dry-run', '--workspace'], project.path)
  const dependencies = cargoUpdates(dryRun.stdout + dryRun.stderr, project); const issues = []
  if (metadata.status !== 0) issues.push(makeIssue('error', 'lockfile-drift', 'cargo metadata --locked failed.', project))
  if (dryRun.error) issues.push(makeIssue('error', 'scanner-failure', dryRun.error, project))
  return { dependencies, issues, lockfile: { status: metadata.status === 0 ? 'passed' : 'failed' }, security: { status: 'unsupported', advisories: 0 } }
}

async function auditReportOnly(project) {
  return { dependencies: [], issues: [], lockfile: { status: 'not-applicable' }, security: { status: 'unsupported', advisories: 0 }, reportOnly: true }
}

async function applyUpdates(project, dependencies, run) {
  const candidates = dependencies.filter(item => item.eligible)
  if (!candidates.length) return { attempted: false, applied: false, candidates: [], reason: 'No compatible patch/minor updates were found.' }
  if (dependencies.some(item => item.issue?.severity === 'error')) return { attempted: false, applied: false, candidates, reason: 'A protected, deprecated, or security update is present; manual review required.' }
  if (project.kind === 'pnpm') {
    const result = run('pnpm', ['update', ...candidates.map(item => item.name), '--ignore-scripts'], project.path)
    return { attempted: true, applied: result.status === 0, candidates, command: ['pnpm', 'update', ...candidates.map(item => item.name)], output: result.stderr || result.stdout }
  }
  if (project.kind === 'npm') {
    const result = run('npm', ['update', '--ignore-scripts', '--no-audit', '--no-fund'], project.path)
    return { attempted: true, applied: result.status === 0, candidates, command: ['npm', 'update'], output: result.stderr || result.stdout }
  }
  if (project.kind === 'flutter') {
    const result = run('flutter', ['pub', 'upgrade'], project.path)
    return { attempted: true, applied: result.status === 0, candidates, command: ['flutter', 'pub', 'upgrade'], output: result.stderr || result.stdout }
  }
  return { attempted: false, applied: false, candidates, reason: `${project.kind} updates remain report-only.` }
}

function protectedPathsChanged(config, root = ROOT, run = runCommand) {
  const base = process.env.GITHUB_BASE_SHA || process.env.DEPENDENCY_AUDIT_BASE_SHA
  const args = base ? ['diff', '--name-only', `${base}...HEAD`, '--'] : ['diff', '--name-only', 'HEAD', '--']
  const current = run('git', args, root)
  const staged = run('git', ['diff', '--name-only', '--cached', '--'], root)
  const files = `${current.stdout}\n${staged.stdout}`.split(/\r?\n/).map(normalize).filter(Boolean)
  const changes = files.flatMap(file => (config.protected || []).filter(pin => matchesPattern(file, pin.path)).map(pin => ({ ...pin, file })))
  return changes.filter((change, index) => changes.findIndex(item => item.file === change.file && item.path === change.path) === index)
}

export async function runAudit({ root = ROOT, config, options = parseArgs([]), commandRunner = runCommand } = {}) {
  const loaded = config || await loadConfig()
  const selected = await discoverProjects({ root, config: loaded })
  const scopes = options.scopes ? selected.filter(project => options.scopes.includes(project.name)) : selected
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), mode: options.mode, strict: options.strict, root: relativePath(root), scopes: [], summary: { projects: 0, dependencies: 0, outdated: 0, eligible: 0, errors: 0, warnings: 0, blocked: 0 }, protectedChanges: protectedPathsChanged(loaded, root, commandRunner) }
  for (const project of scopes) {
    const manifest = project.manifestPresent ? await readPackageManifest(project) : null
    const ranges = packageRanges(manifest || {})
    let result
    if (project.blocked) result = { dependencies: [], issues: [makeIssue('info', 'blocked', project.blocked, project)], lockfile: { status: 'blocked' }, security: { status: 'not-applicable', advisories: 0 }, blocked: true }
    else if (project.reportOnly) result = await auditReportOnly(project)
    else if (!project.manifestPresent) result = { dependencies: [], issues: [makeIssue('error', 'missing-manifest', `Missing ${relativePath(project.manifest)}.`, project)], lockfile: { status: 'unknown' }, security: { status: 'unknown', advisories: 0 } }
    else if (project.kind === 'pnpm') result = await auditPnpm(project, options, ranges, commandRunner)
    else if (project.kind === 'npm') result = await auditNpm(project, options, ranges, commandRunner)
    else if (project.kind === 'flutter') result = await auditFlutter(project, options, commandRunner)
    else if (project.kind === 'cargo') result = await auditCargo(project, options, commandRunner)
    else result = await auditReportOnly(project)
    const projectManifest = project.manifest ? normalize(relative(root, project.manifest)) : ''
    const projectPrefix = project.relativePath === '.' ? '' : `${normalize(project.relativePath)}/`
    const protectedChanges = report.protectedChanges.filter(change => change.file === project.relativePath || change.file === projectManifest || change.file === `${projectPrefix}${basename(project.manifest || '')}`)
    if (protectedChanges.length) result.issues.push(...protectedChanges.map(change => makeIssue('error', 'protected-pin-change', `${change.file}: ${change.reason}`, project)))
    if (options.mode === 'upgrade') result.upgrade = options.apply ? await applyUpdates(project, result.dependencies, commandRunner) : { attempted: false, applied: false, candidates: result.dependencies.filter(item => item.eligible) }
    const status = result.blocked ? 'blocked' : result.issues.some(issue => issue.severity === 'error') ? 'failed' : result.issues.some(issue => issue.severity === 'warning') ? 'unknown' : 'passed'
    report.scopes.push({ name: project.name, kind: project.kind, path: project.relativePath, status, dependencies: result.dependencies, issues: result.issues, lockfile: result.lockfile, security: result.security, upgrade: result.upgrade, reportOnly: Boolean(result.reportOnly) })
    report.summary.projects += 1; report.summary.dependencies += result.dependencies.length; report.summary.outdated += result.dependencies.filter(item => item.kind !== 'current').length; report.summary.eligible += result.dependencies.filter(item => item.eligible).length; report.summary.errors += result.issues.filter(issue => issue.severity === 'error').length; report.summary.warnings += result.issues.filter(issue => issue.severity === 'warning').length; if (status === 'blocked') report.summary.blocked += 1
  }
  report.summary.strictFailures = options.strict ? report.scopes.flatMap(scope => scope.issues.filter(issue => issue.severity === 'error')) : []
  report.exitCode = options.strict && report.summary.strictFailures.length ? 1 : 0
  return report
}

function printSummary(report) {
  console.log(`Dependency audit: ${report.summary.projects} projects, ${report.summary.dependencies} outdated dependencies, ${report.summary.eligible} compatible patch/minor updates.`)
  for (const scope of report.scopes) {
    const updates = scope.dependencies.filter(item => item.kind !== 'current').map(item => `${item.name} ${item.current} -> ${(item.wanted && item.wanted !== item.current) ? item.wanted : item.latest} (${item.kind})`).join(', ')
    console.log(`- ${scope.name}: ${scope.status}${updates ? `; ${updates}` : ''}${scope.reportOnly ? '; report-only' : ''}`)
    for (const issue of scope.issues) console.log(`  ${issue.severity}: ${issue.message}`)
  }
  if (report.protectedChanges.length) console.log(`Protected changes: ${report.protectedChanges.map(item => item.file).join(', ')}`)
  if (report.strict) console.log(report.exitCode ? `Strict gate: failed (${report.summary.strictFailures.length} issue(s)).` : 'Strict gate: passed.')
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) { console.log('Usage: node scripts/dependency-audit.mjs [--mode check|upgrade] [--strict] [--apply] [--scope name] [--json path]'); return 0 }
  const report = await runAudit({ options })
  await mkdir(dirname(options.json), { recursive: true }); await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`)
  printSummary(report)
  return report.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(code => { process.exitCode = code }).catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
}
