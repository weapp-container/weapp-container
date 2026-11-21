import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const producer = resolve(root, 'scripts/build-android-apk.mjs')

test('Android APK producer help does not probe the SDK or create output', () => {
  const result = spawnSync(process.execPath, [producer, '--help'], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--engine quickjs\|v8/)
  assert.equal(result.stderr, '')
})

test('Android APK producer passes the selected engine to Gradle', () => {
  const source = readFileSync(producer, 'utf8')
  assert.match(source, /`-PweappContainerEngine=\$\{engine\}`/)
})

test('Android Activity uses the APK engine when no intent override is supplied', () => {
  const activity = readFileSync(resolve(root, 'examples/hosts/android/app/src/main/java/com/sonofmagic/weapp/container/MainActivity.kt'), 'utf8')
  assert.match(activity, /intent\.getStringExtra\("weappContainerEngine"\) \?: BuildConfig\.WEAPP_CONTAINER_ENGINE/)
})

test('Android Gradle config validates and embeds the configured engine', () => {
  const gradle = readFileSync(resolve(root, 'examples/hosts/android/app/build.gradle.kts'), 'utf8')
  assert.match(gradle, /providers\.gradleProperty\("weappContainerEngine"\)\.orElse\("quickjs"\)/)
  assert.match(gradle, /require\(configuredEngine == "quickjs" \|\| configuredEngine == "v8"\)/)
  assert.match(gradle, /buildConfigField\("String", "WEAPP_CONTAINER_ENGINE", "\\"\$configuredEngine\\""\)/)
})

test('Android JNI target links the NDK C++ runtime required by V8', () => {
  const cmake = readFileSync(resolve(root, 'examples/hosts/android/app/src/main/cpp/CMakeLists.txt'), 'utf8')
  const linkLibraries = cmake.match(/target_link_libraries\(weapp_container PRIVATE([\s\S]*?)\)/)?.[1]

  assert.ok(linkLibraries, 'JNI target must declare its link dependencies')
  assert.match(linkLibraries, /\bc\+\+_shared\b/)
  assert.match(cmake, /WEAPP_CONTAINER_ANDROID_CXX_SHARED/)
  assert.match(cmake, /libc\+\+_shared\.so/)
})

test('Android Gradle build passes a generated jniLibs directory to CMake', () => {
  const gradle = readFileSync(resolve(root, 'examples/hosts/android/app/build.gradle.kts'), 'utf8')
  assert.match(gradle, /WEAPP_CONTAINER_ANDROID_JNI_LIBS_DIR=\$\{rustJniLibsDir\.get\(\)\.asFile\.absolutePath\}/)
})

test('Android APK producer requires the dynamic C++ runtime in the APK', () => {
  const source = readFileSync(producer, 'utf8')
  assert.match(source, /lib\/arm64-v8a\/libc\+\+_shared\.so/)
  assert.match(source, /embeddedCxxRuntime\.bytes > 0/)
})
