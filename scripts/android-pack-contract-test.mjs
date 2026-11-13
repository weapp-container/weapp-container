#!/usr/bin/env node
/** Compile production Android Kotlin and run its portable-pack contract on the JVM. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifest, canonicalize, writePack } from '../tools/container-manifest/src/index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  if (!['--gradle-cache', '--android-jar', '--ndk', '--report'].includes(key) || !process.argv[index + 1]) {
    throw new Error('Usage: android-pack-contract-test.mjs [--gradle-cache path] [--android-jar path] [--ndk path] [--report path]')
  }
  options.set(key, resolve(process.argv[index + 1]))
}
const cache = options.get('--gradle-cache') || join(homedir(), '.gradle/caches/modules-2/files-2.1')
const androidJar = options.get('--android-jar') || join(process.env.ANDROID_HOME || join(homedir(), 'Library/Android/sdk'), 'platforms/android-36/android.jar')
const ndk = options.get('--ndk') || process.env.ANDROID_NDK_HOME || join(process.env.ANDROID_HOME || join(homedir(), 'Library/Android/sdk'), 'ndk/27.1.12297006')
const sha256 = value => createHash('sha256').update(value).digest('hex')
async function artifact(group, name, version) {
  const folder = join(cache, group, name, version)
  const file = `${name}-${version}.jar`
  for (const hash of (await readdir(folder)).sort()) {
    const path = join(folder, hash, file)
    try { await readFile(path); return path } catch { /* Another classifier. */ }
  }
  throw new Error(`Missing pinned tool dependency ${group}:${name}:${version}; run the Android dependency setup or pass --gradle-cache`)
}
const dependencies = await Promise.all([
  ['org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.0.21'],
  ['org.jetbrains.kotlin', 'kotlin-stdlib', '2.0.21'],
  ['org.jetbrains.kotlin', 'kotlin-script-runtime', '2.0.21'],
  ['org.jetbrains.kotlin', 'kotlin-reflect', '2.0.21'],
  ['org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'],
  ['org.jetbrains', 'annotations', '13.0'],
  ['org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0'],
].map(declaration => artifact(...declaration)))
const jsonJar = await artifact('org.json', 'json', '20180813')
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : 'java'
const kotlinPackage = 'com/sonofmagic/weapp/container'
const jvmSources = ['PortablePack.kt', 'PortablePackSession.kt', 'AndroidWindowObservation.kt', 'WindowObservationCoordinator.kt', 'EglDrawableGate.kt', 'UnixTimerClock.kt']
  .map(name => join(root, 'examples/hosts/android/app/src/main/java', kotlinPackage, name))
const sources = [...jvmSources, ...['MainActivity.kt', 'GlesSnapshotView.kt', 'AndroidWindowObservationCollector.kt']
  .map(name => join(root, 'examples/hosts/android/app/src/main/java', kotlinPackage, name))]
const testSource = join(root, 'examples/hosts/android/app/src/test/java', kotlinPackage, 'PortablePackContractTest.kt')
const owned = await mkdtemp(join(tmpdir(), 'weapp-android-contract-'))
try {
  const input = join(owned, 'input')
  await mkdir(join(input, 'pages/index'), { recursive: true })
  await Promise.all(Object.entries({
    'app.json': JSON.stringify({ pages: ['pages/index/index'] }),
    'app.js': 'App({onLaunch:function(){this.started=true}})',
    'pages/index/index.json': '{}',
    'pages/index/index.js': 'Page({data:{message:"from module"},onLoad:function(){this.setData({message:"onLoad"})}})',
    'pages/index/index.wxml': '<wxs module="types" src="./types.wxs"/><view>{{types.label(message)}}</view>',
    'pages/index/types.wxs': 'module.exports.label=function(value){return value.constructor+":"+value}',
    'pages/index/index.wxss': 'view{background:#123456;color:white}',
  }).map(([name, content]) => writeFile(join(input, name), content)))
  const fixture = await buildManifest(input, { compilerCommit: 'f'.repeat(40) })
  const pack = join(owned, 'pack')
  await writePack(fixture, pack)
  const modernProject = join(root, 'tools/container-manifest/test/fixtures/modern-perf')
  const modernFixture = await buildManifest(join(modernProject, 'raw'), { project: modernProject, compilerCommit: 'f'.repeat(40) })
  const modernPack = join(owned, 'modern-pack')
  await writePack(modernFixture, modernPack)
  const canonicalInput = join(owned, 'canonical-input.json')
  const canonicalExpected = join(owned, 'canonical-expected.json')
  const canonicalFixture = { '😀': 'astral', '\uffff': 'BMP', nested: ['</tag>', '\u2028\u2029', '\ud800', '\udfff', '\b\f\t\r\n\u0001', 0, 9007199254740991, true, null] }
  await writeFile(canonicalInput, JSON.stringify(canonicalFixture))
  await writeFile(canonicalExpected, canonicalize(canonicalFixture))
  function run(args) {
    const result = spawnSync(java, args, { cwd: owned, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    if (result.error || result.status !== 0) throw new Error(`Java/Kotlin command failed (${result.status}): ${result.error || ''}\n${result.stdout}\n${result.stderr}`)
    return result.stdout.trim() || result.stderr.trim()
  }
  const compiler = ['-cp', dependencies.join(':'), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17']
  run([...compiler, '-classpath', [dependencies[1], dependencies[5], jsonJar].join(':'), '-d', join(owned, 'jvm-classes'), ...jvmSources, testSource])
  const result = JSON.parse(run(['-cp', [join(owned, 'jvm-classes'), dependencies[1], jsonJar].join(':'),
    'com.sonofmagic.weapp.container.PortablePackContractTest', pack, canonicalInput, canonicalExpected, modernPack]))
  // Android.jar is used only for a real SDK type-check, never executed as a
  // fake device/runtime. All generated classes remain in this owned temp dir.
  await readFile(androidJar)
  run([...compiler, '-classpath', [dependencies[1], dependencies[5], androidJar].join(':'), '-d', join(owned, 'android-classes'), ...sources])
  const jniSource = join(root, 'examples/hosts/android/app/src/main/cpp/weapp_jni.cpp')
  const nativeCompiler = join(ndk, 'toolchains/llvm/prebuilt', process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64', 'bin/aarch64-linux-android26-clang++')
  const nativeCheck = spawnSync(nativeCompiler, ['-std=c++17', '-fsyntax-only', '-DWEAPP_CONTAINER_ANDROID_SKIA_GPU_GLES', jniSource], { cwd: owned, encoding: 'utf8' })
  if (nativeCheck.error || nativeCheck.status !== 0) throw new Error(`NDK JNI compile failed: ${nativeCheck.error || nativeCheck.stderr}`)
  const additionalSources = [jniSource, join(dirname(jniSource), 'weapp_container_android_ffi.h'),
    join(root, 'crates/container-host-android/src/ffi.rs'), join(root, 'crates/container-host-android/src/lib.rs'),
    join(root, 'crates/container-host-common/src/lib.rs'), fileURLToPath(import.meta.url)]
  const hashes = Object.fromEntries(await Promise.all([...sources, testSource, ...additionalSources].map(async path => [path.slice(root.length + 1), sha256(await readFile(path))])))
  const report = {
    schemaVersion: 1, status: 'passed', jvm: result, androidSdkCompilation: 'passed', androidNdkJniCompilation: 'passed',
    fixture: { id: 'android-contract-handwritten-wxs', manifestIntegrity: fixture.manifest.integrity.root, compilerCommit: fixture.manifest.compiler.commit },
    modernFixture: { id: 'modern-view-perf-real-typescript-compile', manifestIntegrity: modernFixture.manifest.integrity.root,
      unit: modernFixture.manifest.modernView.units[0] },
    sourceHashes: hashes, tools: { java: run(['-version']), kotlin: '2.0.21', androidJarSha256: sha256(await readFile(androidJar)), jsonJarSha256: sha256(await readFile(jsonJar)) },
    limitations: ['RecordingRuntime is a JVM test double; no native JS engine, Android process, EGL surface, GPU or device ran', 'Fixture is handwritten compiler input, not an upstream weapp-vite build'],
  }
  if (options.has('--report')) await writeFile(options.get('--report'), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  await rm(owned, { recursive: true, force: true })
}
