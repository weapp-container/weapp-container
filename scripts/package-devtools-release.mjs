#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createPlatformInstaller } from './lib/devtools-installers.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMPILER_COMMIT = '0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e'
const NODE_VERSION = '24.22.2'
const CANVASKIT_VERSION = '0.42.0'
const CANVASKIT = {
  javascript: { path: 'vendor/canvaskit/canvaskit.js', size: 123707, sha256: '894815b2d39b24de2eacdb01453778d83e0b6c418b034e3b728e80956ac2a9d5' },
  wasm: { path: 'vendor/canvaskit/canvaskit.wasm', size: 8242911, sha256: 'aca7fa6019f95d3de98d4a49ae60a3d66a09e9d5ca74091fbc369b9be959f959' },
  license: { path: 'vendor/canvaskit/LICENSE', size: 1635, sha256: 'd27678cba0d529e77201e2d2a053628143e986aad8f1e77f7039ad4366c8f978' },
  package: { path: 'vendor/canvaskit/package.json', size: 2359, sha256: '81ecbaba46a245d6e7d317c805462f2efc21ec252577eae88ff99ed406928997' },
  font: { path: 'vendor/fonts/NotoSansSC.ttf', size: 17772300, sha256: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da' },
  fontLicense: { path: 'vendor/fonts/OFL.txt', size: 4388, sha256: '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9' },
}
const NODE_TARGETS = {
  'macos-arm64': { node: 'darwin-arm64', os: 'darwin', cpu: 'arm64', archive: 'tar.gz' },
  'macos-x86_64': { node: 'darwin-x64', os: 'darwin', cpu: 'x64', archive: 'tar.gz' },
  'macos-universal': { node: ['darwin-arm64', 'darwin-x64'], os: 'darwin', cpu: ['arm64', 'x64'], archive: 'tar.gz', universal: true },
  'linux-x86_64': { node: 'linux-x64', os: 'linux', cpu: 'x64', archive: 'tar.gz' },
  'windows-x86_64': { node: 'win-x64', os: 'win32', cpu: 'x64', archive: 'zip' },
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => `${JSON.stringify(value, null, 2)}\n`
const escapeRegex = value => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

function globMatches(path, pattern) {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const braceStart = normalized.indexOf('{')
  if (braceStart !== -1) {
    const braceEnd = normalized.indexOf('}', braceStart)
    if (braceEnd !== -1) {
      const prefix = normalized.slice(0, braceStart)
      const suffix = normalized.slice(braceEnd + 1)
      return normalized.slice(braceStart + 1, braceEnd).split(',').some(value => globMatches(path, `${prefix}${value}${suffix}`))
    }
  }
  let expression = ''
  for (let index = 0; index < normalized.length; index++) {
    if (normalized[index] === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        expression += '(?:.*/)?'
        index += 2
      } else {
        expression += '.*'
        index++
      }
    } else if (normalized[index] === '*') {
      expression += '[^/]*'
    } else {
      expression += escapeRegex(normalized[index])
    }
  }
  return new RegExp(`^${expression}$`).test(path)
}
function platformFieldMatches(value, targets) {
  if (value === undefined) return true
  const values = Array.isArray(value) ? value : [value]
  const candidates = Array.isArray(targets) ? targets : [targets]
  if (values.some(item => item.startsWith('!') && candidates.includes(item.slice(1)))) return false
  const allowed = values.filter(item => !item.startsWith('!'))
  return allowed.length === 0 || allowed.includes('any') || candidates.some(item => allowed.includes(item))
}

const platformMatches = (pkg, target) => {
  const cpus = Array.isArray(target.cpu) ? target.cpu : [target.cpu]
  const targetOs = target.os === 'win32' ? 'win32' : target.os
  return platformFieldMatches(pkg.os, targetOs) && platformFieldMatches(pkg.cpu, cpus)
}

function targetNativePackageNames(target) {
  const nodes = Array.isArray(target.node) ? target.node : [target.node]
  return nodes.flatMap(node => {
    if (node === 'linux-x64') return [node, 'linux-x64-gnu', 'linux-x64-musl']
    if (node === 'win-x64') return ['win32-x64', 'win32-x64-msvc']
    return [node]
  })
}

function isTargetNativePackage(name, target) {
  return targetNativePackageNames(target).some(suffix => name.includes(suffix))
}

function option(args, name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 ** 2 }).trim()
}

async function packageJson(directory) {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
}

async function findInstalledPackage(name, from, workspaceRoot, sourceRoot) {
  const candidates = []
  let cursor = from
  while (true) {
    candidates.push(join(cursor, 'node_modules', name))
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  candidates.push(join(workspaceRoot, 'node_modules', name), join(sourceRoot, 'node_modules', name))
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate)
      if ((await stat(resolved)).isDirectory()) return resolved
    } catch {}
  }
  const packageDirectories = await readdir(join(workspaceRoot, 'packages'), { withFileTypes: true }).catch(() => [])
  for (const entry of packageDirectories) {
    if (!entry.isDirectory()) continue
    const candidate = join(workspaceRoot, 'packages', entry.name)
    try {
      const pkg = await packageJson(candidate)
      if (pkg.name === name) return candidate
    } catch {}
  }
  return null
}

async function downloadPackage(name, version, temporaryRoot) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Optional target package ${name} needs an exact version, got ${version}`)
  }
  const packageRoot = join(temporaryRoot, 'optional-packages', `${name.replaceAll('/', '+')}@${version}`)
  const source = join(packageRoot, 'package')
  if (await stat(source).then(value => value.isDirectory()).catch(() => false)) return source
  await mkdir(packageRoot, { recursive: true })
  const registryName = encodeURIComponent(name)
  const metadata = await fetch(`https://registry.npmjs.org/${registryName}/${version}`)
  if (!metadata.ok) throw new Error(`Unable to download ${name}@${version}: HTTP ${metadata.status}`)
  const packageInfo = await metadata.json()
  if (packageInfo.name !== name || packageInfo.version !== version || typeof packageInfo.dist?.tarball !== 'string') {
    throw new Error(`Invalid registry metadata for ${name}@${version}`)
  }
  const archivePath = join(packageRoot, 'package.tgz')
  const archive = await fetchBytes(packageInfo.dist.tarball)
  if (packageInfo.dist.integrity) {
    const [algorithm, digest] = packageInfo.dist.integrity.split('-', 2)
    if (algorithm !== 'sha512' || createHash(algorithm).update(archive).digest('base64') !== digest) {
      throw new Error(`Registry integrity mismatch for ${name}@${version}`)
    }
  }
  await writeFile(archivePath, archive)
  await mkdir(source, { recursive: true })
  run('tar', ['-xzf', archivePath, '--strip-components=1', '-C', source])
  await rm(archivePath, { force: true })
  return source
}

async function copyPackageFiles(source, destination) {
  await mkdir(destination, { recursive: true })
  const pkg = await packageJson(source)
  await writeFile(join(destination, 'package.json'), json(pkg))
  const entries = await readdir(source, { withFileTypes: true })
  const exportPaths = []
  const addExportPaths = value => {
    if (typeof value === 'string') exportPaths.push(value)
    else if (value && typeof value === 'object') for (const item of Object.values(value)) addExportPaths(item)
  }
  addExportPaths(pkg.exports)
  const requiredPaths = [pkg.main, pkg.module, ...exportPaths]
    .filter(value => typeof value === 'string' && !value.startsWith('../') && !value.startsWith('/'))
    .map(value => value.replace(/^\.\//, ''))
  const includePatterns = [...(pkg.files?.filter(file => !file.startsWith('!')) ?? []), ...requiredPaths]
  const excludePatterns = pkg.files?.filter(file => file.startsWith('!')).map(file => file.slice(1)) ?? []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'package.json') continue
    const sourceEntry = join(source, entry.name)
    const destinationEntry = join(destination, entry.name)
    if (!pkg.files?.length && (/^(?:\.github|\.turbo|bench(?:mark)?|e2e|test|tests|__tests__|coverage)$/i.test(entry.name)
      || entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.mjs'))) continue
    await cp(sourceEntry, destinationEntry, {
      recursive: true,
      dereference: true,
      filter(path) {
        if (!pkg.files?.length) return true
        const relativePath = relative(source, path).split(sep).join('/')
        const included = includePatterns.length === 0 || includePatterns.some(pattern => {
          const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
          const base = normalized.split('*')[0].replace(/\/+$/, '')
          return globMatches(relativePath, normalized)
            || normalized.startsWith(`${relativePath}/`)
            || relativePath.startsWith(`${normalized}/`)
            || (base === '' && lstatSync(path).isDirectory())
            || (relativePath.startsWith(`${base}/`) && lstatSync(path).isDirectory())
        })
        const excluded = excludePatterns.some(pattern => globMatches(relativePath, pattern))
        const notice = !relativePath.includes('/') && /^(?:readme|licen[cs]e|notice|copying)(?:\.|$)/i.test(relativePath)
        return (included && !excluded) || notice
      },
    })
  }
  return pkg
}

async function collectPackage({ name, version, from, sourceRoot, workspaceRoot, destinationRoot, importerDestination, target, temporaryRoot, seen }) {
  let source = await findInstalledPackage(name, from, workspaceRoot, sourceRoot)
  if (!source && version && isTargetNativePackage(name, target)) source = await downloadPackage(name, version, temporaryRoot)
  if (!source) throw new Error(`Unable to locate compiler dependency ${name}`)
  const pkg = await packageJson(source)
  if (!platformMatches(pkg, target)) return
  let destination = join(destinationRoot, name)
  let installedPackage
  try { installedPackage = await packageJson(destination) } catch {}
  if (installedPackage && installedPackage.version !== pkg.version) {
    destination = join(importerDestination, 'node_modules', name)
    try {
      installedPackage = await packageJson(destination)
      if (installedPackage.version !== pkg.version) throw new Error(`Conflicting dependency ${name}@${pkg.version}`)
    } catch (error) {
      if (error.message.startsWith('Conflicting dependency')) throw error
      installedPackage = undefined
    }
  }
  const identity = `${source}\0${destination}`
  if (seen.has(identity)) return
  seen.add(identity)
  if (!installedPackage) await copyPackageFiles(source, destination)
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    await collectPackage({ name: dependency, from: source, sourceRoot, workspaceRoot, destinationRoot, importerDestination: destination, target, temporaryRoot, seen })
  }
  for (const [dependency, optionalVersion] of Object.entries(pkg.optionalDependencies ?? {})) {
    try {
      await collectPackage({ name: dependency, version: optionalVersion, from: source, sourceRoot, workspaceRoot, destinationRoot, importerDestination: destination, target, temporaryRoot, seen })
    } catch (error) {
      if (isTargetNativePackage(dependency, target)) throw error
    }
  }
}

async function copyCompiler(targetRoot, target, temporaryRoot) {
  const workspaceRoot = join(targetRoot, 'vendor/weapp-vite')
  const sourceWorkspace = join(root, 'vendor/weapp-vite')
  const compilerSource = join(sourceWorkspace, 'packages/weapp-vite')
  await mkdir(join(workspaceRoot, 'packages'), { recursive: true })
  await copyPackageFiles(compilerSource, join(workspaceRoot, 'packages/weapp-vite'))
  const packageManifest = await packageJson(compilerSource)
  const destinationRoot = join(workspaceRoot, 'node_modules')
  const seen = new Set()
  for (const dependency of Object.keys({ ...packageManifest.dependencies, ...packageManifest.optionalDependencies })) {
    await collectPackage({ name: dependency, from: compilerSource, sourceRoot: sourceWorkspace, workspaceRoot: sourceWorkspace, destinationRoot, importerDestination: join(destinationRoot, 'weapp-vite'), target, temporaryRoot, seen })
  }
  await mkdir(join(destinationRoot, 'weapp-vite/bin'), { recursive: true })
  await copyPackageFiles(compilerSource, join(destinationRoot, 'weapp-vite'))
  await writeFile(join(workspaceRoot, 'package.json'), json({ name: 'weapp-vite-runtime', private: true, packageManager: 'pnpm@12.11.2' }))
}

async function copyManifestPacker(targetRoot, target, temporaryRoot) {
  const sourcePackage = join(root, 'tools/container-manifest')
  const destination = join(targetRoot, 'tools/container-manifest')
  await mkdir(join(destination, 'bin'), { recursive: true })
  await cp(join(sourcePackage, 'dist'), join(destination, 'dist'), { recursive: true, dereference: true })
  await cp(join(sourcePackage, 'src/json-integrity.mjs'), join(destination, 'src/json-integrity.mjs'), { recursive: true, dereference: true })
  const manifest = await packageJson(sourcePackage)
  await writeFile(join(destination, 'package.json'), json(manifest))
  await writeFile(join(destination, 'bin/container-pack.mjs'), "#!/usr/bin/env node\nimport '../dist/cli.mjs'\n")
  const destinationRoot = join(targetRoot, 'node_modules')
  const seen = new Set()
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await collectPackage({ name: dependency, from: sourcePackage, sourceRoot: root, workspaceRoot: root, destinationRoot, importerDestination: destination, target, temporaryRoot, seen })
  }
  const qrcodeDestination = join(targetRoot, 'scripts/node_modules')
  const qrcodeSeen = new Set()
  await collectPackage({ name: 'qrcode', from: root, sourceRoot: root, workspaceRoot: root, destinationRoot: qrcodeDestination, importerDestination: join(targetRoot, 'scripts'), target, temporaryRoot, seen: qrcodeSeen })
}

async function fetchBytes(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

async function prepareRendererAssets(targetRoot, temporaryRoot, suppliedAssets) {
  if (suppliedAssets) {
    await cp(resolve(suppliedAssets), join(targetRoot, 'artifacts/dual-renderer-dev-assets'), { recursive: true, dereference: true })
    const config = JSON.parse(await readFile(join(targetRoot, 'artifacts/dual-renderer-dev-assets/runtime-config.json'), 'utf8'))
    for (const value of Object.values(CANVASKIT)) {
      const bytes = await readFile(join(targetRoot, 'artifacts/dual-renderer-dev-assets', value.path))
      if (bytes.length !== value.size || sha256(bytes) !== value.sha256) throw new Error(`Renderer integrity mismatch: ${value.path}`)
    }
    if (config.canvaskit?.version !== CANVASKIT_VERSION
      || config.font?.binary?.sha256 !== CANVASKIT.font.sha256
      || config.font?.binary?.size !== CANVASKIT.font.size) {
      throw new Error('Renderer runtime-config.json does not match the bundled assets')
    }
    return
  }
  const archive = join(temporaryRoot, 'canvaskit.tgz')
  const archiveBytes = await fetchBytes(`https://registry.npmjs.org/canvaskit-wasm/-/canvaskit-wasm-${CANVASKIT_VERSION}.tgz`)
  await writeFile(archive, archiveBytes)
  run('tar', ['-xzf', archive, '-C', temporaryRoot])
  const output = join(targetRoot, 'artifacts/dual-renderer-dev-assets')
  for (const value of Object.values(CANVASKIT)) await mkdir(dirname(join(output, value.path)), { recursive: true })
  const canvasSource = join(temporaryRoot, 'package')
  for (const [name, value] of Object.entries(CANVASKIT)) {
    const source = name === 'font' || name === 'fontLicense'
      ? null
      : join(canvasSource, name === 'javascript' ? 'bin/full/canvaskit.js' : name === 'wasm' ? 'bin/full/canvaskit.wasm' : name === 'license' ? 'LICENSE' : 'package.json')
    if (source) await cp(source, join(output, value.path), { recursive: true, dereference: true })
  }
  const font = await fetchBytes('https://raw.githubusercontent.com/google/fonts/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf')
  const fontLicense = await fetchBytes('https://raw.githubusercontent.com/google/fonts/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc/OFL.txt')
  await writeFile(join(output, CANVASKIT.font.path), font)
  await writeFile(join(output, CANVASKIT.fontLicense.path), fontLicense)
  const config = {
    schemaVersion: 1, renderer: 'canvaskit', fallback: 'error',
    canvaskit: { version: CANVASKIT_VERSION, variant: 'full',
      javascript: { url: '/renderer-assets/vendor/canvaskit/canvaskit.js', sha256: sha256(await readFile(join(output, CANVASKIT.javascript.path))), size: CANVASKIT.javascript.size },
      wasm: { url: '/renderer-assets/vendor/canvaskit/canvaskit.wasm', sha256: sha256(await readFile(join(output, CANVASKIT.wasm.path))), size: CANVASKIT.wasm.size },
      license: { url: '/renderer-assets/vendor/canvaskit/LICENSE', sha256: CANVASKIT.license.sha256, size: CANVASKIT.license.size },
      package: { url: '/renderer-assets/vendor/canvaskit/package.json', sha256: CANVASKIT.package.sha256, size: CANVASKIT.package.size } },
    font: { binary: { url: '/renderer-assets/vendor/fonts/NotoSansSC.ttf', sha256: sha256(font), size: font.length }, license: { url: '/renderer-assets/vendor/fonts/OFL.txt', sha256: sha256(fontLicense), size: fontLicense.length } },
  }
  await writeFile(join(output, 'runtime-config.json'), json(config))
  for (const [name, value] of Object.entries(CANVASKIT)) {
    const bytes = await readFile(join(output, value.path))
    if (bytes.length !== value.size || sha256(bytes) !== value.sha256) throw new Error(`Renderer integrity mismatch: ${name}`)
  }
}

async function prepareNode(targetRoot, target, temporaryRoot, suppliedNode) {
  const info = NODE_TARGETS[target]
  const nodes = Array.isArray(info.node) ? info.node : [info.node]
  const destination = join(targetRoot, 'node')
  for (const [index, nodeTarget] of nodes.entries()) {
    let source
    if (suppliedNode && nodes.length === 1) {
      source = resolve(suppliedNode)
    } else {
      const archiveName = `node-v${NODE_VERSION}-${nodeTarget}.${info.archive}`
      const archive = join(temporaryRoot, archiveName)
      await writeFile(archive, await fetchBytes(`https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`))
      if (info.archive === 'zip') run('tar', ['-xf', archive, '-C', temporaryRoot])
      else run('tar', ['-xzf', archive, '-C', temporaryRoot])
      source = join(temporaryRoot, `node-v${NODE_VERSION}-${nodeTarget}`)
    }
    if (index === 0) await copyNodeRuntime(source, destination, info.archive === 'zip')
    else if (info.universal) {
      const merged = join(temporaryRoot, 'node-universal')
      run('lipo', ['-create', join(destination, 'bin/node'), join(source, 'bin/node'), '-output', merged])
      await cp(merged, join(destination, 'bin/node'))
      await rm(merged, { force: true })
    }
  }
  if (info.archive === 'zip') await writeFile(join(targetRoot, 'node-path.txt'), 'node.exe\n')
  else await writeFile(join(targetRoot, 'node-path.txt'), 'bin/node\n')
  await mkdir(join(targetRoot, 'LICENSES'), { recursive: true })
  const licenseNames = info.archive === 'zip'
    ? [['LICENSE', 'NODE.txt'], ['node_modules/corepack/LICENSE.md', 'COREPACK.txt'], ['node_modules/npm/LICENSE', 'NPM.txt']]
    : [['LICENSE', 'NODE.txt'], ['lib/node_modules/corepack/LICENSE.md', 'COREPACK.txt'], ['lib/node_modules/npm/LICENSE', 'NPM.txt']]
  for (const [sourcePath, destinationName] of licenseNames) {
    await cp(join(destination, sourcePath), join(targetRoot, 'LICENSES', destinationName))
  }
}

async function copyNodeRuntime(source, destination, windows) {
  await mkdir(destination, { recursive: true })
  const executable = windows ? 'node.exe' : 'bin/node'
  await mkdir(dirname(join(destination, executable)), { recursive: true })
  await cp(join(source, executable), join(destination, executable), { dereference: true })
  const moduleRoot = windows ? 'node_modules' : 'lib/node_modules'
  for (const name of ['corepack', 'npm']) {
    await cp(join(source, moduleRoot, name), join(destination, moduleRoot, name), { recursive: true, dereference: true })
  }
  if (windows) {
    for (const name of ['npm.cmd', 'npx.cmd']) {
      await cp(join(source, name), join(destination, name))
    }
  } else {
    for (const name of ['npm', 'npx']) {
      await cp(join(source, 'bin', name), join(destination, 'bin', name), { dereference: true })
    }
  }
  await cp(join(source, 'LICENSE'), join(destination, 'LICENSE'))
}

async function copyRuntimeSources(targetRoot) {
  const files = ['simulator-watch.mjs', 'simulator-source-credit.mjs', 'simulator-watch-diagnostics.mjs', 'device-dev-server.mjs', 'devtools-launcher.mjs', 'devtools-launcher.html']
  await mkdir(join(targetRoot, 'scripts'), { recursive: true })
  for (const file of files) await cp(join(root, 'scripts', file), join(targetRoot, 'scripts', file), { recursive: true, dereference: true })
  const deviceHelpers = join(root, 'scripts/lib/device-dev')
  const helperFiles = (await readdir(deviceHelpers, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs'))
  await mkdir(join(targetRoot, 'scripts/lib/device-dev'), { recursive: true })
  for (const entry of helperFiles) await cp(join(deviceHelpers, entry.name), join(targetRoot, 'scripts/lib/device-dev', entry.name))
  await cp(join(root, 'tools/devtools-release/README.md'), join(targetRoot, 'README.md'))
  await cp(join(root, 'tools/devtools-release/NOTICE.md'), join(targetRoot, 'NOTICE.md'))
  await cp(join(root, 'LICENSE'), join(targetRoot, 'LICENSE'))
  await mkdir(join(targetRoot, 'LICENSES'), { recursive: true })
  await cp(join(root, 'LICENSE'), join(targetRoot, 'LICENSES/WEAPP-CONTAINER-APACHE-2.0.txt'))
  await cp(join(targetRoot, 'artifacts/dual-renderer-dev-assets/vendor/canvaskit/LICENSE'), join(targetRoot, 'LICENSES/CANVASKIT.txt'))
  await cp(join(targetRoot, 'artifacts/dual-renderer-dev-assets/vendor/fonts/OFL.txt'), join(targetRoot, 'LICENSES/NOTO-SANS-SC-OFL.txt'))
}

async function writeLaunchers(targetRoot, target) {
  const windows = target.startsWith('windows-')
  await mkdir(join(targetRoot, 'bin'), { recursive: true })
  if (windows) {
    await writeFile(join(targetRoot, 'bin/weapp-devtools.cmd'), '@echo off\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\scripts\\devtools-launcher.mjs" %*\r\n')
    await writeFile(join(targetRoot, 'bin/pnpm.cmd'), '@echo off\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\node\\node_modules\\corepack\\dist\\corepack.js" pnpm@12.11.2 %*\r\n')
    await writeFile(join(targetRoot, 'bin/weapp-devtools.vbs'), 'Set shell = CreateObject("WScript.Shell")\r\nroot = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)\r\ncommand = Chr(34) & root & "\\..\\node\\node.exe" & Chr(34) & " " & Chr(34) & root & "\\..\\scripts\\devtools-launcher.mjs" & Chr(34) & " gui"\r\nshell.Run command, 0, False\r\n')
  } else {
    const nodePath = target.startsWith('macos-') || target.startsWith('linux-') ? '../node/bin/node' : '../node/node'
    await writeFile(join(targetRoot, 'bin/weapp-devtools'), `#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/${nodePath}" "$HERE/../scripts/devtools-launcher.mjs" "$@"\n`, { mode: 0o755 })
    await writeFile(join(targetRoot, 'bin/pnpm'), '#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/../node/bin/node" "$HERE/../node/lib/node_modules/corepack/dist/corepack.js" pnpm@12.11.2 "$@"\n', { mode: 0o755 })
  }
}

export async function collectLicenses(targetRoot) {
  const roots = ['node_modules', 'vendor/weapp-vite/node_modules']
  const copied = new Set()
  const visit = async directory => {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (!entry.isDirectory()) continue
      const manifestPath = join(path, 'package.json')
      try {
        const pkg = JSON.parse(await readFile(manifestPath, 'utf8'))
        if (pkg.name && !copied.has(path)) {
          copied.add(path)
          for (const file of await readdir(path, { withFileTypes: true })) {
            if (!file.isFile() || !/^(?:licen[cs]e|notice|copying)(?:\.|$)/i.test(file.name)) continue
            const relativePackage = relative(targetRoot, path).split(sep).join('/')
            const packageName = pkg.name.replaceAll('/', '+')
            const packageVersion = pkg.version || 'unknown'
            const packageHash = createHash('sha1').update(relativePackage).digest('hex').slice(0, 8)
            const destination = join(targetRoot, 'LICENSES/dependencies', `${packageName}-${packageVersion}-${packageHash}`, file.name)
            await mkdir(dirname(destination), { recursive: true })
            await cp(join(path, file.name), destination)
          }
        }
      } catch {}
      await visit(path)
    }
  }
  for (const directory of roots) await visit(join(targetRoot, directory))
}

async function inventory(targetRoot, metadata) {
  await writeFile(join(targetRoot, 'weapp-devtools.json'), json(metadata))
  const files = []
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.name === 'manifest.json' || entry.name === 'SHA256SUMS') continue
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const bytes = await readFile(path)
        files.push({ path: relative(targetRoot, path).split(sep).join('/'), size: bytes.length, sha256: sha256(bytes) })
      }
    }
  }
  await visit(targetRoot)
  files.sort((a, b) => a.path.localeCompare(b.path))
  const manifest = { schemaVersion: 1, ...metadata, files }
  await writeFile(join(targetRoot, 'manifest.json'), json(manifest))
  await writeFile(join(targetRoot, 'SHA256SUMS'), `${files.map(file => `${file.sha256}  ${file.path}`).join('\n')}\n`)
  return manifest
}

export async function createArchive(source, output, target) {
  const parent = dirname(output)
  await mkdir(parent, { recursive: true })
  if (target.startsWith('windows-')) {
    const quotePowerShell = value => `'${value.replaceAll("'", "''")}'`
    const sourcePath = join(parent, basename(source))
    const script = `Compress-Archive -LiteralPath ${quotePowerShell(sourcePath)} -DestinationPath ${quotePowerShell(resolve(output))} -CompressionLevel Optimal`
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], parent)
  } else {
    run('tar', ['-czf', output, basename(source)], parent)
  }
}

export async function packageDevtools({ target, output, version = '0.1.0-preview.7.1', simulatorBinary, simulatorBinaryX86_64, nodeDistribution, rendererAssets }) {
  if (!NODE_TARGETS[target]) throw new Error(`Unsupported target ${target}`)
  const staging = resolve(output)
  const temporaryRoot = `${staging}.tmp`
  await rm(staging, { recursive: true, force: true })
  await rm(temporaryRoot, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await mkdir(temporaryRoot, { recursive: true })
  const binaryName = target.startsWith('windows-') ? 'weapp-simulator.exe' : 'weapp-simulator'
  if (!simulatorBinary) throw new Error('--simulator-bin is required')
  await mkdir(join(staging, 'bin'), { recursive: true })
  await cp(resolve(simulatorBinary), join(staging, 'bin', binaryName), { recursive: true, dereference: true })
  if (NODE_TARGETS[target].universal) {
    if (!simulatorBinaryX86_64) throw new Error('--simulator-bin-x86_64 is required for macos-universal')
    const merged = join(temporaryRoot, 'weapp-simulator-universal')
    run('lipo', ['-create', resolve(simulatorBinary), resolve(simulatorBinaryX86_64), '-output', merged])
    await cp(merged, join(staging, 'bin', binaryName))
    await rm(merged, { force: true })
  }
  if (!target.startsWith('windows-')) await run('chmod', ['755', join(staging, 'bin', binaryName)])
  await prepareRendererAssets(staging, temporaryRoot, rendererAssets)
  await copyRuntimeSources(staging)
  await copyManifestPacker(staging, NODE_TARGETS[target], temporaryRoot)
  await copyCompiler(staging, NODE_TARGETS[target], temporaryRoot)
  await collectLicenses(staging)
  await prepareNode(staging, target, temporaryRoot, nodeDistribution)
  await writeLaunchers(staging, target)
  const metadata = {
    schemaVersion: 1, name: 'weapp-container-devtools', version, target,
    sourceCommit: run('git', ['rev-parse', 'HEAD']), weappViteCommit: COMPILER_COMMIT,
    weappViteVersion: '7.5.0', nodeVersion: NODE_VERSION, canvaskitVersion: CANVASKIT_VERSION,
    entrypoints: { gui: target.startsWith('windows-') ? 'bin/weapp-devtools.cmd' : 'bin/weapp-devtools', cli: 'bin/weapp-simulator' },
  }
  const manifest = await inventory(staging, metadata)
  const archive = target.startsWith('windows-') ? `${staging}.zip` : `${staging}.tar.gz`
  const sourceDirectory = staging.endsWith('/') ? staging.slice(0, -1) : staging
  try {
    await createArchive(sourceDirectory, archive, target)
    const installer = await createPlatformInstaller({
      target,
      source: sourceDirectory,
      output: staging,
      version,
      iconPath: join(root, 'assets/brand/png/weapp-container-avatar-1024.png'),
    })
    return { archive, installer, directory: staging, manifest }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  try {
    const result = await packageDevtools({
      target: option(args, '--target'), output: option(args, '--output', resolve(root, 'artifacts/devtools-release')), version: option(args, '--version', '0.1.0-preview.7.1'), simulatorBinary: option(args, '--simulator-bin'), simulatorBinaryX86_64: option(args, '--simulator-bin-x86_64'),
      nodeDistribution: option(args, '--node-dist'), rendererAssets: option(args, '--renderer-assets'),
    })
    process.stdout.write(`${JSON.stringify({ archive: result.archive, installer: result.installer, directory: result.directory, files: result.manifest.files.length }, null, 2)}\n`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
