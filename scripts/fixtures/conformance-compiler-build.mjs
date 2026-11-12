// TEST FIXTURES ONLY. These synthetic process receipts exercise the offline
// validator. They are not evidence of a compiler build or an official run.
// Production runners must call buildCompilerFromPinnedSource instead.
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  archiveCompilerBuildBytes, archivePinnedCompilerSource, compilerBuildWorkspaceManifests,
  compilerBuildDependencyDeclarations, compilerBuildSourceIdentity, COMPILER_BUILD_COMMAND, COMPILER_BUILD_PROFILE,
  requireCompilerBuildEvidence,
} from '../conformance-compiler-build.mjs'

export function createSyntheticPinnedCompilerBuild({ root, source, commit, directory }) {
  root = resolve(root); directory = resolve(directory)
  mkdirSync(directory, { recursive: true })
  const put = bytes => archiveCompilerBuildBytes({ root, directory, bytes })
  const pinned = archivePinnedCompilerSource({ root, directory, source, commit })
  const read = file => readFileSync(join(root, file.artifact.path))
  const manifests = compilerBuildWorkspaceManifests(pinned.files, read)
  const packages = new Map(manifests.map(file => [JSON.parse(read(file)).name, file]))
  const declarations = compilerBuildDependencyDeclarations(pinned.files, read)
  const ownerId = randomUUID(), checkout = join(directory, 'synthetic-checkout-not-executed')
  const store = join(directory, `${ownerId}-pnpm-store`), manager = '/synthetic-test-only/pnpm'
  const packageManager = JSON.parse(read(pinned.files.find(file => file.path === 'package.json'))).packageManager
  const entries = new Map(), resolutions = []
  const add = item => {
    const previous = entries.get(item.path)
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error(`synthetic dependency path conflict: ${item.path}`)
    entries.set(item.path, item)
  }
  for (const dependency of declarations) {
    const { from, specifier, range, packageName } = dependency
    let packageJson, version
    if (range.startsWith('workspace:')) {
      const target = packages.get(packageName)
      if (!target) throw new Error(`source workspace dependency missing: ${packageName}`)
      packageJson = target.path; version = JSON.parse(read(target)).version
    } else {
      const id = createHash('sha256').update(`${packageName}\0${range}`).digest('hex')
      // The strict template snapshot reader also checks the observed Automator
      // bridge's reviewed tsx address/export. Keep its bytes explicitly inert;
      // this synthetic inventory never installs or executes the loader.
      const bridgeLoader = packageName === 'tsx'
      packageJson = bridgeLoader ? 'node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/package.json'
        : `node_modules/.pnpm/synthetic-${id}/node_modules/${packageName}/package.json`
      version = bridgeLoader ? '4.23.15' : '0.0.0-synthetic-offline-fixture'
      add({ path: packageJson, kind: 'file', executable: false, artifact: put(JSON.stringify({ name: packageName, version, syntheticFixture: true,
        ...(bridgeLoader ? { exports: { '.': './dist/loader.mjs' } } : {}) }) + '\n') })
      if (bridgeLoader) add({ path: `${dirname(packageJson)}/dist/loader.mjs`, kind: 'file', executable: false,
        artifact: put('// SYNTHETIC OFFLINE READER FIXTURE; no tsx loader was installed or executed.\n') })
    }
    const importer = dirname(from) === '.' ? '' : dirname(from) + '/'
    add({ path: `${importer}node_modules/${specifier}`, kind: 'link', target: dirname(packageJson) })
    resolutions.push({ from, specifier, range, packageJson, version })
  }
  add({ path: 'node_modules/.modules.yaml', kind: 'file', executable: false, artifact: put(`# SYNTHETIC OFFLINE VALIDATOR FIXTURE; no install executed\npackageManager: ${packageManager}\nstoreDir: ${store}/v10\n`) })
  const lock = pinned.files.find(file => file.path === 'pnpm-lock.yaml')
  if (!lock) throw new Error('synthetic pinned fixture requires the real pnpm lock')
  add({ path: 'node_modules/.pnpm/lock.yaml', kind: 'file', executable: false, artifact: lock.artifact })
  const sourceIdentity = compilerBuildSourceIdentity(pinned)
  const roots = ['packages/weapp-vite/dist']
  const guard = { ownerId, commit, trackedDirty: '', sourceIdentity }
  const before = put(JSON.stringify({ ...guard, absentOutputs: roots }) + '\n'), after = put(JSON.stringify(guard) + '\n')
  let sequence = 0
  const command = (phase, argv) => {
    const startedAt = new Date(1_700_000_000_000 + sequence++ * 1000).toISOString()
    const finishedAt = new Date(Date.parse(startedAt) + 1).toISOString()
    const execution = { ownerId, phase, argv, cwd: '.', startedAt, finishedAt, exitCode: 0, signal: null,
      stdout: put(`SYNTHETIC OFFLINE VALIDATOR FIXTURE: ${phase} was NOT executed.\n`), stderr: put('') }
    return { ...execution, execution: put(JSON.stringify(execution, null, 2) + '\n') }
  }
  const requiredOutputs = ['packages/weapp-vite/dist/index.mjs','packages/weapp-vite/dist/cli.mjs']
  const attestation = { schemaVersion:1,kind:'weapp-container.compiler-build',profile:COMPILER_BUILD_PROFILE,status:'built',
    producer:{name:'conformance-compiler-build.mjs',artifact:put(readFileSync(fileURLToPath(new URL('../conformance-compiler-build.mjs',import.meta.url))))},source:pinned,
    build:{ownerId,detached:true,checkout,before,after,environment:{NODE_OPTIONS:'',NODE_PATH:'',TURBO_FORCE:'true'},
      commands:[command('install',[manager,'install','--frozen-lockfile','--ignore-scripts','--store-dir',store]),command('build',[manager,...COMPILER_BUILD_COMMAND])],requiredOutputs},
    dependencies:{packageManager,packageManagerVersion:packageManager.slice(5),lock:{path:'pnpm-lock.yaml',artifact:lock.artifact},
      inventory:put(JSON.stringify({schemaVersion:1,ownerId,entries:[...entries.values()]},null,2)+'\n'),resolutions},
    outputs:requiredOutputs.map(path=>({path,artifact:put('// SYNTHETIC OFFLINE VALIDATOR FIXTURE; not a built compiler.\n')}))}
  const file=join(directory,'synthetic-compiler-build.json'),bytes=JSON.stringify(attestation,null,2)+'\n'
  writeFileSync(file,bytes)
  const reference={path:relative(root,file).replaceAll('\\','/'),sha256:createHash('sha256').update(bytes).digest('hex'),bytes:Buffer.byteLength(bytes)}
  requireCompilerBuildEvidence({root,reference,expectedCommit:commit})
  return {reference,attestation,compilerBuild:reference}
}
