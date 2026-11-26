// @ts-nocheck
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { access, appendFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_ENTRY = resolve(dirname(fileURLToPath(import.meta.url))) === resolve(PACKAGE_ROOT, 'src')
const CLI_ENTRY = SOURCE_ENTRY ? join(PACKAGE_ROOT, 'src', 'cli.ts') : join(PACKAGE_ROOT, 'dist', 'cli.mjs')
const CLI_RUNTIME_ARGS = SOURCE_ENTRY ? ['--experimental-strip-types'] : []
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, '../..')
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

export class AgentError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'AgentError'
    this.code = code
    if (options.status) this.status = options.status
  }
}
function now() {
  return new Date().toISOString()
}

function sleep(ms, signal) {
  if (!signal) return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
  if (signal.aborted) return Promise.reject(signal.reason ?? new AgentError('ERR_CANCELLED', 'Operation cancelled'))
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = callback => value => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      callback(value)
    }
    const resolve = finish(resolvePromise)
    const reject = finish(rejectPromise)
    const abort = () => reject(signal.reason ?? new AgentError('ERR_CANCELLED', 'Operation cancelled'))
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

function safeJson(value) {
  return JSON.stringify(value, null, 2) + '\n'
}

async function exists(path) {
  return access(path).then(() => true).catch(() => false)
}

function inside(root, target) {
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const suffix = relative(rootPath, targetPath)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

function projectPath(root, value) {
  const target = resolve(root, value)
  if (!inside(root, target)) throw new AgentError('ERR_PATH_OUTSIDE_PROJECT', `Path is outside project root: ${value}`)
  return target
}

async function readJson(path, fallback = {}) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.agent-json-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, safeJson(value), { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function walkFiles(root, options = {}) {
  const ignored = new Set(['.git', '.weapp-container', '.weapp-vite', 'node_modules', 'dist', 'coverage'])
  const includeHidden = options.includeHidden ?? false
  const ignoredDirectories = options.ignoredDirectories ?? ignored
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!includeHidden && entry.name.startsWith('.') && entry.name !== '.env.example') continue
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(join(directory, entry.name))
      } else if (entry.isFile()) {
        files.push(join(directory, entry.name))
      }
    }
  }
  await visit(root)
  return files.sort()
}

export async function digestDirectory(root, options = {}) {
  const hash = createHash('sha256')
  for (const file of await walkFiles(root, options)) {
    hash.update(relative(root, file).split(sep).join('/') + '\0')
    hash.update(await readFile(file))
  }
  return hash.digest('hex')
}

async function packageManager(root) {
  if (await exists(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await exists(join(root, 'yarn.lock'))) return 'yarn'
  if (await exists(join(root, 'bun.lockb'))) return 'bun'
  return 'npm'
}

const templateTags = new Set(['include', 'import', 'slot', 'template', 'wxs'])
const compatibilitySourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.wxs', '.wxml', '.wxss', '.json'])
const styleFeaturePatterns = [
  { name: 'wxss-rpx-units', pattern: /\b\d+(?:\.\d+)?rpx\b/gi },
  { name: 'wxss-page-selector', pattern: /(?:^|[},])\s*page\s*(?=[,{])/gim },
  { name: 'css-grid', pattern: /\bdisplay\s*:\s*grid\b/gi },
  { name: 'css-sticky', pattern: /\bposition\s*:\s*sticky\b/gi },
  { name: 'css-custom-properties', pattern: /\bvar\(\s*--[\w-]+/gi },
  { name: 'css-safe-area', pattern: /\benv\(\s*safe-area-inset-/gi },
  { name: 'css-host-selector', pattern: /:host(?:\b|\s*\()/gi },
  { name: 'css-import', pattern: /@import\b/gi },
]

function maskCode(source, mode) {
  const characters = source.split('')
  const blank = index => {
    if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' '
  }
  let state = 'code'
  let quote = ''
  for (let index = 0; index < characters.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (mode === 'wxml') {
      if (state === 'comment') {
        blank(index)
        if (character === '-' && source.slice(index, index + 3) === '-->') {
          blank(index + 1)
          blank(index + 2)
          index += 2
          state = 'code'
        }
      } else if (character === '<' && source.slice(index, index + 4) === '<!--') {
        blank(index)
        blank(index + 1)
        blank(index + 2)
        blank(index + 3)
        index += 3
        state = 'comment'
      }
      continue
    }
    if (state === 'line-comment') {
      blank(index)
      if (character === '\n') state = 'code'
      continue
    }
    if (state === 'block-comment') {
      blank(index)
      if (character === '*' && next === '/') {
        blank(index + 1)
        index += 1
        state = 'code'
      }
      continue
    }
    if (state === 'string') {
      blank(index)
      if (character === '\\') {
        if (index + 1 < characters.length) blank(++index)
      } else if (character === quote) {
        state = 'code'
      }
      continue
    }
    if (character === '/' && next === '/') {
      blank(index)
      blank(index + 1)
      index += 1
      state = 'line-comment'
    } else if (character === '/' && next === '*') {
      blank(index)
      blank(index + 1)
      index += 1
      state = 'block-comment'
    } else if (mode === 'javascript' && (character === '"' || character === "'" || character === '`')) {
      quote = character
      blank(index)
      state = 'string'
    } else if (mode === 'css' && (character === '"' || character === "'")) {
      quote = character
      blank(index)
      state = 'string'
    }
  }
  return characters.join('')
}

function lineStarts(source) {
  const starts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function sourceLocation(starts, offset) {
  let low = 0
  let high = starts.length
  while (low + 1 < high) {
    const middle = (low + high) >>> 1
    if (starts[middle] <= offset) low = middle
    else high = middle
  }
  return { line: low + 1, column: offset - starts[low] + 1 }
}

function compatibilityFinding(kind, name, path, starts, offset, row = null, detail = {}) {
  const status = ['full', 'partial', 'unsupported'].includes(row?.weappContainer?.status)
    ? row.weappContainer.status
    : 'unknown'
  const messages = {
    full: 'The compatibility matrix records this capability as full. Static inspection does not verify runtime behavior.',
    partial: 'The compatibility matrix records partial support. Check the listed evidence and host-specific limits.',
    unsupported: 'The compatibility matrix records this capability as unsupported in the current baseline.',
    unknown: 'No compatibility evidence is recorded for this use. Verify it on every target host.',
  }
  return {
    kind,
    name,
    status,
    severity: status === 'unsupported' ? 'error' : status === 'partial' ? 'warning' : 'info',
    priority: row?.priority ?? 'P1',
    path,
    ...sourceLocation(starts, offset),
    message: detail.message ?? messages[status],
    recommendation: detail.recommendation ?? (status === 'unsupported'
      ? 'Replace this capability or guard the code path with wx.canIUse before targeting this runtime.'
      : status === 'partial'
        ? 'Review the API limits and add a target-host scenario for the behavior this project relies on.'
        : 'Run a representative scenario on each target host and record the result before relying on this use.'),
    evidence: row?.weappContainer?.evidence ?? [],
    ...(row?.weappContainer?.hostCoverage ? { hostCoverage: row.weappContainer.hostCoverage } : {}),
    ...(row?.weappContainer?.engineCoverage ? { engineCoverage: row.weappContainer.engineCoverage } : {}),
  }
}

function addRegexFindings(findings, { kind, name, path, source, starts, pattern, row, detail }) {
  const matcher = new RegExp(pattern.source, pattern.flags)
  for (const match of source.matchAll(matcher)) {
    const findingName = typeof name === 'function' ? name(match) : name
    const findingRow = typeof row === 'function' ? row(match, findingName) : row
    findings.push(compatibilityFinding(kind, findingName, path, starts, match.index, findingRow, detail))
  }
}

let compatibilityDataPromise

async function compatibilityData() {
  if (!compatibilityDataPromise) {
    compatibilityDataPromise = (async () => {
      const inventory = await readJson(join(REPOSITORY_ROOT, 'docs/api-inventory-v1.json'), null)
      const packaged = inventory
        ? null
        : await readJson(join(PACKAGE_ROOT, 'dist/compatibility-baseline.json'), null)
      const source = inventory ?? packaged ?? { apiRows: [], baseline: null }
      const apiRows = source.apiRows ?? source.apis.flatMap(api => api.names.map(name => ({
        name,
        priority: 'P1',
        weappContainer: {
          status: api.support,
          evidence: api.conformance,
          hostCoverage: api.hostCoverage,
          engineCoverage: api.engineCoverage,
        },
      })))
      return {
        baseline: source.baseline ?? {
          kind: 'weapp-api-inventory',
          schemaVersion: source.schemaVersion,
          manifestVersion: source.manifestVersion,
          protocolVersion: source.protocolVersion,
          hosts: source.hosts,
          engines: source.engines,
        },
        rows: {
          api: new Map(apiRows.map(row => [row.name, row])),
          component: new Map(),
          template: new Map(),
        },
      }
    })()
  }
  return compatibilityDataPromise
}

async function scanCompatibility(root, sourceFiles) {
  const data = await compatibilityData()
  const compatibilityRows = data.rows
  const findings = []
  const warnings = []
  const customComponents = new Set()
  for (const file of sourceFiles) {
    if (!file.endsWith('.json')) continue
    try {
      const value = JSON.parse(await readFile(file, 'utf8'))
      for (const name of Object.keys(value?.usingComponents ?? {})) customComponents.add(name)
    } catch {
      // JSON validity remains the compiler's responsibility.
    }
  }

  for (const file of sourceFiles) {
    const extension = file.slice(file.lastIndexOf('.')).toLowerCase()
    if (!compatibilitySourceExtensions.has(extension) || extension === '.json') continue
    let original
    try {
      original = await readFile(file, 'utf8')
    } catch (error) {
      warnings.push({ path: relative(root, file).split(sep).join('/'), message: `Could not read source for compatibility scan: ${error.message}` })
      continue
    }
    const path = relative(root, file).split(sep).join('/')
    const mode = extension === '.wxml' ? 'wxml' : extension === '.wxss' ? 'css' : 'javascript'
    const source = maskCode(original, mode)
    const starts = lineStarts(original)

    if (mode === 'javascript') {
      addRegexFindings(findings, {
        kind: 'api',
        name: match => match[1] ? `wx.${match[1]}` : `wx.${match[3]}`,
        path,
        source,
        starts,
        pattern: /\bwx\s*(?:\?\.\s*|\.\s*)([$\w]+)|\bwx\s*\[\s*(['"])([^'"\]]+)\2\s*\]/g,
        row: (_match, name) => compatibilityRows.api.get(name),
      })
      addRegexFindings(findings, {
        kind: 'api',
        name: 'wx[dynamic]',
        path,
        source,
        starts,
        pattern: /\bwx\s*\[\s*([A-Za-z_$][\w$]*)\s*\]/g,
        row: null,
        detail: {
          message: 'The API name is computed at runtime, so static inspection cannot determine its compatibility status.',
          recommendation: 'Use an explicit API name or add a target-host test for each possible computed value.',
        },
      })
      addRegexFindings(findings, {
        kind: 'api',
        name: match => match[1],
        path,
        source,
        starts,
        pattern: /(?<![\w$.])(App|Page|Component)\s*\(/g,
        row: (_match, name) => compatibilityRows.api.get(name),
      })
    } else if (mode === 'wxml') {
      addRegexFindings(findings, {
        kind: 'template',
        name: match => match[1],
        path,
        source,
        starts,
        pattern: /\b(wx:[\w-]+)\b/g,
        row: (_match, name) => compatibilityRows.template.get(name),
        detail: {
          message: 'Static analysis does not maintain conformance status for WXML directives.',
          recommendation: 'Verify this directive in a representative scenario on every target host.',
        },
      })
      addRegexFindings(findings, {
        kind: 'template',
        name: match => match[1],
        path,
        source,
        starts,
        pattern: /<\s*(include|import|slot|template|wxs)\b/gi,
        row: (_match, name) => compatibilityRows.template.get(name),
      })
      addRegexFindings(findings, {
        kind: 'component',
        name: match => match[1],
        path,
        source,
        starts,
        pattern: /<\s*([a-z][a-z0-9-]*)\b/gi,
        row: (_match, name) => compatibilityRows.component.get(name),
      })
      for (let index = findings.length - 1; index >= 0; index -= 1) {
        const finding = findings[index]
        if (finding.path !== path || finding.kind !== 'component') continue
        if (templateTags.has(finding.name) || customComponents.has(finding.name)) {
          findings.splice(index, 1)
          continue
        }
        const row = compatibilityRows.component.get(finding.name)
        Object.assign(finding, compatibilityFinding('component', finding.name, path, starts, starts[finding.line - 1] + finding.column - 1, row))
        if (!row) {
          finding.message = 'This tag is not declared in project usingComponents, and the static baseline has no component status for it.'
          finding.recommendation = 'Check the component registration and verify any platform-specific component on each target host.'
        }
      }
      for (const finding of findings) {
        if (finding.path !== path || finding.kind !== 'template') continue
        const row = compatibilityRows.template.get(finding.name)
        const offset = starts[finding.line - 1] + finding.column - 1
        const detail = finding.name.startsWith('wx:') ? {
          message: 'Static analysis does not maintain conformance status for WXML directives.',
          recommendation: 'Verify this directive in a representative scenario on every target host.',
        } : undefined
        Object.assign(finding, compatibilityFinding('template', finding.name, path, starts, offset, row, detail))
      }
    } else if (mode === 'css') {
      for (const feature of styleFeaturePatterns) {
        addRegexFindings(findings, {
          kind: 'style',
          name: feature.name,
          path,
          source,
          starts,
          pattern: feature.pattern,
          row: null,
          detail: {
            message: 'The static baseline does not record compatibility status for this WXSS/CSS feature.',
            recommendation: 'Exercise the rendered style on each target host and record the layout result.',
          },
        })
      }
    }
  }

  const counts = findings.reduce((result, finding) => {
    result[finding.status] = (result[finding.status] ?? 0) + 1
    return result
  }, {})
  return {
    status: 'unknown',
    method: 'static-source-scan',
    baseline: data.baseline,
    filesScanned: sourceFiles.filter(file => compatibilitySourceExtensions.has(file.slice(file.lastIndexOf('.')).toLowerCase())).length,
    findings,
    counts,
    warnings,
  }
}

export async function inspectProject(projectRoot) {
  const root = resolve(projectRoot)
  const projectConfig = await readJson(join(root, 'project.config.json'), null)
  const packageJson = await readJson(join(root, 'package.json'), {})
  const sourceRoot = projectConfig?.srcMiniprogramRoot || (await exists(join(root, 'src')) ? 'src' : '.')
  const outputRoot = projectConfig?.miniprogramRoot || 'dist'
  const sourceDirectory = projectPath(root, sourceRoot)
  projectPath(root, outputRoot)
  const appJson = join(sourceDirectory, 'app.json')
  const app = await readJson(appJson, {})
  const pages = Array.isArray(app.pages) ? app.pages : []
  const sourceFiles = await walkFiles(sourceDirectory)
  return {
    root,
    kind: pages.length > 0 || projectConfig ? 'native' : 'unknown',
    packageManager: await packageManager(root),
    sourceRoot,
    outputRoot,
    pages,
    subPackages: app.subPackages ?? app.subpackages ?? [],
    scripts: packageJson.scripts ?? {},
    appId: projectConfig?.appid ?? null,
    projectConfig: projectConfig ? join(root, 'project.config.json') : null,
    appJson: await exists(appJson) ? appJson : null,
    sourceFileCount: sourceFiles.length,
    sourceDigest: await digestDirectory(root),
    compatibility: await scanCompatibility(root, sourceFiles),
    warnings: [
      ...(projectConfig ? [] : ['project.config.json is missing']),
      ...(pages.length ? [] : ['app.json has no pages']),
    ],
  }
}

async function resolveSourceFile(projectRoot, value, { createParents = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value) || value.includes('\0')) {
    throw new AgentError('ERR_SOURCE_PATH', 'A project-relative source file path is required')
  }
  const segments = value.replaceAll('\\', '/').replace(/^\.\//, '').split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..'
    || segment === 'node_modules' || segment === '.git' || segment === '.weapp-container'
    || segment === '.weapp-vite' || segment === 'dist' || segment === 'coverage'
    || segment === 'target'
    || (segment.startsWith('.env') && segment !== '.env.example'))) {
    throw new AgentError('ERR_SOURCE_PATH', `Source path is not writable: ${value}`)
  }
  const project = await inspectProject(projectRoot)
  const root = project.root
  await realpath(root)
  const target = projectPath(root, join(...segments))
  let current = root
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment)
    try {
      const entry = await lstat(current)
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new AgentError('ERR_SOURCE_PATH', `Source path traverses a non-directory: ${segment}`)
    } catch (error) {
      if (error?.code !== 'ENOENT' || !createParents) throw error
      await mkdir(current)
    }
  }
  try {
    const entry = await lstat(target)
    if (entry.isSymbolicLink() || !entry.isFile()) throw new AgentError('ERR_SOURCE_PATH', `Source path is not a regular file: ${value}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return { project, target }
}

export async function listProjectFiles(projectRoot) {
  const project = await inspectProject(projectRoot)
  await realpath(project.root)
  return {
    files: (await walkFiles(project.root)).map(file => relative(project.root, file).split(sep).join('/')),
  }
}

export async function readProjectFile(projectRoot, path) {
  const { target } = await resolveSourceFile(projectRoot, path)
  return { path, content: await readFile(target, 'utf8') }
}

export async function writeProjectFile(projectRoot, path, content) {
  if (typeof content !== 'string') throw new AgentError('ERR_SOURCE_CONTENT', 'File content must be a string')
  if (Buffer.byteLength(content) > 5 * 1024 * 1024) throw new AgentError('ERR_SOURCE_CONTENT', 'Source files must be 5 MB or smaller')
  const { target } = await resolveSourceFile(projectRoot, path, { createParents: true })
  const existing = await lstat(target).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
  const temporary = join(dirname(target), `.agent-write-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: existing ? existing.mode & 0o777 : 0o644 })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return { path, bytes: Buffer.byteLength(content), digest: createHash('sha256').update(content).digest('hex') }
}

export async function initProject(projectRoot) {
  const project = await inspectProject(projectRoot)
  const stateRoot = join(project.root, '.weapp-container')
  const configPath = join(stateRoot, 'agent.json')
  await mkdir(stateRoot, { recursive: true })
  const config = {
    schemaVersion: 1,
    projectRoot: project.root,
    sourceRoot: project.sourceRoot,
    outputRoot: project.outputRoot,
    packageManager: project.packageManager,
    initializedAt: now(),
  }
  try {
    await writeFile(configPath, safeJson(config), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    throw new AgentError('ERR_ALREADY_INITIALIZED', `Agent configuration already exists: ${configPath}`)
  }
  return { ...config, configPath }
}

function commandResult(command, args, result) {
  return {
    command: [command, ...args].join(' '),
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

export function runCommand(command, args, options = {}) {
  const cwd = options.cwd ?? REPOSITORY_ROOT
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const signal = options.signal
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const append = (current, chunk) => (current + chunk.toString()).slice(-MAX_OUTPUT_BYTES)
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      callback(value)
    }
    const abort = () => {
      child.kill('SIGTERM')
      finish(rejectPromise, signal.reason ?? new AgentError('ERR_CANCELLED', 'Command cancelled'))
    }
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
    child.once('error', error => finish(rejectPromise, error))
    child.once('close', (code, signalName) => finish(resolvePromise, commandResult(command, args, { code, signal: signalName, stdout, stderr })))
    if (signal) {
      if (signal.aborted) return abort()
      signal.addEventListener('abort', abort, { once: true })
    }
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(rejectPromise, new AgentError('ERR_TIMEOUT', `Command timed out after ${timeoutMs}ms`, { cause: { command, args } }))
    }, timeoutMs)
  })
}

async function resolveWv(projectRoot, explicit) {
  if (explicit) return explicit
  if (process.env.WEAPP_CONTAINER_WV_BIN) return process.env.WEAPP_CONTAINER_WV_BIN
  const candidates = [
    join(REPOSITORY_ROOT, 'vendor/weapp-vite/node_modules/.bin/wv'),
    join(projectRoot, 'node_modules/.bin/wv'),
  ]
  for (const candidate of candidates) if (await exists(candidate)) return candidate
  return 'wv'
}

async function compilerCommit() {
  const result = await runCommand('git', ['-C', join(REPOSITORY_ROOT, 'vendor/weapp-vite'), 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })
  return result.code === 0 ? result.stdout.trim() : 'unknown'
}

export async function buildProject(projectRoot, options = {}) {
  const project = await inspectProject(projectRoot)
  const root = project.root
  const stateRoot = projectPath(root, options.stateRoot ?? '.weapp-container')
  const buildRoot = join(stateRoot, 'builds', options.jobId ?? randomUUID())
  const output = projectPath(root, options.outputRoot ?? project.outputRoot)
  await mkdir(buildRoot, { recursive: true })
  const wv = await resolveWv(root, options.wvBin)
  const platform = options.platform ?? 'weapp'
  const buildArgs = ['build', root, '-p', platform, '--outDir', output]
  const runner = options.commandRunner ?? runCommand
  const build = await runner(wv, buildArgs, { cwd: root, timeoutMs: options.timeoutMs })
  if (build.code !== 0) throw new AgentError('ERR_BUILD_FAILED', build.stderr || build.stdout || 'weapp-vite build failed', { cause: build })
  let packDirectory
  let pack
  let manifest
  if (platform === 'weapp') {
    const packContainer = options.packContainer ?? (await import('@sonofmagic/container-manifest')).packContainer
    packDirectory = join(buildRoot, 'pack')
    const compiler = await compilerCommit()
    try {
      await packContainer(output, packDirectory, { compilerCommit: compiler, platform })
    } catch (error) {
      throw new AgentError('ERR_PACK_FAILED', error?.message ?? 'container pack failed', { cause: error })
    }
    manifest = await readJson(join(packDirectory, 'manifest.json'), {})
    pack = { code: 0, signal: null, stdout: 'Portable pack created', stderr: '' }
  }
  const result = {
    project,
    platform,
    build: commandResult(wv, buildArgs, build),
    pack,
    packDirectory: packDirectory ?? null,
    outputDirectory: output,
    compilerCommit: manifest?.compiler?.commit ?? await compilerCommit(),
    sourceDigest: await digestDirectory(root),
    manifest: manifest ?? null,
    generatedAt: now(),
  }
  await writeJson(join(buildRoot, 'build-report.json'), result)
  return result
}

export class JobStore {
  constructor(root) {
    this.root = resolve(root)
    this.stateRoot = join(this.root, '.weapp-container', 'agent')
    this.jobsRoot = join(this.stateRoot, 'jobs')
    this.jobs = new Map()
    this.abortControllers = new Map()
    this.writePromises = new Map()
    this.executionPromises = new Map()
  }

  async init() {
    await mkdir(this.jobsRoot, { recursive: true })
  }

  async save(job) {
    const snapshot = structuredClone(job)
    this.jobs.set(job.jobId, snapshot)
    const previous = this.writePromises.get(job.jobId) ?? Promise.resolve()
    const current = previous.then(async () => {
      await writeJson(join(this.jobsRoot, `${job.jobId}.json`), snapshot)
    })
    this.writePromises.set(job.jobId, current)
    try { await current } finally { if (this.writePromises.get(job.jobId) === current) this.writePromises.delete(job.jobId) }
    return job
  }

  async create(kind, input = {}) {
    await this.init()
    const job = {
      schemaVersion: 1,
      jobId: randomUUID(),
      projectRoot: this.root,
      kind,
      status: 'queued',
      createdAt: now(),
      sourceDigest: input.sourceDigest ?? null,
      input,
      artifacts: [],
      diagnostics: [],
      events: [],
    }
    await this.save(job)
    return job
  }

  async update(job, patch, event) {
    Object.assign(job, patch)
    let record
    if (event) {
      record = { sequence: job.events.length + 1, timestamp: now(), ...event }
      job.events.push(record)
    }
    if (record) {
      const previous = this.writePromises.get(job.jobId) ?? Promise.resolve()
      const snapshot = structuredClone(job)
      this.jobs.set(job.jobId, snapshot)
      const current = previous.then(async () => {
        await appendFile(join(this.jobsRoot, `${job.jobId}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 })
        await writeJson(join(this.jobsRoot, `${job.jobId}.json`), snapshot)
      })
      this.writePromises.set(job.jobId, current)
      try { await current } finally { if (this.writePromises.get(job.jobId) === current) this.writePromises.delete(job.jobId) }
    } else {
      await this.save(job)
    }
    return job
  }

  async start(kind, input, operation) {
    const job = await this.create(kind, input)
    const controller = new AbortController()
    this.abortControllers.set(job.jobId, controller)
    const execution = new Promise(resolvePromise => setImmediate(resolvePromise))
      .then(() => this.execute(job, controller, operation))
    this.executionPromises.set(job.jobId, execution)
    void execution.then(
      () => { if (this.executionPromises.get(job.jobId) === execution) this.executionPromises.delete(job.jobId) },
      () => { if (this.executionPromises.get(job.jobId) === execution) this.executionPromises.delete(job.jobId) },
    )
    return job
  }

  async execute(job, controller, operation) {
    try {
      if (controller.signal.aborted) throw controller.signal.reason
      await this.update(job, { status: 'running', startedAt: now() }, { type: 'job.started' })
      const result = await operation(job, controller.signal)
      const status = ['passed', 'failed', 'blocked'].includes(result?.status) ? result.status : 'passed'
      await this.update(job, { status, finishedAt: now(), result }, { type: `job.${status === 'passed' ? 'completed' : status}`, resultStatus: result?.status })
    } catch (error) {
      const cancelled = error?.code === 'ERR_CANCELLED' || controller.signal.aborted
      const status = cancelled ? 'cancelled' : error?.status === 'blocked' ? 'blocked' : 'failed'
      await this.update(job, {
        status,
        finishedAt: now(),
        error: { code: error?.code ?? 'ERR_JOB_FAILED', message: error?.message ?? String(error) },
      }, { type: `job.${status}`, error: error?.message ?? String(error) })
    } finally {
      this.abortControllers.delete(job.jobId)
    }
  }

  async status(jobId) {
    if (!/^[0-9a-f-]{36}$/i.test(jobId ?? '')) throw new AgentError('ERR_JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    await this.writePromises.get(jobId)
    const inMemory = this.jobs.get(jobId)
    if (inMemory) return structuredClone(inMemory)
    return readJson(join(this.jobsRoot, `${jobId}.json`), null)
  }

  async cancel(jobId) {
    const controller = this.abortControllers.get(jobId)
    if (!controller) {
      const job = await this.status(jobId)
      if (!job) throw new AgentError('ERR_JOB_NOT_FOUND', `Unknown job: ${jobId}`)
      return job
    }
    controller.abort(new AgentError('ERR_CANCELLED', 'Job cancelled'))
    await this.executionPromises.get(jobId)
    return this.status(jobId)
  }

  async events(jobId) {
    await this.writePromises.get(jobId)
    if (!await this.status(jobId)) throw new AgentError('ERR_JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    const path = join(this.jobsRoot, `${jobId}.jsonl`)
    try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) { if (error?.code === 'ENOENT') return []; throw error }
  }
}

const jobStores = new Map()

function jobStoreFor(root) {
  const projectRoot = resolve(root)
  let store = jobStores.get(projectRoot)
  if (!store) {
    store = new JobStore(projectRoot)
    jobStores.set(projectRoot, store)
  }
  return store
}

async function readProcessLog(path) {
  try { return await readFile(path, 'utf8') } catch { return '' }
}

async function controlRequest(url, token, path, options = {}) {
  const response = await fetch(new URL(path, url), {
    ...options,
    headers: { ...(options.headers ?? {}), 'x-weapp-container-token': token },
  })
  const text = await response.text()
  let value
  try { value = JSON.parse(text) } catch { value = { text } }
  if (!response.ok) throw new AgentError('ERR_PREVIEW_CONTROL', `${path} HTTP ${response.status}`, { cause: value })
  return value
}

function ownedToken(value, expected) {
  const actual = Buffer.from(String(value ?? ''))
  const target = Buffer.from(String(expected ?? ''))
  return actual.length === target.length && timingSafeEqual(actual, target)
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) > 0
      && !url.username && !url.password
  } catch {
    return false
  }
}

export async function runPreviewDaemon(options) {
  const root = resolve(options.projectRoot)
  const pathsRoot = join(root, '.weapp-container', 'preview')
  await mkdir(pathsRoot, { recursive: true })
  const logPath = options.logPath ?? join(pathsRoot, `${Date.now()}-${randomUUID()}.log`)
  const sessionPath = options.sessionPath ?? join(root, '.weapp-container', 'preview.json')
  const errorPath = options.errorPath ?? `${sessionPath}.error`
  const token = options.token
  if (!token) throw new AgentError('ERR_PREVIEW_CONTROL', 'Preview daemon requires an ownership token')
  const simulator = options.simulatorCommand
    ? { command: options.simulatorCommand, prefix: options.simulatorPrefix ?? [], cwd: root }
    : await simulatorBinary(root)
  const args = [...simulator.prefix, 'dev', '--project', root, '--surface', options.surface ?? 'web', '--engine', options.engine ?? 'quickjs', '--renderer', options.renderer ?? 'webview', '--port', String(options.port ?? 0), '--out-dir', pathsRoot]
  const log = createWriteStream(logPath, { mode: 0o600 })
  const child = spawn(simulator.command, args, { cwd: simulator.cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  let spawnError
  child.once('error', error => { spawnError = error })
  const startedAt = now()
  let url
  const waitUntilReady = async () => {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    while (Date.now() < deadline) {
      const content = await readProcessLog(logPath)
      const match = content.match(/weapp-simulator: web surface (http:\/\/127\.0\.0\.1:\d+\/?)/)
      if (match) { url = match[1].endsWith('/') ? match[1] : `${match[1]}/`; return }
      if (spawnError) throw new AgentError('ERR_PREVIEW_START_FAILED', `Could not start simulator: ${spawnError.message}`, { cause: spawnError })
      if (child.exitCode !== null) throw new AgentError('ERR_PREVIEW_START_FAILED', `Simulator exited with code ${child.exitCode}. See ${logPath}`)
      await sleep(100, options.signal)
    }
    throw new AgentError('ERR_PREVIEW_START_FAILED', `Simulator did not announce a Web URL. See ${logPath}`)
  }
  const terminate = async () => {
    if (child.exitCode !== null) return
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
    } else {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      await new Promise(resolvePromise => { killer.once('error', resolvePromise); killer.once('close', resolvePromise) })
      if (child.exitCode === null) child.kill('SIGTERM')
    }
    await new Promise(resolvePromise => {
      const timer = setTimeout(resolvePromise, 5000)
      child.once('close', () => { clearTimeout(timer); resolvePromise() })
    })
  }
  let server
  let serverClosing = false
  const closeServer = () => {
    if (!server || serverClosing) return
    serverClosing = true
    server.close()
  }
  const handleSignal = () => { void terminate().finally(closeServer) }
  process.once('SIGINT', handleSignal)
  process.once('SIGTERM', handleSignal)
  try {
    await waitUntilReady()
    server = createServer(async (request, response) => {
      if (!ownedToken(request.headers['x-weapp-container-token'], token)) {
        response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'unauthorized' })); return
      }
      if (request.url === '/status' && request.method === 'GET') {
        let state = null
        try { state = await fetch(new URL('/api/state', url)).then(result => result.json()) } catch {}
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: state?.status === 'ready' ? 'ready' : 'starting', url, project: root, logPath, startedAt, pid: child.pid, state })); return
      }
      if (request.url === '/stop' && request.method === 'POST') {
        response.writeHead(202, { 'content-type': 'application/json' }); response.end(JSON.stringify({ stopping: true }));
        await terminate(); closeServer(); return
      }
      response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'not found' }))
    })
    await new Promise((resolvePromise, rejectPromise) => { server.once('error', rejectPromise); server.listen(0, '127.0.0.1', resolvePromise) })
    const address = server.address()
    const session = { schemaVersion: 2, pid: child.pid, daemonPid: process.pid, controlUrl: `http://127.0.0.1:${address.port}/`, url, project: root, packDirectory: options.packDirectory ?? null, logPath, token, startedAt }
    await writeJson(sessionPath, session)
    child.once('close', () => { closeServer(); void rm(sessionPath, { force: true }) })
    await new Promise(resolvePromise => server.once('close', resolvePromise))
  } catch (error) {
    await writeJson(errorPath, { code: error?.code ?? 'ERR_PREVIEW_START_FAILED', message: error?.message ?? String(error) }).catch(() => {})
    throw error
  } finally {
    process.removeListener('SIGINT', handleSignal)
    process.removeListener('SIGTERM', handleSignal)
    await terminate()
    log.end()
    await rm(sessionPath, { force: true })
  }
}

async function simulatorBinary(projectRoot) {
  const configured = process.env.WEAPP_CONTAINER_SIMULATOR_BIN
  if (configured) {
    if (await exists(configured)) return { command: configured, prefix: [], cwd: projectRoot }
    throw new AgentError('ERR_SIMULATOR_NOT_FOUND', `WEAPP_CONTAINER_SIMULATOR_BIN does not exist: ${configured}`)
  }
  const binaryName = process.platform === 'win32' ? 'weapp-simulator.exe' : 'weapp-simulator'
  const candidates = [
    join(PACKAGE_ROOT, 'bin', binaryName),
    join(projectRoot, 'node_modules/.bin', binaryName),
  ]
  for (const candidate of candidates) {
    if (await exists(candidate)) return { command: candidate, prefix: [], cwd: projectRoot }
  }
  const local = join(REPOSITORY_ROOT, 'target/debug/weapp-simulator')
  if (await exists(local)) return { command: local, prefix: [], cwd: projectRoot }
  if (await exists(join(REPOSITORY_ROOT, 'Cargo.toml'))) {
    return {
      command: process.env.CARGO ?? 'cargo',
      prefix: ['run', '-p', 'container-simulator', '--locked', '--features', 'quickjs-native', '--'],
      cwd: REPOSITORY_ROOT,
    }
  }
  return { command: binaryName, prefix: [], cwd: projectRoot }
}

export class PreviewStore {
  constructor(root) {
    this.root = resolve(root)
    this.file = join(this.root, '.weapp-container', 'preview.json')
  }

  async status() {
    const session = await readJson(this.file, null)
    if (!session) return { status: 'closed' }
    if (!session.controlUrl || !session.token) return { status: 'unknown', reason: 'legacy preview session has no ownership control' }
    if (session.project !== this.root || !isLoopbackUrl(session.controlUrl) || !/^[a-f0-9]{64}$/i.test(session.token)) {
      return { status: 'unknown', reason: 'preview session ownership data is invalid' }
    }
    try {
      const status = await controlRequest(session.controlUrl, session.token, '/status')
      return isLoopbackUrl(status.url) ? status : { status: 'unknown', reason: 'preview URL is not a loopback address' }
    } catch {
      return { status: 'unknown', reason: 'preview control endpoint is unreachable' }
    }
  }

  async start(options = {}) {
    const existing = await this.status()
    if (existing.status === 'ready' || existing.status === 'starting') return existing
    if (existing.status === 'unknown') throw new AgentError('ERR_PREVIEW_STATE_UNKNOWN', 'An existing preview session cannot be authenticated or stopped safely')
    const pack = options.packDirectory
    if (pack && !(await exists(resolve(pack)))) throw new AgentError('ERR_PACK_NOT_FOUND', `Pack directory does not exist: ${pack}`)
    const pathsRoot = join(this.root, '.weapp-container', 'preview')
    await mkdir(pathsRoot, { recursive: true })
    const logPath = join(pathsRoot, `${Date.now()}-${randomUUID()}.log`)
    const errorPath = `${this.file}.error`
    await rm(errorPath, { force: true })
    const token = randomBytes(32).toString('hex')
    const daemonArgs = [...CLI_RUNTIME_ARGS, CLI_ENTRY, '--preview-daemon', '--project', this.root, '--token', token, '--surface', options.surface ?? 'web', '--engine', options.engine ?? 'quickjs', '--renderer', options.renderer ?? 'webview', '--port', String(options.port ?? 0), '--log', logPath, '--error', errorPath]
    if (pack) daemonArgs.push('--pack', resolve(pack))
    if (options.simulatorCommand) daemonArgs.push('--simulator-command', options.simulatorCommand, '--simulator-prefix', JSON.stringify(options.simulatorPrefix ?? []))
    const daemon = spawn(process.execPath, daemonArgs, { cwd: REPOSITORY_ROOT, detached: true, stdio: 'ignore', windowsHide: true })
    daemon.unref()
    try {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (options.signal?.aborted) throw options.signal.reason ?? new AgentError('ERR_CANCELLED', 'Preview start cancelled')
        const session = await readJson(this.file, null)
        if (session?.token === token) return await waitForPreviewReady(this, timeoutMs, options.signal)
        const failure = await readJson(errorPath, null)
        if (failure) throw new AgentError(failure.code ?? 'ERR_PREVIEW_START_FAILED', failure.message ?? 'Preview daemon failed')
        try { process.kill(daemon.pid, 0) } catch { break }
        await sleep(100, options.signal)
      }
      throw new AgentError('ERR_PREVIEW_START_FAILED', `Preview daemon did not become ready. See ${logPath}`)
    } catch (error) {
      const session = await readJson(this.file, null)
      if (session?.token === token) {
        try { await controlRequest(session.controlUrl, token, '/stop', { method: 'POST' }) } catch (stopError) {
          throw new AgentError(error?.code ?? 'ERR_PREVIEW_START_FAILED', `${error?.message ?? String(error)}. Preview cleanup failed: ${stopError.message}`, { cause: { error, stopError } })
        }
      } else {
        try { process.kill(daemon.pid, 'SIGTERM') } catch {}
      }
      throw error
    }
  }

  async stop() {
    const session = await readJson(this.file, null)
    if (!session) return { status: 'closed' }
    if (session.controlUrl && session.token) {
      try { await controlRequest(session.controlUrl, session.token, '/stop', { method: 'POST' }) } catch (error) { throw new AgentError('ERR_PREVIEW_STOP_FAILED', error.message, { cause: error }) }
    } else throw new AgentError('ERR_PREVIEW_STOP_FAILED', 'Preview session is not owned by this agent')
    await rm(this.file, { force: true })
    return { status: 'closed', pid: session.pid, daemonPid: session.daemonPid }
  }

  async request(path, options = {}) {
    const status = await this.status()
    if (!status.url) throw new AgentError('ERR_PREVIEW_UNAVAILABLE', 'Preview is not running')
    const response = await fetch(new URL(path, status.url), options)
    const text = await response.text()
    let value
    try { value = JSON.parse(text) } catch { value = { text } }
    if (!response.ok) throw new AgentError('ERR_PREVIEW_HTTP', `${path} HTTP ${response.status}`, { cause: value })
    return value
  }
}

async function waitForPreviewReady(preview, timeoutMs = DEFAULT_TIMEOUT_MS, signal) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new AgentError('ERR_CANCELLED', 'Preview readiness wait cancelled')
    const state = await preview.status()
    if (state.status === 'ready') return state
    if (state.status === 'unknown') throw new AgentError('ERR_PREVIEW_STATE_UNKNOWN', state.reason ?? 'Preview state is unknown')
    if (state.status === 'closed') throw new AgentError('ERR_PREVIEW_START_FAILED', 'Preview closed before becoming ready')
    await sleep(100, signal)
  }
  throw new AgentError('ERR_PREVIEW_READY_TIMEOUT', `Preview did not become ready within ${timeoutMs}ms`)
}

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await copyDirectory(from, to)
    else if (entry.isFile()) {
      await mkdir(dirname(to), { recursive: true })
      await new Promise((resolvePromise, rejectPromise) => createReadStream(from).pipe(createWriteStream(to)).on('finish', resolvePromise).on('error', rejectPromise))
    }
  }
}

export async function prepareRelease(projectRoot, version, options = {}) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new AgentError('ERR_INVALID_VERSION', `Invalid release version: ${version}`)
  const root = resolve(projectRoot)
  const build = options.buildResult ?? await buildProject(root, options)
  if (build.platform && build.platform !== 'weapp') throw new AgentError('ERR_RELEASE_PLATFORM', 'Container releases require a weapp portable pack')
  if (!build.packDirectory) throw new AgentError('ERR_RELEASE_PACK_REQUIRED', 'Container releases require a successful weapp portable pack')
  const releaseRoot = projectPath(root, options.releaseRoot ?? '.weapp-container/releases')
  const destination = join(releaseRoot, version)
  if (await exists(destination)) throw new AgentError('ERR_RELEASE_EXISTS', `Release already exists: ${version}`)
  const evidence = options.evidence ?? [await runRuntimeSmoke(build, options).catch(error => ({
    type: 'simulator-runtime-smoke', status: 'failed', error: { code: error.code ?? 'ERR_RUNTIME_SMOKE', message: error.message },
  }))]
  const releaseStatus = evidence.some(item => item.status === 'failed')
    ? 'failed'
    : evidence.length > 0 && evidence.every(item => item.status === 'passed') ? 'verified' : 'draft'
  const staging = join(releaseRoot, `.prepare-${version}-${randomUUID()}`)
  await mkdir(releaseRoot, { recursive: true })
  let manifest
  try {
    await mkdir(staging)
    await copyDirectory(build.packDirectory, join(staging, 'pack'))
    manifest = {
      schemaVersion: 1,
      version,
      projectDigest: await digestDirectory(root),
      sourceDigest: build.sourceDigest,
      compilerIdentity: build.compilerCommit,
      packDigest: await digestDirectory(join(staging, 'pack'), { includeHidden: true, ignoredDirectories: new Set() }),
      evidence,
      createdAt: now(),
      status: releaseStatus,
      buildReport: 'build-report.json',
    }
    await writeJson(join(staging, 'build-report.json'), { ...build, evidence })
    await writeJson(join(staging, 'release.json'), manifest)
    await rename(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
      throw new AgentError('ERR_RELEASE_EXISTS', `Release already exists: ${version}`, { cause: error })
    }
    throw error
  }
  return { ...manifest, path: destination }
}

async function runRuntimeSmoke(build, options = {}) {
  const simulator = await simulatorBinary(build.project.root)
  const reportPath = join(dirname(build.packDirectory), 'runtime-smoke.json')
  const route = build.project.pages?.[0]
  const args = [...simulator.prefix, 'run', '--pack', build.packDirectory, ...(route ? ['--route', route] : []), '--report', reportPath]
  const result = await runCommand(simulator.command, args, { cwd: REPOSITORY_ROOT, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
  const report = await readJson(reportPath, null)
  if (result.code !== 0 || report?.status !== 'passed') {
    throw new AgentError('ERR_RUNTIME_SMOKE_FAILED', result.stderr || report?.error || result.stdout || 'Simulator runtime smoke did not pass', { cause: { command: commandResult(simulator.command, args, result), report } })
  }
  return { type: 'simulator-runtime-smoke', status: 'passed', engine: report.engine ?? 'quickjs', route: report.route ?? route ?? null, reportPath, report }
}

async function verifyReleasePack(destination, manifest) {
  const packPath = join(destination, 'pack')
  if (!await exists(packPath)) throw new AgentError('ERR_RELEASE_INTEGRITY', 'Release pack is missing')
  const actualDigest = await digestDirectory(packPath, { includeHidden: true, ignoredDirectories: new Set() })
  if (actualDigest !== manifest.packDigest) throw new AgentError('ERR_RELEASE_INTEGRITY', 'Release pack digest does not match its manifest')
  if (!await exists(join(packPath, 'manifest.json'))) throw new AgentError('ERR_RELEASE_INTEGRITY', 'Release pack manifest is missing')
}

export async function commitRelease(projectRoot, version, options = {}) {
  if (options.confirmed !== true) throw new AgentError('ERR_CONFIRMATION_REQUIRED', 'Release commit requires explicit confirmation')
  const root = resolve(projectRoot)
  const releaseRoot = projectPath(root, '.weapp-container/releases')
  const destination = join(releaseRoot, version)
  const manifestPath = join(destination, 'release.json')
  const manifest = await readJson(manifestPath, null)
  if (!manifest) throw new AgentError('ERR_RELEASE_NOT_FOUND', `Release does not exist: ${version}`)
  if (manifest.status !== 'verified' && manifest.status !== 'committed') throw new AgentError('ERR_RELEASE_INVALID_STATE', `Release cannot be committed from ${manifest.status}`)
  await verifyReleasePack(destination, manifest)
  if (await digestDirectory(root) !== manifest.projectDigest) throw new AgentError('ERR_RELEASE_SOURCE_CHANGED', 'Project source changed after release preparation')
  const updated = { ...manifest, status: 'committed', committedAt: now() }
  await writeJson(manifestPath, updated)
  await writeJson(join(releaseRoot, 'current.json'), { schemaVersion: 1, version, updatedAt: now() })
  return { ...updated, path: destination }
}

export async function listReleases(projectRoot) {
  const releaseRoot = projectPath(resolve(projectRoot), '.weapp-container/releases')
  const entries = await readdir(releaseRoot, { withFileTypes: true }).catch(() => [])
  const releases = []
  for (const entry of entries.filter(entry => entry.isDirectory())) {
    const manifest = await readJson(join(releaseRoot, entry.name, 'release.json'), null)
    if (manifest) releases.push({ ...manifest, path: join(releaseRoot, entry.name) })
  }
  releases.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return { current: await readJson(join(releaseRoot, 'current.json'), null), releases }
}

export async function rollbackRelease(projectRoot, version, options = {}) {
  if (options.confirmed !== true) throw new AgentError('ERR_CONFIRMATION_REQUIRED', 'Release rollback requires explicit confirmation')
  const listing = await listReleases(projectRoot)
  const target = listing.releases.find(release => release.version === version)
  if (!target) throw new AgentError('ERR_RELEASE_NOT_FOUND', `Release does not exist: ${version}`)
  if (target.status !== 'committed') throw new AgentError('ERR_RELEASE_INVALID_STATE', `Release cannot be rolled back from ${target.status}`)
  await verifyReleasePack(target.path, target)
  await writeJson(join(resolve(projectRoot), '.weapp-container/releases/current.json'), { schemaVersion: 1, version, updatedAt: now(), rolledBack: true })
  return { ...target, status: 'rolled_back', current: version }
}

export async function publishRelease(projectRoot, version, options = {}) {
  if (options.confirmed !== true) throw new AgentError('ERR_CONFIRMATION_REQUIRED', 'Release publish requires explicit confirmation')
  const root = resolve(projectRoot)
  const listing = await listReleases(root)
  const target = listing.releases.find(release => release.version === version)
  if (!target) throw new AgentError('ERR_RELEASE_NOT_FOUND', `Release does not exist: ${version}`)
  if (target.status !== 'committed') throw new AgentError('ERR_RELEASE_INVALID_STATE', `Release cannot be published from ${target.status}`)
  await verifyReleasePack(target.path, target)
  if (await digestDirectory(root) !== target.projectDigest) throw new AgentError('ERR_RELEASE_SOURCE_CHANGED', 'Project source changed after release preparation')
  const platform = options.platform ?? 'weapp'
  const configuredKeyPath = options.privateKeyPath ?? process.env.WEAPP_CI_PRIVATE_KEY_PATH
  const privateKeyPath = configuredKeyPath ? resolve(root, configuredKeyPath) : undefined
  if (platform === 'weapp' && !privateKeyPath) {
    throw new AgentError('ERR_PUBLISH_CREDENTIALS', '微信发布需要 WEAPP_CI_PRIVATE_KEY_PATH 指向代码上传私钥', { status: 'blocked' })
  }
  if (platform === 'weapp' && privateKeyPath && !await exists(privateKeyPath)) {
    throw new AgentError('ERR_PUBLISH_CREDENTIALS', `微信上传私钥文件不存在: ${privateKeyPath}`, { status: 'blocked' })
  }
  const wv = await resolveWv(root, options.wvBin)
  const args = ['build', '--upload', '-p', platform, '--uv', version, '--desc', options.description ?? `weapp-container ${version}`]
  const runner = options.commandRunner ?? runCommand
  const publish = await runner(wv, args, {
    cwd: root,
    timeoutMs: options.timeoutMs,
    env: privateKeyPath ? { WEAPP_CI_PRIVATE_KEY_PATH: privateKeyPath } : undefined,
    signal: options.signal,
  })
  if (publish.code !== 0) throw new AgentError('ERR_PUBLISH_FAILED', publish.stderr || publish.stdout || 'Mini-program publish failed', { cause: commandResult(wv, args, publish) })
  const receipt = {
    schemaVersion: 1,
    version,
    platform,
    status: 'uploaded',
    command: [wv, ...args].join(' '),
    uploadedAt: now(),
  }
  await writeJson(join(target.path, 'publish.json'), receipt)
  return { ...receipt, releasePath: target.path }
}

async function loadPlaywright(root) {
  const candidates = [
    process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE,
    join(PACKAGE_ROOT, 'node_modules/playwright/index.mjs'),
    join(REPOSITORY_ROOT, 'vendor/weapp-vite/node_modules/playwright/index.mjs'),
    join(root, 'node_modules/playwright/index.mjs'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (await exists(candidate)) return import(pathToFileURL(candidate).href)
  }
  throw new AgentError('ERR_BROWSER_UNAVAILABLE', 'Playwright is unavailable. Set WEAPP_CONTAINER_PLAYWRIGHT_MODULE or install playwright in the project.', { status: 'blocked' })
}

async function browserLaunch(root, browserOptions = {}) {
  const playwright = await loadPlaywright(root)
  if (browserOptions.headless !== undefined && typeof browserOptions.headless !== 'boolean') {
    throw new AgentError('ERR_SCENARIO_INVALID', 'browser.headless must be a boolean')
  }
  const launchOptions = { headless: browserOptions.headless ?? true, handleSIGINT: false, handleSIGTERM: false }
  const executablePath = browserOptions.executablePath ?? process.env.WEAPP_CONTAINER_BROWSER_EXECUTABLE_PATH
  if (executablePath) launchOptions.executablePath = executablePath
  else {
    const systemChrome = process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : process.platform === 'win32'
        ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        : '/usr/bin/google-chrome'
    if (await exists(systemChrome)) launchOptions.channel = 'chrome'
  }
  try {
    return await playwright.chromium.launch(launchOptions)
  } catch (error) {
    throw new AgentError('ERR_BROWSER_UNAVAILABLE', `Could not launch Chromium: ${error.message}. Install a browser with npx playwright install chromium or set WEAPP_CONTAINER_BROWSER_EXECUTABLE_PATH.`, { cause: error, status: 'blocked' })
  }
}

async function browserProperty(locator, property, attributeName) {
  if (property === 'text' || property === 'textContent') return locator.textContent()
  if (property === 'value') return locator.inputValue()
  if (property === 'count') return locator.count()
  if (property === 'visible') return locator.isVisible()
  if (property === 'enabled') return locator.isEnabled()
  if (property === 'attribute') {
    if (typeof attributeName !== 'string' || !attributeName) throw new AgentError('ERR_SCENARIO_INVALID', 'Browser attribute property requires an attribute name')
    return locator.getAttribute(attributeName)
  }
  throw new AgentError('ERR_SCENARIO_INVALID', `Unsupported browser locator property: ${property}`)
}

function scenarioArtifactPath(root, artifactRoot, value) {
  const target = resolve(artifactRoot, value ?? 'screenshot.png')
  if (!inside(root, target) || !inside(artifactRoot, target)) throw new AgentError('ERR_PATH_OUTSIDE_PROJECT', `Browser artifact path is outside the artifact directory: ${value ?? 'screenshot.png'}`)
  return target
}

async function runBrowserStep(browserState, step, root, artifactRoot, timeoutMs) {
  const page = browserState.page
  page.setDefaultTimeout(timeoutMs)
  const selector = step.selector
  if (step.frame !== undefined && (typeof step.frame !== 'string' || !step.frame.trim())) {
    throw new AgentError('ERR_SCENARIO_INVALID', 'Browser frame requires a non-empty selector')
  }
  const scope = step.frame ? page.frameLocator(step.frame) : page
  const locator = selector ? scope.locator(selector) : null
  if (step.action === 'goto') {
    const targetUrl = new URL(step.url ?? '/', browserState.baseUrl)
    if (targetUrl.origin !== new URL(browserState.baseUrl).origin) throw new AgentError('ERR_SCENARIO_URL', 'Browser navigation must stay on the local preview origin')
    const target = targetUrl.toString()
    await page.goto(target, { waitUntil: step.waitUntil ?? 'domcontentloaded' })
    return { action: step.action, url: page.url() }
  }
  if (step.action === 'click') {
    if (!locator) throw new AgentError('ERR_SCENARIO_INVALID', 'Browser click requires selector')
    await locator.click()
    return { action: step.action, selector }
  }
  if (step.action === 'fill') {
    if (!locator) throw new AgentError('ERR_SCENARIO_INVALID', 'Browser fill requires selector')
    await locator.fill(String(step.value ?? ''))
    return { action: step.action, selector, value: String(step.value ?? '') }
  }
  if (step.action === 'press') {
    if (!locator || typeof step.key !== 'string') throw new AgentError('ERR_SCENARIO_INVALID', 'Browser press requires selector and key')
    await locator.press(step.key)
    return { action: step.action, selector, key: step.key }
  }
  if (step.action === 'wait') {
    if (locator) await locator.waitFor({ state: step.state ?? 'visible' })
    else await page.waitForTimeout(Number(step.ms ?? 100))
    return { action: step.action, selector: selector ?? null }
  }
  if (step.action === 'locator') {
    if (!locator) throw new AgentError('ERR_SCENARIO_INVALID', 'Browser locator requires selector')
    const property = step.property ?? 'text'
    return { action: step.action, selector, property, value: await browserProperty(locator, property, step.name) }
  }
  if (step.action === 'screenshot') {
    const path = scenarioArtifactPath(root, artifactRoot, step.path)
    await mkdir(dirname(path), { recursive: true })
    await page.screenshot({ path, fullPage: step.fullPage ?? true })
    return { action: step.action, path, url: page.url() }
  }
  throw new AgentError('ERR_SCENARIO_UNSUPPORTED', `Unsupported browser action: ${step.action}`)
}

export async function runScenario(preview, scenario = {}, options = {}) {
  const steps = Array.isArray(scenario.steps) ? scenario.steps : []
  const results = []
  const scenarioLeases = new Set()
  const root = resolve(options.projectRoot ?? process.cwd())
  const artifactRoot = resolve(options.artifactRoot ?? join(root, '.weapp-container', 'agent', 'artifacts', options.jobId ?? randomUUID()))
  let browserState
  const assertExpected = (value, expected, index) => {
    if (expected === undefined) return
    const matches = (actual, wanted) => {
      if (wanted && typeof wanted === 'object') {
        if (!actual || typeof actual !== 'object') return false
        return Object.entries(wanted).every(([key, expectedValue]) => matches(actual[key], expectedValue))
      }
      return Object.is(actual, wanted)
    }
    if (!matches(value, expected)) throw new AgentError('ERR_SCENARIO_ASSERTION', `Scenario step ${index} assertion failed`, { cause: { actual: value, expected } })
  }
  try {
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step.op !== 'string') throw new AgentError('ERR_SCENARIO_INVALID', `Scenario step ${index} requires an op`)
    if (step.op === 'state') {
      const value = await preview.request('/api/state'); assertExpected(value, step.expect, index); results.push({ index, op: step.op, value })
    } else if (step.op === 'snapshot') {
      const value = await preview.request('/api/snapshot'); assertExpected(value, step.expect, index); results.push({ index, op: step.op, value })
    } else if (step.op === 'bridge') {
      const state = await preview.request('/api/state')
      if (state.status !== 'ready' || typeof state.sessionId !== 'string') throw new AgentError('ERR_SCENARIO_RUNTIME_NOT_READY', 'Simulator runtime is not ready for bridge requests')
      const input = step.request ?? {}
      const messages = (Array.isArray(input.messages) ? input.messages : [input]).map(message => structuredClone(message))
      const requestIds = messages.map(message => {
        if (!message || typeof message.op !== 'string') throw new AgentError('ERR_SCENARIO_INVALID', `Scenario step ${index} bridge request requires an op`)
        if (message.sessionId && message.sessionId !== state.sessionId) throw new AgentError('ERR_SCENARIO_SESSION', 'Bridge request belongs to a different simulator session')
        message.protocolVersion ??= '1.0'
        message.sessionId = state.sessionId
        message.requestId ??= randomUUID()
        message.kind ??= 'request'
        message.payload ??= {}
        return message.requestId
      })
      const requiresPreviewFence = messages.some(message => message.op.startsWith('view.'))
      const scenarioClientId = step.clientId ?? scenario.clientId ?? `container-agent-${randomUUID().slice(0, 12)}`
      const lease = requiresPreviewFence
        ? await ensureScenarioLease(preview, state, scenarioClientId, step.timeoutMs ?? 10_000, options.signal)
        : { state, fence: null, created: false }
      if (lease.created) scenarioLeases.add(scenarioClientId)
      if (requiresPreviewFence) {
        for (const message of messages) {
          if (message.preview && JSON.stringify(message.preview) !== JSON.stringify(lease.fence)) {
            throw new AgentError('ERR_SCENARIO_PREVIEW_FENCE', `Scenario step ${index} contains a preview fence that does not match the current lease`)
          }
          delete message.preview
        }
      }
      const request = Array.isArray(input.messages)
        ? { ...input, messages, ...(lease.fence ? { preview: lease.fence } : {}) }
        : { ...messages[0], ...(lease.fence ? { preview: lease.fence } : {}) }
      let queued
      const trigger = () => preview.request('/api/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }).then(value => { queued = value; return value })
      const value = await waitForBridgeEvent(preview, messages, state.sessionId, step.timeoutMs ?? 10_000, trigger, options.signal)
      if (!queued?.queued && !queued?.messages) throw new AgentError('ERR_SCENARIO_BRIDGE', 'Bridge request did not produce a simulator receipt', { cause: queued })
      if (!step.expect && value?.messages && value.messages.some(message => message.kind === 'response' && (message.payload?.ok === false || message.payload?.error?.code))) {
        throw new AgentError('ERR_SCENARIO_BRIDGE_REJECTED', 'Simulator rejected the bridge request', { cause: value })
      }
      assertExpected(value, step.expect, index); results.push({ index, op: step.op, requestIds, value })
    } else if (step.op === 'wait') {
      const waitedMs = Number(step.ms ?? 100)
      await sleep(waitedMs, options.signal)
      results.push({ index, op: step.op, waitedMs })
    } else if (step.op === 'browser') {
      if (!browserState) {
        const status = await preview.status()
        if (!status.url) throw new AgentError('ERR_PREVIEW_UNAVAILABLE', 'Preview is not running')
        browserState = { browser: await browserLaunch(root, scenario.browser), context: null, page: null, baseUrl: status.url }
        const viewport = scenario.browser?.viewport
        if (viewport && (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || viewport.width < 1 || viewport.height < 1)) {
          throw new AgentError('ERR_SCENARIO_INVALID', 'browser.viewport requires positive integer width and height')
        }
        browserState.context = await browserState.browser.newContext({ viewport: viewport ?? { width: 1280, height: 720 } })
        browserState.page = await browserState.context.newPage()
        await browserState.page.goto(status.url, { waitUntil: 'domcontentloaded' })
      }
      const value = await runBrowserStep(browserState, step, root, artifactRoot, step.timeoutMs ?? scenario.timeoutMs ?? 10_000)
      assertExpected(value, step.expect, index)
      results.push({ index, op: step.op, value })
    }
    else throw new AgentError('ERR_SCENARIO_UNSUPPORTED', `Unsupported scenario operation: ${step.op}`)
  }
  return { schemaVersion: 1, name: scenario.name ?? 'unnamed', status: 'passed', steps: results, finishedAt: now() }
  } finally {
    if (browserState) await browserState.browser.close().catch(() => {})
    for (const clientId of scenarioLeases) {
      const state = await preview.request('/api/state').catch(() => null)
      if (state?.preview?.ownerClientId !== clientId) continue
      await preview.request('/api/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: '1.0', requestId: `agent-release-${randomUUID()}`, clientId, op: 'release', epoch: state.preview.epoch }),
      }).catch(() => {})
    }
  }
}

async function ensureScenarioLease(preview, state, clientId, timeoutMs, signal) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) throw new AgentError('ERR_SCENARIO_PREVIEW_CLIENT', `Invalid scenario preview client id: ${clientId}`)
  const currentOwner = state.preview?.ownerClientId
  if (currentOwner && currentOwner !== clientId) throw new AgentError('ERR_SCENARIO_PREVIEW_BUSY', `Preview is owned by ${currentOwner}`)
  if (currentOwner !== clientId) {
    await preview.request('/api/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.0', requestId: `agent-connect-${randomUUID()}`, clientId, op: 'connect' }),
      signal,
    })
  }
  const ready = await waitForState(preview, value => value.status === 'ready' && value.preview?.ownerClientId === clientId, timeoutMs, signal, 'ERR_SCENARIO_PREVIEW_TIMEOUT')
  const authority = ready.viewAuthority ?? {}
  const epoch = ready.preview?.epoch
  if (typeof epoch !== 'string') throw new AgentError('ERR_SCENARIO_PREVIEW_FENCE', 'Simulator did not expose a preview epoch')
  return {
    state: ready,
    created: currentOwner !== clientId,
    fence: {
      clientId,
      epoch,
      ...(typeof authority.revision === 'string' ? { requestRevision: authority.revision } : {}),
    },
  }
}

async function waitForState(preview, predicate, timeoutMs, signal, timeoutCode) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new AgentError('ERR_CANCELLED', 'Scenario cancelled')
    const state = await preview.request('/api/state', { signal })
    if (predicate(state)) return state
    await sleep(100, signal)
  }
  throw new AgentError(timeoutCode, `Simulator did not reach the expected state within ${timeoutMs}ms`)
}

async function waitForBridgeEvent(preview, requests, sessionId, timeoutMs, trigger, externalSignal) {
  const status = await preview.status()
  if (!status.url) throw new AgentError('ERR_PREVIEW_UNAVAILABLE', 'Preview is not running')
  const timeoutController = new AbortController()
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutController.signal]) : timeoutController.signal
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
  try {
    const response = await fetch(new URL('/api/events', status.url), { signal })
    if (!response.ok || !response.body) throw new AgentError('ERR_SCENARIO_EVENTS', `Event stream HTTP ${response.status}`)
    await trigger()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n'); buffer = events.pop() ?? ''
      for (const event of events) {
        const type = event.match(/^event:[ \t]*(\S[^\r\n]*)$/m)?.[1]
        const data = event.match(/^data:[ \t]*(\S[^\r\n]*)$/m)?.[1]
        if (type !== 'bridge' || !data) continue
        let payload; try { payload = JSON.parse(data) } catch { continue }
        const messages = Array.isArray(payload?.messages) ? payload.messages : [payload]
        const responses = requests.every(request => messages.some(message =>
          message?.kind === 'response' && message?.requestId === request.requestId
          && message?.sessionId === sessionId && message?.op === request.op,
        ))
        if (responses) return payload
      }
    }
    throw new AgentError('ERR_SCENARIO_EVENTS', `Bridge response event not observed for requests ${requests.map(request => request.requestId).join(', ')}`)
  } catch (error) {
    if (externalSignal?.aborted) throw externalSignal.reason ?? new AgentError('ERR_CANCELLED', 'Scenario cancelled')
    if (timeoutController.signal.aborted) throw new AgentError('ERR_SCENARIO_TIMEOUT', `Timed out waiting for bridge requests ${requests.map(request => request.requestId).join(', ')}`)
    throw error
  } finally { clearTimeout(timer); timeoutController.abort() }
}

export function toolCatalog() {
  return [
    ['container_project_init', 'Initialize local agent state for a mini-program project.', { projectPath: { type: 'string' } }],
    ['container_project_inspect', 'Inspect a local mini-program project.', { projectPath: { type: 'string' } }],
    ['container_project_files', 'List source files available to the coding agent.', { projectPath: { type: 'string' } }],
    ['container_project_file_read', 'Read a project-relative source file.', { projectPath: { type: 'string' }, path: { type: 'string' } }],
    ['container_project_file_write', 'Write a project-relative source file atomically.', { projectPath: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' } }],
    ['container_build', 'Build a project for one compiler target and create a portable pack for weapp output.', { projectPath: { type: 'string' }, platform: { type: 'string' }, wvBin: { type: 'string' }, timeoutMs: { type: 'number' } }],
    ['container_preview_start', 'Start a local Web simulator preview from project sources.', { projectPath: { type: 'string' }, packDirectory: { type: 'string' }, surface: { type: 'string' }, renderer: { type: 'string' }, port: { type: 'number' }, timeoutMs: { type: 'number' }, simulatorCommand: { type: 'string' }, simulatorPrefix: { type: 'array', items: { type: 'string' } } }],
    ['container_preview_status', 'Read preview status and simulator state.', { projectPath: { type: 'string' } }],
    ['container_preview_stop', 'Stop the preview owned by this project session.', { projectPath: { type: 'string' } }],
    ['container_preview_snapshot', 'Read a preview state or snapshot endpoint.', { projectPath: { type: 'string' }, resource: { type: 'string' } }],
    ['container_test_start', 'Run a deterministic scenario against the current preview.', { projectPath: { type: 'string' }, scenario: { type: 'object' } }],
    ['container_job_status', 'Read a job status.', { projectPath: { type: 'string' }, jobId: { type: 'string' } }],
    ['container_job_events', 'Read durable job events.', { projectPath: { type: 'string' }, jobId: { type: 'string' } }],
    ['container_job_cancel', 'Cancel a running agent job.', { projectPath: { type: 'string' }, jobId: { type: 'string' } }],
    ['container_test_cancel', 'Cancel a running test job.', { projectPath: { type: 'string' }, jobId: { type: 'string' } }],
    ['container_release_prepare', 'Create a local versioned release artifact.', { projectPath: { type: 'string' }, version: { type: 'string' } }],
    ['container_release_commit', 'Commit a verified local release after explicit confirmation.', { projectPath: { type: 'string' }, version: { type: 'string' }, confirmed: { type: 'boolean' } }],
    ['container_release_list', 'List local releases and current version.', { projectPath: { type: 'string' } }],
    ['container_release_rollback', 'Switch the current local release pointer after explicit confirmation.', { projectPath: { type: 'string' }, version: { type: 'string' }, confirmed: { type: 'boolean' } }],
    ['container_release_publish', 'Publish a committed release through the configured mini-program upload provider.', { projectPath: { type: 'string' }, version: { type: 'string' }, platform: { type: 'string' }, description: { type: 'string' }, privateKeyPath: { type: 'string' }, wvBin: { type: 'string' }, timeoutMs: { type: 'number' }, confirmed: { type: 'boolean' } }],
  ].map(([name, description, properties]) => ({ name, description, inputSchema: { type: 'object', properties, additionalProperties: false } }))
}

export async function callTool(name, args = {}) {
  const root = resolve(args.projectPath ?? process.cwd())
  if (name === 'container_project_init') return initProject(root)
  if (name === 'container_project_inspect') return inspectProject(root)
  if (name === 'container_project_files') return listProjectFiles(root)
  if (name === 'container_project_file_read') return readProjectFile(root, args.path)
  if (name === 'container_project_file_write') return writeProjectFile(root, args.path, args.content)
  if (name === 'container_build') return buildProject(root, args)
  if (name === 'container_preview_start') {
    const preview = new PreviewStore(root)
    return preview.start(args)
  }
  if (name === 'container_preview_status') return new PreviewStore(root).status()
  if (name === 'container_preview_stop') return new PreviewStore(root).stop()
  if (name === 'container_preview_snapshot') return new PreviewStore(root).request(args.resource === 'state' ? '/api/state' : '/api/snapshot')
  const jobs = jobStoreFor(root)
  if (name === 'container_test_start') {
    const preview = new PreviewStore(root)
    return jobs.start('test', { scenario: args.scenario ?? {} }, async (job, signal) => {
      let ownedPreview = false
      const before = await preview.status()
      if (before.status === 'closed') { await preview.start({ ...(args.preview ?? {}), signal }); ownedPreview = true }
      if (before.status === 'unknown') throw new AgentError('ERR_PREVIEW_STATE_UNKNOWN', 'An existing preview session cannot be authenticated')
      try {
        await waitForPreviewReady(preview, args.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal)
        return await runScenario({ request: (path, options) => preview.request(path, { ...options, signal }), status: () => preview.status() }, args.scenario, { signal, projectRoot: root, jobId: job.jobId, artifactRoot: join(root, '.weapp-container', 'agent', 'artifacts', job.jobId) })
      } finally {
        if (ownedPreview) await preview.stop().catch(() => {})
      }
    })
  }
  if (name === 'container_job_status') return jobs.status(args.jobId)
  if (name === 'container_job_events') return jobs.events(args.jobId)
  if (name === 'container_job_cancel' || name === 'container_test_cancel') return jobs.cancel(args.jobId)
  if (name === 'container_release_prepare') return prepareRelease(root, args.version, args)
  if (name === 'container_release_commit') return commitRelease(root, args.version, { confirmed: args.confirmed })
  if (name === 'container_release_list') return listReleases(root)
  if (name === 'container_release_rollback') return rollbackRelease(root, args.version, { confirmed: args.confirmed })
  if (name === 'container_release_publish') {
    return jobs.start('release-publish', {
      version: args.version,
      platform: args.platform ?? 'weapp',
      description: args.description ?? null,
    }, async (_job, signal) => publishRelease(root, args.version, { ...args, signal }))
  }
  throw new AgentError('ERR_TOOL_NOT_FOUND', `Unknown tool: ${name}`)
}

export async function serveMcp(
  projectRoot = process.cwd(),
  input: AsyncIterable<{ toString(): string }> = process.stdin,
  output: { write(chunk: string): unknown } = process.stdout,
) {
  const tools = toolCatalog()
  let buffer = ''
  for await (const chunk of input) {
    buffer += chunk.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let request
      try { request = JSON.parse(line) } catch {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`)
        continue
      }
      if (request.method?.startsWith('notifications/')) continue
      if (request.id === undefined) continue
      const response = { jsonrpc: '2.0', id: request.id }
      try {
        if (request.method === 'initialize') response.result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'weapp-container-agent', version: '0.1.0' } }
        else if (request.method === 'tools/list') response.result = { tools }
        else if (request.method === 'tools/call') {
          const result = await callTool(request.params?.name, { projectPath: projectRoot, ...(request.params?.arguments ?? {}) })
          response.result = { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
        } else throw new AgentError('ERR_METHOD_NOT_FOUND', `Unsupported MCP method: ${request.method}`)
      } catch (error) {
        if (request.method === 'tools/call') {
          const errorValue = { code: error?.code ?? 'ERR_MCP', message: error?.message ?? String(error) }
          response.result = {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(errorValue) }],
            structuredContent: errorValue,
          }
        } else {
          response.error = { code: -32000, message: error?.message ?? String(error), data: { code: error?.code ?? 'ERR_MCP' } }
        }
      }
      output.write(`${JSON.stringify(response)}\n`)
    }
  }
}
