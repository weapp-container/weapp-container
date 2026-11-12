import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))

test('Harmony native resize retains every unretired EGL surface identity', async t => {
  const compiler = process.env.CXX || 'c++'
  const probe = spawnSync(compiler, ['--version'], { encoding: 'utf8' })
  if (probe.error?.code === 'ENOENT') return t.skip('C++ compiler is not installed')
  assert.equal(probe.status, 0, probe.stderr)
  const scratch = mkdtempSync(join(tmpdir(), 'weapp-harmony-surfaces-'))
  try {
    // Compile the production function unchanged against a fault-injected EGL
    // boundary. This exercises native ownership, rather than copying its logic
    // into the ArkTS fake or asserting implementation text.
    const native = readFileSync(join(root, 'examples/hosts/harmony/entry/src/main/cpp/native_bridge.cpp'), 'utf8')
    const start = native.indexOf('napi_value RenderSurface(')
    const end = native.indexOf('napi_value DetachSurfaceApi(', start)
    assert.ok(start >= 0 && end > start, 'production RenderSurface must remain identifiable')
    writeFileSync(join(scratch, 'render_surface.inc'), native.slice(start, end))
    const executable = join(scratch, process.platform === 'win32' ? 'test.exe' : 'test')
    const compiled = spawnSync(compiler, [
      '-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', scratch,
      join(root, 'scripts/fixtures/harmony-render-surface-contract.cpp'), '-o', executable,
    ], { encoding: 'utf8' })
    assert.equal(compiled.status, 0, compiled.stderr)
    for (const [id, description] of [
      'successful resize retires old identity and owns replacement',
      'unknown destroy failure preserves original identity and prevents create',
      'BAD_SURFACE proves retirement and permits replacement',
      'create failure leaves no untracked surface and preserves context',
      'makeCurrent failure retains newly created identity for cleanup',
      'query failure retains newly created identity for cleanup',
      'surfaceless transition failure retains original identity',
    ].entries()) {
      await t.test(description, () => {
        const executed = spawnSync(executable, [String(id)], { encoding: 'utf8' })
        assert.equal(executed.status, 0, executed.stderr)
      })
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('Harmony owner retirement preserves the borrowed process display and retries only owned resources', async t => {
  const compiler = process.env.CXX || 'c++';
  const scratch = mkdtempSync(join(tmpdir(), 'weapp-harmony-detach-'));
  try {
    const native = readFileSync(join(root, 'examples/hosts/harmony/entry/src/main/cpp/native_bridge.cpp'), 'utf8');
    const start = native.indexOf('std::string DetachSurface('), end = native.indexOf('void FinalizeHostState(', start);
    assert(start >= 0 && end > start);
    writeFileSync(join(scratch, 'detach_surface.inc'), native.slice(start, end));
    const executable = join(scratch, process.platform === 'win32' ? 'test.exe' : 'test');
    const compiled = spawnSync(compiler, ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', scratch,
      join(root, 'scripts/fixtures/harmony-detach-surface-contract.cpp'), '-o', executable], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    for (const [id, name] of ['success preserves sibling and host display', 'failed surface destruction can retry', 'failed Rust abandonment retains all driver resources', 'lost Rust context is abandoned before owned EGL cleanup'].entries()) {
      await t.test(name, () => {
        const execution = spawnSync(executable, [String(id)], { encoding: 'utf8' });
        assert.equal(execution.status, 0, execution.stderr);
      });
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
