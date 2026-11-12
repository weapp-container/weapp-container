import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

async function withTools(verify) {
  const root = await mkdtemp(join(tmpdir(), 'weapp-toolchain-'))
  try {
    const bin = join(root, 'bin')
    await mkdir(bin)
    const log = join(root, 'probes.log')
    for (const name of ['rustc', 'cargo', 'node', 'git', 'rustup', 'xcodebuild', 'hdc']) {
      await writeFile(join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$WEAPP_CONTAINER_TEST_PROBE_LOG"\nprintf '%s\\n' 'fixture-version'\nexit 0\n`, { mode: 0o755 })
    }
    const env = { ...process.env, PATH: bin, WEAPP_CONTAINER_TEST_PROBE_LOG: log,
      ANDROID_HOME: join(root, 'missing-android'), ANDROID_SDK_ROOT: join(root, 'missing-android'),
      DEVELOPER_DIR: join(root, 'missing-xcode'), HARMONY_HOME: join(root, 'missing-harmony'), HDC: join(bin, 'hdc') }
    const run = (...args) => {
      const result = spawnSync(process.execPath, ['scripts/check-toolchain.mjs', '--json', ...args], { env, encoding: 'utf8' })
      assert.equal(result.error, undefined)
      return { status: result.status, report: JSON.parse(result.stdout) }
    }
    await verify({ root, bin, log, run })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('ordinary setup requires base tools and reports optional SDKs separately', async () => {
  await withTools(async ({ log, run }) => {
    const { status, report } = run()
    assert.equal(status, 0)
    assert.deepEqual(Object.keys(report).sort(), ['optional', 'required', 'rustTargets', 'strict'])
    assert.equal(report.required.length, 4)
    assert.ok(report.required.every(item => item.available))
    assert.ok(report.optional.every(item => !item.complete))
    const commands = (await readFile(log, 'utf8')).trim().split('\n')
    assert.deepEqual([...new Set(commands)].sort(), ['cargo', 'git', 'hdc', 'node', 'rustc', 'rustup', 'xcodebuild'])
    assert.equal(commands.filter(name => name === 'rustc').length, 2)
  })
})

test('strict setup fails on missing SDKs and ordinary setup still fails on a missing base tool', async () => {
  await withTools(async ({ bin, run }) => {
    assert.equal(run('--strict').status, 1)
    await writeFile(join(bin, 'node'), '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    const result = run()
    assert.equal(result.status, 1)
    assert.equal(result.report.required.find(item => item.command === 'node').available, false)
  })
})
