import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))

test('native clock and surface-id parsing preserves u64 without JS number rounding', t => {
  const compiler = process.env.CXX || 'c++'
  const probe = spawnSync(compiler, ['--version'], { encoding: 'utf8' })
  if (probe.error?.code === 'ENOENT') return t.skip('C++ compiler is not installed')
  assert.equal(probe.status, 0, probe.stderr)
  const scratch = mkdtempSync(join(tmpdir(), 'weapp-harmony-numbers-'))
  try {
    const source = join(scratch, 'test.cpp')
    const executable = join(scratch, process.platform === 'win32' ? 'test.exe' : 'test')
    writeFileSync(source, `
#include "bridge_numbers.h"
#include <cassert>
#include <limits>
int main() {
    uint64_t value = 42;
    assert(weapp_container::ParseUint64("1792541179123456789", &value));
    assert(value == UINT64_C(1792541179123456789));
    assert(weapp_container::ParseUint64("18446744073709551615", &value));
    assert(value == std::numeric_limits<uint64_t>::max());
    for (auto text : {"", "-1", "+1", " 1", "1 ", "1.0", "1e9", "NaN", "18446744073709551616"}) {
        value = 42;
        assert(!weapp_container::ParseUint64(text, &value));
        assert(value == 42);
    }
    assert(weapp_container::ParseUint64("0000", &value) && value == 0);
    assert(!weapp_container::ParseUint64("1", nullptr));
}
`)
    const compiled = spawnSync(compiler, [
      '-std=c++17', '-Wall', '-Wextra', '-Werror',
      '-I', resolve(root, 'examples/hosts/harmony/entry/src/main/cpp'),
      source, '-o', executable,
    ], { encoding: 'utf8' })
    assert.equal(compiled.status, 0, compiled.stderr)
    const executed = spawnSync(executable, [], { encoding: 'utf8' })
    assert.equal(executed.status, 0, executed.stderr)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
