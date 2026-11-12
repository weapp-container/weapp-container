import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('isolated Harmony N-API objects retain actual independent Rust/QuickJS owners', { timeout: 180000 }, t => {
  if (!['darwin', 'linux'].includes(process.platform)) return t.skip('local Node N-API linking requires macOS or Linux; Harmony HAP compilation is a separate gate');
  const library = resolve(root, process.env.CARGO_TARGET_DIR ?? 'target', 'debug', process.platform === 'darwin' ? 'libcontainer_host_harmony.dylib' : 'libcontainer_host_harmony.so');
  {
    // Cargo freshness must be checked even when a previous cdylib exists.
    const build = spawnSync('cargo', ['build', '-p', 'container-host-harmony', '--features', 'quickjs-native', '--locked'], { cwd: root, encoding: 'utf8', timeout: 120000 });
    assert.equal(build.status, 0, build.stdout + build.stderr);
  }
  const nodeHeaders = process.env.NODE_API_INCLUDE ?? [resolve(dirname(process.execPath), '../include/node'), '/opt/homebrew/include/node', '/usr/include/node'].find(path => existsSync(join(path, 'node_api.h')));
  assert(nodeHeaders, 'Node N-API headers are required for the actual native owner gate');
  const scratch = mkdtempSync(join(tmpdir(), 'weapp-harmony-native-owner-'));
  const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const inputPaths = ['examples/hosts/harmony/entry/src/main/cpp/native_bridge.cpp', 'examples/hosts/harmony/entry/src/main/cpp/weapp_container_harmony_ffi.h', 'scripts/fixtures/harmony-native-owner-probe.cjs', 'scripts/fixtures/harmony-reference-owner-probe.mjs', 'examples/hosts/harmony/entry/src/main/ets/session/HostServices.ts', 'examples/hosts/harmony/entry/src/main/ets/session/ReferenceHostServices.ts'];
  const inputs = inputPaths.map(path => ({ path, sha256: sha(join(root, path)) }));
  try {
    for (const name of ['napi', 'EGL', 'GLES3', 'native_window']) mkdirSync(join(scratch, name));
    writeFileSync(join(scratch, 'napi/native_api.h'), '#include <node_api.h>\n#define EXTERN_C_START extern "C" {\n#define EXTERN_C_END }\n');
    // The production bridge is compiled unchanged against the real Node
    // N-API ABI and actual Rust cdylib. Graphics are an unavailable platform
    // boundary in this local test: invoking any graphics function aborts.
    writeFileSync(join(scratch, 'EGL/egl.h'), `#pragma once
#include <cstdlib>
#include <cstdint>
using EGLDisplay=void*;using EGLSurface=void*;using EGLContext=void*;using EGLConfig=void*;using EGLNativeWindowType=uintptr_t;using EGLint=int;using EGLBoolean=int;
#define EGL_NO_DISPLAY nullptr
#define EGL_NO_SURFACE nullptr
#define EGL_NO_CONTEXT nullptr
#define EGL_DEFAULT_DISPLAY nullptr
#define EGL_TRUE 1
enum {EGL_CONTEXT_LOST=1,EGL_BAD_CONTEXT,EGL_BAD_SURFACE,EGL_BAD_DISPLAY,EGL_NOT_INITIALIZED,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_SURFACE_TYPE,EGL_WINDOW_BIT,EGL_RED_SIZE,EGL_GREEN_SIZE,EGL_BLUE_SIZE,EGL_ALPHA_SIZE,EGL_NONE,EGL_OPENGL_ES_API,EGL_CONTEXT_CLIENT_VERSION,EGL_WIDTH,EGL_HEIGHT};
inline EGLint eglGetError(){std::abort();}
inline EGLBoolean eglMakeCurrent(EGLDisplay,EGLSurface,EGLSurface,EGLContext){std::abort();}
inline EGLBoolean eglDestroySurface(EGLDisplay,EGLSurface){std::abort();}
inline EGLBoolean eglDestroyContext(EGLDisplay,EGLContext){std::abort();}
inline EGLBoolean eglTerminate(EGLDisplay){std::abort();}
inline EGLDisplay eglGetDisplay(void*){std::abort();}
inline EGLBoolean eglInitialize(EGLDisplay,EGLint*,EGLint*){std::abort();}
inline EGLBoolean eglChooseConfig(EGLDisplay,const EGLint*,EGLConfig*,EGLint,EGLint*){std::abort();}
inline EGLBoolean eglBindAPI(int){std::abort();}
inline EGLSurface eglCreateWindowSurface(EGLDisplay,EGLConfig,EGLNativeWindowType,const EGLint*){std::abort();}
inline EGLContext eglCreateContext(EGLDisplay,EGLConfig,EGLContext,const EGLint*){std::abort();}
inline EGLBoolean eglQuerySurface(EGLDisplay,EGLSurface,EGLint,EGLint*){std::abort();}
inline EGLBoolean eglSwapBuffers(EGLDisplay,EGLSurface){std::abort();}
`);
    writeFileSync(join(scratch, 'GLES3/gl3.h'), '#include <cstdlib>\nusing GLint=int;\n#define GL_FRAMEBUFFER_BINDING 0\ninline void glGetIntegerv(int,GLint*){std::abort();}\n');
    writeFileSync(join(scratch, 'native_window/external_window.h'), '#include <cstdlib>\n#include <cstdint>\nstruct OHNativeWindow {};\ninline void OH_NativeWindow_DestroyNativeWindow(OHNativeWindow*){std::abort();}\ninline int OH_NativeWindow_CreateNativeWindowFromSurfaceId(uint64_t,OHNativeWindow**){std::abort();}\n');
    const addon = join(scratch, 'native-owner.node');
    const compiled = spawnSync(process.env.CXX ?? 'c++', ['-std=c++17', '-shared', '-fPIC', '-I', scratch, '-I', nodeHeaders,
      ...(process.platform === 'darwin' ? ['-undefined', 'dynamic_lookup'] : []),
      join(root, 'examples/hosts/harmony/entry/src/main/cpp/native_bridge.cpp'), library, '-o', addon], { cwd: root, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const execution = spawnSync(process.execPath, ['--expose-gc', join(root, 'scripts/fixtures/harmony-native-owner-probe.cjs'), addon], { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(execution.status, 0, execution.stdout + execution.stderr);
    const result = JSON.parse(execution.stdout.trim());
    assert.equal(result.passed, true); assert.equal(result.harmonyDevice, 'not-run');
    const reference = spawnSync(process.execPath, [join(root, 'scripts/fixtures/harmony-reference-owner-probe.mjs'), addon], { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(reference.status, 0, (reference.stdout + reference.stderr).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[production ArkTS module]'));
    const identityResult=JSON.parse(reference.stdout.trim());assert.equal(identityResult.passed,true);assert.equal(identityResult.harmonyDevice,'not-run');
    assert.deepEqual(inputPaths.map(path => ({ path, sha256: sha(join(root, path)) })), inputs, 'native owner sources must not change during compilation/execution');
    t.diagnostic(JSON.stringify({ ...result, identity:identityResult, nodeVersion: process.version, sourceInputs: inputs, nativeLibrary: { path: library, sha256: sha(library) }, addonSha256: sha(addon) }));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
