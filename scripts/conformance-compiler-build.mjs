import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE = fileURLToPath(import.meta.url)
const EXECUTOR_BYTES = readFileSync(MODULE)
const HASH = /^[a-f0-9]{64}$/
const OID = /^[a-f0-9]{40}$/
const CORE_FILTERS = ['!@weapp-vite/dimina-playground', './packages/*', './packages-runtime/*', './benchmarks/*', './packages-private/*', './@weapp-core/*', './mpcore/packages/*', './extensions/*']
export const COMPILER_BUILD_PROFILE = 'weapp-vite-core-v1'
export const COMPILER_BUILD_COMMAND = ['exec', 'turbo', 'run', 'build', '--force', ...CORE_FILTERS.map(value => `--filter=${value}`)]
export function compilerBuildEnvironment(packageManager, nodeExecutable = process.execPath) {
  return { PATH: [dirname(realpathSync(packageManager)), dirname(nodeExecutable), '/usr/bin', '/bin'].join(':'),
    CI: '1', NODE_OPTIONS: '', NODE_PATH: '', TURBO_FORCE: 'true', TURBO_TELEMETRY_DISABLED: '1', COREPACK_ENABLE_PROJECT_SPEC: '0' }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const gitHash = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex')
const require = (condition, message) => { if (!condition) throw new Error(message) }
const canonical = value => JSON.stringify(value)
const slash = value => value.split(sep).join('/')
const within = (root, file) => file === root || file.startsWith(root + sep)
function safePath(path) {
  require(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\')
    && !path.split('/').some(part => !part || part === '.' || part === '..') && !path.includes('\0'), `unsafe archive/member path: ${path}`)
  return path
}
function git(directory, args, options = {}) {
  return execFileSync('git', args, { cwd: directory, maxBuffer: 1024 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options })
}
function cleanTracked(directory, commit) {
  require(git(directory, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === commit, 'source Git HEAD differs from the requested compiler pin')
  require(git(directory, ['status', '--porcelain=v1', '--untracked-files=no'], { encoding: 'utf8' }).trim() === '', 'dirty compiler source: tracked changes are forbidden')
}

/** CAS references use the conformance evidence root, never a live checkout. */
export function archiveCompilerBuildBytes({ root, directory, bytes }) {
  root = resolve(root); directory = resolve(directory)
  require(within(root, directory) && directory !== root, 'compiler archive must be inside the evidence root')
  bytes = Buffer.from(bytes)
  const sha256 = hash(bytes)
  const file = join(directory, 'objects', 'sha256', sha256)
  mkdirSync(dirname(file), { recursive: true })
  require(within(realpathSync(root), realpathSync(dirname(file))), 'archive CAS directory escapes the evidence root')
  try { writeFileSync(file, bytes, { flag: 'wx' }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    require(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() && hash(readFileSync(file)) === sha256, 'archive CAS object changed')
  }
  return { path: slash(relative(root, file)), sha256, bytes: bytes.length }
}

function parseTree(bytes) {
  const entries = []
  let offset = 0
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset), zero = bytes.indexOf(0, space + 1)
    require(space > offset && zero > space && zero + 21 <= bytes.length, 'invalid archived Git tree')
    const mode = bytes.subarray(offset, space).toString('utf8')
    const name = bytes.subarray(space + 1, zero).toString('utf8')
    require(name && !['.', '..'].includes(name) && !name.includes('/') && !name.includes('\\'), 'unsafe Git tree member')
    entries.push({ mode, name, oid: bytes.subarray(zero + 1, zero + 21).toString('hex') })
    offset = zero + 21
  }
  return entries
}

/** Archive the complete pinned Git object closure without copying .git/history.
 * Commit and raw tree objects let the offline reader recompute the exact pin;
 * source blobs are archived by content and compared to every tree leaf. */
export function archivePinnedCompilerSource({ root, directory, source, commit }) {
  require(OID.test(commit), 'compiler pin must be a full SHA-1 commit')
  source = realpathSync(source)
  cleanTracked(source, commit)
  const entries = git(source, ['ls-tree', '-r', '-t', '-z', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t'), [mode, kind, oid] = record.slice(0, tab).split(' ')
    const path = safePath(record.slice(tab + 1))
    require(kind !== 'commit' && mode !== '160000', `compiler source gitlink requires its own build closure: ${path}`)
    require(kind === 'tree' || ['100644', '100755', '120000'].includes(mode), `unsupported compiler source mode: ${path}`)
    return { mode, kind, oid, path }
  })
  const tree = git(source, ['rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).trim()
  const objects = [...new Map([{ oid: commit, kind: 'commit' }, { oid: tree, kind: 'tree' }, ...entries].map(entry => [entry.oid, entry])).values()]
  const batch = git(source, ['cat-file', '--batch'], { input: objects.map(entry => entry.oid).join('\n') + '\n' })
  const archived = new Map()
  let offset = 0
  for (const entry of objects) {
    const newline = batch.indexOf(10, offset)
    require(newline !== -1, 'truncated Git object header')
    const [oid, kind, size] = batch.subarray(offset, newline).toString('utf8').split(' ')
    const bytes = batch.subarray(newline + 1, newline + 1 + Number(size))
    require(oid === entry.oid && kind === entry.kind && bytes.length === Number(size) && gitHash(kind, bytes) === oid, 'source Git object differs while archiving')
    archived.set(oid, archiveCompilerBuildBytes({ root, directory, bytes }))
    offset = newline + 1 + Number(size) + 1
  }
  cleanTracked(source, commit)
  const record = { commit, tree, commitObject: archived.get(commit),
    trees: [{ path: '', oid: tree, artifact: archived.get(tree) }, ...entries.filter(e => e.kind === 'tree').map(e => ({ path: e.path, oid: e.oid, artifact: archived.get(e.oid) }))],
    files: entries.filter(e => e.kind === 'blob').map(e => ({ path: e.path, mode: e.mode, oid: e.oid, artifact: archived.get(e.oid) })) }
  validatePinnedWorkingTree(source, record, true)
  return record
}

export function compilerBuildSourceIdentity(source) {
  return hash(Buffer.from(JSON.stringify({ files: source.files.map(file => ({ path: file.path, mode: file.mode, oid: file.oid, sha256: file.artifact.sha256 })), checkoutTransforms: source.checkoutTransforms ?? [] })))
}

function crlf(bytes) {
  const result = []
  for (let i = 0; i < bytes.length; i++) { if (bytes[i] === 10 && bytes[i - 1] !== 13) result.push(13); result.push(bytes[i]) }
  return Buffer.from(result)
}

function validatePinnedWorkingTree(checkout, source, captureTransforms = false) {
  const transforms = []

  for (const file of source.files) {
    const path = join(checkout, file.path), stat = lstatSync(path)
    require(file.mode === '120000' ? stat.isSymbolicLink() : stat.isFile() && !stat.isSymbolicLink(), `dirty compiler source member type: ${file.path}`)
    const bytes = file.mode === '120000' ? Buffer.from(readlinkSync(path)) : readFileSync(path)
    if (gitHash('blob', bytes) !== file.oid || hash(bytes) !== file.artifact.sha256) {
      const expected = (source.checkoutTransforms ?? []).find(item => item.path === file.path)
      if (captureTransforms) {
        // Git's pinned built-in eol=crlf checkout is a deterministic text
        // transform, not a source edit. No external clean/smudge filter runs.
        const attributes = git(checkout, ['check-attr', '-z', 'text', 'eol', '--', file.path]).toString('utf8').split('\0')
        require(attributes[2] === 'set' && attributes[5] === 'crlf', `dirty compiler source bytes: ${file.path}`)
        const raw = git(checkout, ['cat-file', 'blob', file.oid])
        require(bytes.equals(crlf(raw)), `dirty compiler source bytes: ${file.path}`)
        transforms.push({ path: file.path, kind: 'git-text-crlf', sha256: hash(bytes), bytes: bytes.length })
      } else require(expected && expected.kind === 'git-text-crlf' && expected.sha256 === hash(bytes) && expected.bytes === bytes.length, `dirty compiler source bytes: ${file.path}`)
    } else require(captureTransforms || !(source.checkoutTransforms ?? []).some(item => item.path === file.path), `compiler checkout text transform changed: ${file.path}`)
    if (file.mode === '120000') require(within(checkout, realpathSync(path)), `tracked source symlink escapes owned compiler checkout: ${file.path}`)
  }
  if (captureTransforms) source.checkoutTransforms = transforms
  return compilerBuildSourceIdentity(source)
}

// Read the pinned pnpm workspace's simple package-pattern list without using
// an installed YAML parser. Unsupported YAML fails rather than broadening it.
export function compilerBuildWorkspaceManifests(sourceFiles, read) {
  const available = sourceFiles.filter(file => file.path.endsWith('package.json'))
  const workspace = sourceFiles.find(file => file.path === 'pnpm-workspace.yaml')
  if (!workspace) return available.filter(file => file.path === 'package.json')
  const lines = read(workspace).toString('utf8').split(/\r?\n/)
  const start = lines.findIndex(line => line === 'packages:')
  require(start >= 0, 'pinned pnpm workspace package list is missing')
  const patterns = []
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) break
    const match = /^  - (?:'([^']+)'|"([^"]+)"|([^#'"\s][^#]*?))\s*$/.exec(line)
    require(match, 'unsupported pinned workspace package pattern')
    patterns.push((match[1] ?? match[2] ?? match[3]).trim())
  }
  const matches = (pattern, path) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\u0001').replaceAll('*', '[^/]*').replaceAll('\u0001', '.*')
    return new RegExp(`^${escaped}$`).test(path)
  }
  return available.filter(file => file.path === 'package.json' || patterns.some(p => !p.startsWith('!') && matches(p, slash(dirname(file.path))))
    && !patterns.some(p => p.startsWith('!') && matches(p.slice(1), slash(dirname(file.path)))))
}

export function compilerBuildDependencyDeclarations(sourceFiles, read) {
  const result = []
  for (const from of compilerBuildWorkspaceManifests(sourceFiles, read)) {
    const pkg = JSON.parse(read(from))
    const optional = pkg.optionalDependencies ?? {}
    for (const [specifier, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...optional })) {
      require(typeof range === 'string', 'unsupported compiler dependency range')
      const alias = /^npm:((?:@[^/]+\/)?[^@]+)(?:@.*)?$/.exec(range)
      result.push({ from: from.path, specifier, range, optional: Object.hasOwn(optional, specifier), packageName: alias?.[1] ?? specifier })
    }
  }
  return result
}

function defaultRead(root, reference) {
  const path = safePath(reference?.path)
  const target = resolve(root, path), actual = realpathSync(target), owner = realpathSync(root)
  require(within(owner, actual) && lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink(), `archive reference escapes root or is not a regular file: ${path}`)
  return readFileSync(actual)
}

/** Fail-closed, synchronous and offline. Callers may cache this result once per
 * compilerBuild reference for a 172-case run. An optional artifact loader must
 * return bytes; content checks are still performed here for every reference.
 * This is an integrity/provenance receipt, not a signature or a hermetic-build
 * claim: the local build executor and recorded host toolchain remain trusted. */
export function inspectCompilerBuildEvidence({ root, reference, expectedCommit, loadArtifact, expectedProfile = COMPILER_BUILD_PROFILE }) {
  const errors = [], references = new Map()
  let attestation = null
  const load = (ref, label) => {
    require(ref && safePath(ref.path) && HASH.test(ref.sha256) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0, `invalid compiler ${label} reference`)
    const bytes = Buffer.from(loadArtifact ? loadArtifact(ref, `compiler ${label}`, false) : defaultRead(root, ref))
    require(bytes.length === ref.bytes && hash(bytes) === ref.sha256, `compiler ${label} content hash/size differs`)
    const previous = references.get(ref.path)
    require(!previous || canonical(previous) === canonical(ref), 'one compiler artifact path has conflicting identities')
    references.set(ref.path, ref)
    return bytes
  }
  try {
    require(reference, 'official compiler build evidence is required; retained dist is unverified')
    require(OID.test(expectedCommit), 'expected compiler Git pin is required')
    attestation = JSON.parse(load(reference, 'attestation'))
    require(attestation.schemaVersion === 1 && attestation.kind === 'weapp-container.compiler-build', 'unsupported compiler build attestation')
    require(attestation.status === 'built' && attestation.profile === expectedProfile, 'compiler build is failed, diagnostic, or uses an unapproved build profile')
    const { source, build, dependencies, outputs, producer } = attestation
    require(source?.commit === expectedCommit && OID.test(source.tree), 'compiler build source differs from the official Git pin')
    const commitBytes = load(source.commitObject, 'Git commit')
    require(gitHash('commit', commitBytes) === expectedCommit && commitBytes.toString('utf8').startsWith(`tree ${source.tree}\n`), 'archived compiler Git commit/tree is not the expected pin')
    const trees = new Map(), files = new Map()
    require(Array.isArray(source.trees) && source.trees.length && Array.isArray(source.files) && source.files.length, 'complete compiler source closure is missing')
    for (const item of source.trees) {
      require(item.path === '' || safePath(item.path), 'invalid compiler tree path')
      require(!trees.has(item.path) && OID.test(item.oid), 'duplicate compiler Git tree')
      const bytes = load(item.artifact, `Git tree ${item.path}`)
      require(gitHash('tree', bytes) === item.oid, 'compiler Git tree hash differs')
      trees.set(item.path, { ...item, entries: parseTree(bytes) })
    }
    for (const item of source.files) {
      safePath(item.path)
      require(!files.has(item.path) && ['100644', '100755', '120000'].includes(item.mode), 'duplicate or unsupported compiler source member')
      const bytes = load(item.artifact, `source ${item.path}`)
      require(gitHash('blob', bytes) === item.oid, 'compiler source blob differs from its Git identity')
      files.set(item.path, { ...item, bytes: item.path.endsWith('package.json') || item.path === 'pnpm-workspace.yaml' ? bytes : undefined })
    }
    require(trees.get('')?.oid === source.tree, 'root compiler Git tree missing')
    const visitedTrees = new Set(), visitedFiles = new Set()
    const visit = path => {
      require(!visitedTrees.has(path), 'compiler Git tree cycle/duplicate')
      visitedTrees.add(path)
      const tree = trees.get(path)
      require(tree, `compiler tree closure missing ${path}`)
      const names = new Set()
      for (const entry of tree.entries) {
        require(!names.has(entry.name), 'duplicate Git tree member'); names.add(entry.name)
        const member = path ? `${path}/${entry.name}` : entry.name
        if (entry.mode === '40000') {
          require(trees.get(member)?.oid === entry.oid, `compiler child tree omitted: ${member}`)
          visit(member)
        } else {
          const file = files.get(member)
          require(file && file.oid === entry.oid && file.mode === entry.mode, `compiler source closure omitted: ${member}`)
          visitedFiles.add(member)
        }
      }
    }
    visit('')
    require(visitedTrees.size === trees.size && visitedFiles.size === files.size, 'compiler source archive includes unbound members')
    require(Array.isArray(source.checkoutTransforms), 'compiler checkout text transform inventory is missing')
    const transformPaths = new Set()
    for (const item of source.checkoutTransforms) {
      require(item.kind === 'git-text-crlf' && files.has(item.path) && !transformPaths.has(item.path), 'unsupported or duplicate compiler checkout transform')
      transformPaths.add(item.path)
      const bytes = crlf(load(files.get(item.path).artifact, `checkout transform ${item.path}`))
      require(hash(bytes) === item.sha256 && bytes.length === item.bytes, 'compiler checkout transform is not bound to Git source bytes')
    }
    require(producer?.name === 'conformance-compiler-build.mjs', 'unrecognized compiler build producer')
    require(hash(load(producer.artifact, 'executor')) === hash(EXECUTOR_BYTES), 'compiler build executor differs from this reviewed implementation')
    require(build?.ownerId && /^[0-9a-f-]{36}$/.test(build.ownerId) && build.detached === true, 'owned detached compiler build identity is missing')
    const before = JSON.parse(load(build.before, 'pre-build guard'))
    const after = JSON.parse(load(build.after, 'post-build guard'))
    require(before.commit === expectedCommit && after.commit === expectedCommit && before.trackedDirty === '' && after.trackedDirty === '' && before.sourceIdentity === compilerBuildSourceIdentity(source) && after.sourceIdentity === compilerBuildSourceIdentity(source), 'compiler source guard is dirty or unbound')
    require(Array.isArray(before.absentOutputs) && before.absentOutputs.length && before.absentOutputs.every(safePath), 'fresh output absence guard is missing')
    require(before.ownerId === build.ownerId && after.ownerId === build.ownerId, 'compiler guard owner differs')
    require(build.environment?.NODE_OPTIONS === '' && build.environment?.NODE_PATH === '' && build.environment?.TURBO_FORCE === 'true', 'compiler build environment can borrow loaders or cached output')
    require(Array.isArray(build.commands) && build.commands.length === 2 && build.commands[0].phase === 'install' && build.commands[1].phase === 'build', 'successful install and fresh build commands are required')
    const times = []
    for (const command of build.commands) {
      require(command.exitCode === 0 && command.signal === null && Array.isArray(command.argv) && command.argv.length > 1 && command.cwd === '.', 'compiler command failed or has an unsupported cwd')
      const start = Date.parse(command.startedAt), finish = Date.parse(command.finishedAt)
      require(Number.isFinite(start) && Number.isFinite(finish) && finish >= start, 'invalid compiler command timestamps')
      times.push([start, finish])
      load(command.stdout, `${command.phase} stdout`); load(command.stderr, `${command.phase} stderr`)
      const execution = JSON.parse(load(command.execution, `${command.phase} process result`))
      require(canonical(execution) === canonical({ ownerId: build.ownerId, phase: command.phase, argv: command.argv, cwd: command.cwd,
        startedAt: command.startedAt, finishedAt: command.finishedAt, exitCode: command.exitCode, signal: command.signal,
        stdout: command.stdout, stderr: command.stderr }), 'compiler command is not bound to its process receipt')
    }
    require(times[0][1] <= times[1][0], 'compiler build preceded dependency installation')
    const rootPackage = JSON.parse(files.get('package.json')?.bytes ?? 'null')
    require(rootPackage && dependencies?.packageManager === rootPackage.packageManager, 'compiler dependency manager differs from the pinned package metadata')
    if (expectedProfile === COMPILER_BUILD_PROFILE) {
      require(/^pnpm@\d+\.\d+\.\d+$/.test(rootPackage.packageManager), 'pinned compiler package manager is unsupported')
      require(dependencies.packageManagerVersion === rootPackage.packageManager.slice(5), 'actual compiler package manager version differs from the pin')
      const install = build.commands[0].argv, compile = build.commands[1].argv
      require(install.length === 6 && canonical(install.slice(1, 5)) === canonical(['install', '--frozen-lockfile', '--ignore-scripts', '--store-dir']) && isAbsolute(install[5]), 'compiler install did not use the frozen lock and an owned store')
      require(canonical(compile.slice(1)) === canonical(COMPILER_BUILD_COMMAND) && compile[0] === install[0], 'compiler command did not force the reviewed pinned build closure')
      require(files.has('pnpm-lock.yaml') && dependencies.lock.path === 'pnpm-lock.yaml', 'pinned compiler lock is missing')
    }
    const lock = files.get(dependencies?.lock?.path)
    require(lock && canonical(lock.artifact) === canonical(dependencies.lock.artifact), 'compiler dependency lock differs from source')
    const inventory = JSON.parse(load(dependencies.inventory, 'dependency closure'))
    require(inventory.schemaVersion === 1 && inventory.ownerId === build.ownerId && Array.isArray(inventory.entries), 'compiler dependency closure is missing')
    const installed = new Map(), directories = new Set([''])
    const addParents = path => { for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) directories.add(slash(parent)) }
    for (const path of files.keys()) addParents(path)
    for (const item of inventory.entries) {
      safePath(item.path); require(!installed.has(item.path) && !files.has(item.path), 'duplicate or source-shadowing dependency member')
      addParents(item.path)
      if (item.kind === 'file') {
        require(typeof item.executable === 'boolean', 'compiler dependency executable mode is missing')
        load(item.artifact, `dependency ${item.path}`)
      }
      else require(item.kind === 'link' && safePath(item.target), 'unsupported or escaping compiler dependency link')
      installed.set(item.path, item)
    }
    // Every link must terminate inside the archived owned source/dependency
    // tree. A vendor symlink or an omitted transitive target fails offline.
    const sourceLinks = new Map()
    for (const file of files.values()) if (file.mode === '120000') {
      const target = load(file.artifact, `source symlink ${file.path}`).toString('utf8')
      const owner = '/owned-compiler-source'
      const resolved = resolve(owner, dirname(file.path), target)
      require(!isAbsolute(target) && within(owner, resolved), 'compiler source symlink escapes its owned tree')
      sourceLinks.set(file.path, slash(relative(owner, resolved)))
    }
    const resolveLink = (path, trail = new Set(), allowMissing = false) => {
      const parts = path.split('/')
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/'), item = installed.get(prefix)
        const target = item?.kind === 'link' ? item.target : sourceLinks.get(prefix)
        if (target !== undefined) {
          require(!trail.has(prefix), 'cyclic compiler dependency link'); trail.add(prefix)
          return resolveLink([target, ...parts.slice(i)].filter(Boolean).join('/'), trail, allowMissing)
        }
      }
      if (files.has(path) || installed.has(path) || directories.has(path)) return path
      require(allowMissing, `compiler dependency target omitted: ${path}`)
      return null
    }
    const lookupDependency = declaration => {
      let cursor = dirname(declaration.from)
      while (true) {
        const path = `${cursor === '.' ? '' : cursor + '/'}node_modules/${declaration.specifier}/package.json`
        const found = resolveLink(path, new Set(), true)
        if (found !== null) return found
        if (cursor === '.') return null
        cursor = dirname(cursor)
      }
    }
    for (const item of installed.values()) if (item.kind === 'link') resolveLink(item.target)
    require(Array.isArray(dependencies.resolutions), 'workspace resolution proof is missing')
    if (expectedProfile === COMPILER_BUILD_PROFILE) {
      require(installed.size > 0, 'compiler install inventory is empty')
      const modules = installed.get('node_modules/.modules.yaml'), installedLock = installed.get('node_modules/.pnpm/lock.yaml')
      require(modules?.kind === 'file' && installedLock?.kind === 'file', 'owned pnpm install metadata/lock is missing')
      const metadata = load(modules.artifact, 'pnpm installation metadata').toString('utf8')
      const fields = metadata.trimStart().startsWith('{') ? JSON.parse(metadata) : {
        packageManager: /^packageManager: (.+)$/m.exec(metadata)?.[1]?.replace(/^['"]|['"]$/g, ''),
        storeDir: /^storeDir: (.+)$/m.exec(metadata)?.[1]?.replace(/^['"]|['"]$/g, ''),
      }
      require(fields.packageManager === `pnpm@${dependencies.packageManagerVersion}`, 'pnpm installation metadata uses a different package manager')
      const store = fields.storeDir, ownedStore = build.commands[0].argv[5]
      require(isAbsolute(build.checkout) && ownedStore === join(dirname(build.checkout), `${build.ownerId}-pnpm-store`), 'compiler dependency store was not created for this owned build')
      require(store && (store === ownedStore || store.startsWith(ownedStore + '/')), 'pnpm installation reused an external dependency store')
    }
    const declarations = compilerBuildDependencyDeclarations([...files.values()], file => file.bytes)
    const expectedResolutions = new Map(declarations.map(item => [`${item.from}\0${item.specifier}\0${item.range}`, item]))
    const observedResolutions = new Set()
    for (const item of dependencies.resolutions) {
      safePath(item.from)
      const identity = `${item.from}\0${item.specifier}\0${item.range}`
      const declaration = expectedResolutions.get(identity)
      require(declaration && !observedResolutions.has(identity), 'unbound or duplicate dependency resolution')
      observedResolutions.add(identity)
      const lookedUp = lookupDependency(declaration)
      if (item.missing === true) {
        require(lookedUp === null && declaration.optional && !item.range.startsWith('workspace:') && item.packageJson === null, 'nonoptional compiler dependency is missing')
        continue
      }
      safePath(item.packageJson)
      require(item.specifier && files.has(item.from) && (files.has(item.packageJson) || installed.has(item.packageJson)), 'dependency resolution is not bound to owned manifests')
      const target = resolveLink(item.packageJson)
      require(target === lookedUp, 'compiler dependency proof differs from archived Node workspace resolution')
      const manifest = files.get(target)?.bytes ?? load(installed.get(target)?.artifact, `resolved package ${item.specifier}`)
      const pkg = JSON.parse(manifest)
      require(pkg.name === declaration.packageName && typeof pkg.version === 'string' && pkg.version === item.version, 'workspace/dependency resolution reached a different package/version')
    }
    require(observedResolutions.size === expectedResolutions.size, 'compiler dependency resolution closure is incomplete')
    require(Array.isArray(outputs) && outputs.length, 'compiler build produced no archived outputs')
    const outputPaths = new Set()
    for (const item of outputs) {
      safePath(item.path)
      require(!outputPaths.has(item.path) && !files.has(item.path) && before.absentOutputs.some(dir => item.path.startsWith(dir + '/')), 'compiler output was preexisting, duplicated, or outside the fresh build roots')
      load(item.artifact, `output ${item.path}`); outputPaths.add(item.path)
    }
    require(Array.isArray(build.requiredOutputs) && build.requiredOutputs.length && build.requiredOutputs.every(path => outputPaths.has(path)), 'required compiler entry outputs were not built')
    if (expectedProfile === COMPILER_BUILD_PROFILE) require(['packages/weapp-vite/dist/index.mjs', 'packages/weapp-vite/dist/cli.mjs'].every(path => outputPaths.has(path)), 'official compiler entries are missing')
  } catch (error) { errors.push(error.message) }
  return { errors, attestation, artifactReferences: [...references.values()] }
}

export function requireCompilerBuildEvidence(options) {
  const result = inspectCompilerBuildEvidence(options)
  if (result.errors.length) throw new Error(result.errors.join('\n'))
  return result.attestation
}

function snapshotDependencies({ checkout, sourceFiles, put, ownerId }) {
  const entries = [], trackedFiles = new Set(sourceFiles.map(file => file.path))
  const packageFiles = new Set(sourceFiles.filter(f => f.path.endsWith('package.json')).map(f => f.path))
  const walk = (directory, insideDependencies = false) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || (!insideDependencies && ['dist', '.turbo', '.tmp'].includes(entry.name))) continue
      const file = join(directory, entry.name), path = slash(relative(checkout, file))
      // Some pinned tests deliberately commit node_modules fixture files.
      // They already belong to the immutable Git source closure; inventory
      // only install-created members so neither tree can shadow the other.
      if (trackedFiles.has(path)) continue
      const dependency = insideDependencies || entry.name === 'node_modules'
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) {
        const target = realpathSync(file)
        require(within(checkout, target) && !within(join(checkout, '.git'), target), `dependency symlink escapes owned checkout: ${path} -> ${readlinkSync(file)}`)
        if (dependency) entries.push({ path, kind: 'link', target: slash(relative(checkout, target)) })
      } else if (stat.isDirectory()) walk(file, dependency)
      else if (dependency && stat.isFile()) {
        entries.push({ path, kind: 'file', executable: Boolean(stat.mode & 0o111), artifact: put(readFileSync(file)) })
        if (entry.name === 'package.json') packageFiles.add(path)
      } else require(!dependency, `unsupported dependency filesystem entry: ${path}`)
    }
  }
  walk(checkout)
  const resolutions = []
  for (const declaration of compilerBuildDependencyDeclarations(sourceFiles, file => readFileSync(join(checkout, file.path)))) {
    const { from, specifier, range, optional, packageName } = declaration
    let cursor = dirname(join(checkout, from)), found
    while (within(checkout, cursor)) {
      const candidate = join(cursor, 'node_modules', specifier, 'package.json')
      if (existsSync(candidate)) { found = realpathSync(candidate); break }
      if (cursor === checkout) break
      cursor = dirname(cursor)
    }
    if (!found && optional && !range.startsWith('workspace:')) {
      resolutions.push({ from, specifier, range, packageJson: null, missing: true }); continue
    }
    require(found && within(checkout, found), `dependency escapes or is missing: ${from} -> ${specifier}`)
    const packageJson = slash(relative(checkout, found)), pkg = JSON.parse(readFileSync(found))
    require(packageFiles.has(packageJson) && pkg.name === packageName && typeof pkg.version === 'string', `dependency resolution reached unowned/wrong package: ${specifier}`)
    resolutions.push({ from, specifier, range, packageJson, version: pkg.version })
  }
  return { inventory: { schemaVersion: 1, ownerId, entries }, resolutions }
}

async function runCommand({ phase, argv, checkout, environment, timeoutMs, put, ownerId }) {
  const startedAt = new Date().toISOString()
  const stdout = [], stderr = []
  let expired = false, escalation
  const child = spawn(argv[0], argv.slice(1), { cwd: checkout, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes))
  const timer = setTimeout(() => {
    expired = true
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch {}
    escalation = setTimeout(() => {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch {}
    }, 5000)
    escalation.unref()
  }, timeoutMs)
  timer.unref()
  const terminal = await new Promise(resolve => {
    child.once('error', error => { stderr.push(Buffer.from(error.message)); resolve({ exitCode: null, signal: 'spawn-error' }) })
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  clearTimeout(timer); clearTimeout(escalation)
  const execution = { ownerId, phase, argv, cwd: '.', startedAt, finishedAt: new Date().toISOString(),
    exitCode: terminal.exitCode, signal: expired ? 'timeout' : terminal.signal,
    stdout: put(Buffer.concat(stdout)), stderr: put(Buffer.concat(stderr)) }
  return { ...execution, execution: put(JSON.stringify(execution, null, 2) + '\n') }
}

/** Fresh detached builder. It never reads ignored vendor dist/node_modules.
 * The optional fixture profile is test-only and the formal reader rejects it.
 * Failures keep their logs/receipt and owned checkout for diagnosis. */
export async function buildCompilerFromPinnedSource({ root, directory, source, checkout, commit,
  packageManager = 'pnpm', timeoutMs = 20 * 60_000, keepCheckout = true,
  profile = COMPILER_BUILD_PROFILE, fixtureCommands, fixtureOutputDirectories, fixtureRequiredOutputs } = {}) {
  root = resolve(root); directory = resolve(directory); checkout = resolve(checkout); source = realpathSync(source)
  require(within(root, directory) && within(root, checkout) && !within(source, checkout) && !within(checkout, source) && !within(checkout, directory), 'compiler build/archive must be separate owned paths inside evidence root')
  require(!existsSync(checkout) && !existsSync(join(directory, 'compiler-build.json')), 'compiler checkout/attestation already exists; use a new owned directory')
  require(profile === COMPILER_BUILD_PROFILE || profile === 'compiler-fixture-v1', 'unsupported compiler build profile')
  require(profile !== COMPILER_BUILD_PROFILE || !fixtureCommands, 'official compiler build commands cannot be overridden')
  cleanTracked(source, commit)
  await mkdir(dirname(checkout), { recursive: true }); await mkdir(directory, { recursive: true })
  root = realpathSync(root); directory = realpathSync(directory)
  checkout = join(realpathSync(dirname(checkout)), basename(checkout))
  // Inspect physical source bytes as well as Git status (assume-unchanged and
  // skip-worktree flags must not hide modified inputs). Clone only Git blobs.
  archivePinnedCompilerSource({ root, directory, source, commit })
  git(dirname(checkout), ['clone', '--quiet', '--no-hardlinks', '--no-checkout', source, checkout])
  git(checkout, ['checkout', '--quiet', '--detach', commit])
  require(git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim() === 'HEAD', 'compiler checkout must be detached')
  const sourceRecord = archivePinnedCompilerSource({ root, directory, source: checkout, commit })
  const ownerId = randomUUID(), put = bytes => archiveCompilerBuildBytes({ root, directory, bytes })
  const attestation = { schemaVersion: 1, kind: 'weapp-container.compiler-build', profile, status: 'failed',
    producer: { name: 'conformance-compiler-build.mjs', artifact: put(EXECUTOR_BYTES) },
    source: sourceRecord,
    build: { ownerId, detached: true, checkout, commands: [], environment: { NODE_OPTIONS: '', NODE_PATH: '', TURBO_FORCE: 'true' } } }
  const sourceFiles = attestation.source.files
  const outputDirectories = fixtureOutputDirectories ?? sourceFiles.filter(f => /^(?:packages|packages-runtime|packages-private|benchmarks|@weapp-core|extensions|mpcore\/packages)\/[^/]+\/package\.json$/.test(f.path))
    .filter(f => JSON.parse(readFileSync(join(checkout, f.path))).scripts?.build).map(f => `${dirname(f.path)}/dist`)
  const requiredOutputs = fixtureRequiredOutputs ?? ['packages/weapp-vite/dist/index.mjs', 'packages/weapp-vite/dist/cli.mjs']
  const guard = () => ({ ownerId, commit: git(checkout, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    trackedDirty: git(checkout, ['status', '--porcelain=v1', '--untracked-files=no'], { encoding: 'utf8' }).trim(),
    sourceIdentity: validatePinnedWorkingTree(checkout, attestation.source) })
  let failure
  try {
    require(outputDirectories.length && outputDirectories.every(path => safePath(path) && !existsSync(join(checkout, path))), 'owned checkout contains preexisting compiler build outputs')
    const packageData = JSON.parse(readFileSync(join(checkout, 'package.json')))
    const manager = profile === COMPILER_BUILD_PROFILE
      ? execFileSync('which', [packageManager], { encoding: 'utf8' }).trim() : process.execPath
    const managerVersion = profile === COMPILER_BUILD_PROFILE
      ? execFileSync(manager, ['--version'], { cwd: checkout, encoding: 'utf8', env: { PATH: process.env.PATH, CI: '1', COREPACK_ENABLE_PROJECT_SPEC: '0' } }).trim()
      : process.versions.node
    if (profile === COMPILER_BUILD_PROFILE) require(packageData.packageManager === `pnpm@${managerVersion}`, `actual compiler package manager ${managerVersion} differs from pinned ${packageData.packageManager}`)
    const environment = compilerBuildEnvironment(manager)
    if (profile === COMPILER_BUILD_PROFILE) {
      // Turbo starts package tasks through a fresh `pnpm` lookup. The Node
      // installation can contain an unrelated Corepack shim, so bind that
      // lookup to the selected manager's directory before starting any task.
      const childManager = execFileSync('which', ['pnpm'], { env: environment, encoding: 'utf8' }).trim()
      require(dirname(childManager) === dirname(realpathSync(manager)), 'compiler child pnpm lookup escaped the selected package manager directory')
      const childVersion = execFileSync(childManager, ['--version'], { cwd: checkout, env: environment, encoding: 'utf8' }).trim()
      require(childVersion === managerVersion, 'compiler child pnpm version differs from the selected package manager')
    }
    const install = fixtureCommands?.install ?? [manager, 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', join(dirname(checkout), `${ownerId}-pnpm-store`)]
    const compile = fixtureCommands?.build ?? [manager, ...COMPILER_BUILD_COMMAND]
    for (const [phase, argv] of [['install', install], ['build', compile]]) {
      if (phase === 'build') {
        cleanTracked(checkout, commit)
        require(outputDirectories.every(path => !existsSync(join(checkout, path))), 'dependency installation produced compiler outputs before the fresh build')
        attestation.build.before = put(JSON.stringify({ ...guard(), absentOutputs: outputDirectories }, null, 2) + '\n')
        const snapshot = snapshotDependencies({ checkout, sourceFiles, put, ownerId })
        const lockPath = profile === COMPILER_BUILD_PROFILE ? 'pnpm-lock.yaml' : 'fixture-lock.json'
        attestation.dependencies = { packageManager: packageData.packageManager, packageManagerVersion: managerVersion,
          lock: { path: lockPath, artifact: sourceFiles.find(f => f.path === lockPath)?.artifact },
          inventory: put(JSON.stringify(snapshot.inventory, null, 2) + '\n'), resolutions: snapshot.resolutions }
      }
      const command = await runCommand({ phase, argv, checkout, environment, timeoutMs, put, ownerId })
      attestation.build.commands.push(command)
      require(command.exitCode === 0 && command.signal === null, `compiler ${phase} command failed; see archived stdout/stderr`)
    }
    cleanTracked(checkout, commit)
    const afterDependencies = snapshotDependencies({ checkout, sourceFiles, put, ownerId })
    require(hash(Buffer.from(JSON.stringify(afterDependencies.inventory, null, 2) + '\n')) === attestation.dependencies.inventory.sha256, 'compiler build mutated its dependency input closure')
    attestation.build.after = put(JSON.stringify(guard(), null, 2) + '\n')
    const outputs = []
    const walkOutput = directoryPath => {
      for (const entry of readdirSync(directoryPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(directoryPath, entry.name)
        if (entry.isDirectory()) walkOutput(file)
        else { require(entry.isFile(), 'compiler output cannot contain symlinks or special files'); outputs.push({ path: slash(relative(checkout, file)), artifact: put(readFileSync(file)) }) }
      }
    }
    for (const directoryPath of outputDirectories) if (existsSync(join(checkout, directoryPath))) walkOutput(join(checkout, directoryPath))
    require(requiredOutputs.every(path => outputs.some(item => item.path === path)), 'fresh compiler build omitted required entry outputs')
    attestation.outputs = outputs; attestation.build.requiredOutputs = requiredOutputs; attestation.status = 'built'
  } catch (error) { failure = error; attestation.failure = error.message }
  const bytes = JSON.stringify(attestation, null, 2) + '\n'
  writeFileSync(join(directory, 'compiler-build.json'), bytes)
  let reference = { path: slash(relative(root, join(directory, 'compiler-build.json'))), sha256: hash(bytes), bytes: Buffer.byteLength(bytes) }
  if (!failure) {
    const verification = inspectCompilerBuildEvidence({ root, reference, expectedCommit: commit, expectedProfile: profile })
    if (verification.errors.length) {
      failure = new Error(verification.errors.join('\n'))
      attestation.status = 'failed'; attestation.failure = failure.message
      const rejected = JSON.stringify(attestation, null, 2) + '\n'
      writeFileSync(join(directory, 'compiler-build.json'), rejected)
      reference = { path: reference.path, sha256: hash(rejected), bytes: Buffer.byteLength(rejected) }
    }
  }
  if (!keepCheckout && !failure) await rm(checkout, { recursive: true, force: true })
  if (failure) { failure.compilerBuild = reference; throw failure }
  return { reference, attestation, checkout }
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE) {
  const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  try {
    const root = resolve(option('--root') ?? fileURLToPath(new URL('..', import.meta.url)))
    const baseline = JSON.parse(readFileSync(join(root, 'docs/conformance/baseline-v1.json')))
    const directory = resolve(root, option('--archive') ?? `artifacts/conformance-compiler-build/${new Date().toISOString().replaceAll(':', '-')}`)
    const result = await buildCompilerFromPinnedSource({ root, directory, source: resolve(root, option('--source') ?? 'vendor/weapp-vite'),
      checkout: resolve(root, option('--checkout') ?? join(directory, 'checkout')), commit: option('--commit') ?? baseline.compiler.commit,
      packageManager: option('--package-manager') ?? 'pnpm', keepCheckout: !args.includes('--cleanup') })
    process.stdout.write(JSON.stringify(result.reference) + '\n')
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message, compilerBuild: error.compilerBuild ?? null }) + '\n')
    process.exitCode = 1
  }
}
