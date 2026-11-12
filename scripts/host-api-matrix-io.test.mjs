import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, stat, utimes, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createMatrixValidationIo } from './host-api-matrix-io.mjs'

const execute = promisify(execFile)
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'matrix-io-')), root = join(directory, 'root')
  await mkdir(root)
  t.after(() => rm(directory, { recursive: true, force: true }))
  const calls = [], command = async (args, cwd = root) => execute('git', args, { cwd })
  const initialize = async (cwd, value) => {
    await command(['init', '-q'], cwd)
    await command(['config', 'user.email', 'matrix-test@example.invalid'], cwd)
    await command(['config', 'user.name', 'Matrix I/O test'], cwd)
    await writeFile(join(cwd, 'source.js'), value)
    await command(['add', 'source.js'], cwd)
    await command(['commit', '-qm', 'fixture source'], cwd)
    return (await command(['rev-parse', 'HEAD'], cwd)).stdout.trim()
  }
  const commit = await initialize(root, 'current root source')
  const io = await createMatrixValidationIo(root, { execute: async (name, args, options) => {
    calls.push({ name, args, cwd: options.cwd })
    return execute(name, args, options)
  } })
  return { directory, root, commit, io, calls, command, initialize }
}

test('one run deduplicates concurrent current/blob/ancestor reads without exposing mutable cache bytes', async t => {
  const f = await fixture(t)
  const values = await Promise.all(Array.from({ length: 24 }, async () => ({
    source: await f.io.readSource('.', 'source.js'), committed: await f.io.readCommittedSource('.', f.commit, 'source.js'),
    reachable: await f.io.verifyCommit('.', f.commit),
  })))
  for (const value of values) {
    assert.equal(value.source.toString(), 'current root source')
    assert.deepEqual(value.committed, value.source)
    assert.equal(value.reachable, true)
  }
  values[0].source.fill(0); values[0].committed.fill(0)
  assert.equal((await f.io.readSource('.', 'source.js')).toString(), 'current root source')
  assert.equal((await f.io.readCommittedSource('.', f.commit, 'source.js')).toString(), 'current root source')
  assert.deepEqual(f.io.stats(), { repositories: 1, currentFiles: 1, committedFiles: 1, ancestryChecks: 1 })
  assert.equal(f.calls.filter(call => call.args[0] === 'show').length, 1)
  assert.equal(f.calls.filter(call => call.args[0] === 'merge-base').length, 1)
  await f.io.assertUnchanged()
  assert.equal(f.calls.filter(call => call.args[0] === 'rev-parse').length, 3)
  await assert.rejects(f.io.readSource('.', 'source.js'), /already sealed/)
})

test('repository/path and repository/commit/path cache identities keep nested SDK sources separate', async t => {
  const f = await fixture(t), sdk = join(f.root, 'sdk')
  await mkdir(sdk); const sdkCommit = await f.initialize(sdk, 'different SDK source')
  assert.equal((await f.io.readSource('.', 'source.js')).toString(), 'current root source')
  assert.equal((await f.io.readSource('sdk', 'source.js')).toString(), 'different SDK source')
  assert.equal((await f.io.readCommittedSource('sdk', sdkCommit, 'source.js')).toString(), 'different SDK source')
  assert.equal(await f.io.verifyCommit('sdk', sdkCommit), true)
  await f.io.assertUnchanged()
  assert.equal(f.io.stats().repositories, 2)
})

test('same-size edits and restored contents/mtime invalidate a current source snapshot', async t => {
  for (const restoreContents of [false, true]) {
    const f = await fixture(t), file = join(f.root, 'source.js'), before = await stat(file)
    await f.io.readSource('.', 'source.js')
    await writeFile(file, 'changed root source')
    if (restoreContents) await writeFile(file, 'current root source')
    await utimes(file, before.atime, before.mtime)
    // Reads consistently use the original snapshot, but it cannot be published.
    assert.equal((await f.io.readSource('.', 'source.js')).toString(), 'current root source')
    await assert.rejects(f.io.assertUnchanged(), /file changed during validation/)
  }
})

test('a same-content inode replacement cannot silently reuse a cached source', async t => {
  const f = await fixture(t), file = join(f.root, 'source.js'), replacement = join(f.root, 'replacement.js')
  await f.io.readSource('.', 'source.js')
  await writeFile(replacement, await readFile(file)); await rename(replacement, file)
  await assert.rejects(f.io.assertUnchanged(), /file changed during validation/)
})

test('missing optional source observations must stay absent and repeated failures remain cached', async t => {
  const f = await fixture(t)
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(f.io.readSource('.', 'missing.js'), { code: 'ENOENT' })
  assert.equal(f.io.stats().currentFiles, 1)
  await writeFile(join(f.root, 'missing.js'), 'newly installed provider')
  await assert.rejects(f.io.assertUnchanged(), /file appeared during validation/)
  const stable = await fixture(t)
  await assert.rejects(stable.io.readSource('.', 'missing.js'), { code: 'ENOENT' })
  await stable.io.assertUnchanged()
})

test('reachability is pinned to the observed HEAD and HEAD changes invalidate the run', async t => {
  const f = await fixture(t)
  assert.equal(await f.io.verifyCommit('.', f.commit), true)
  await f.command(['commit', '--allow-empty', '-qm', 'head changed'])
  assert.equal(await f.io.verifyCommit('.', f.commit), true)
  await assert.rejects(f.io.assertUnchanged(), /HEAD changed during validation/)
})

test('failed ancestor and Git blob checks cannot become successful cache entries', async t => {
  const f = await fixture(t), missingCommit = '0'.repeat(40)
  assert.deepEqual(await Promise.all([f.io.verifyCommit('.', missingCommit), f.io.verifyCommit('.', missingCommit)]), [false, false])
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(f.io.readCommittedSource('.', f.commit, 'missing.js'))
  assert.equal(f.calls.filter(call => call.args[0] === 'merge-base').length, 1)
  assert.equal(f.calls.filter(call => call.args[0] === 'show').length, 1)
})

test('repository roots and source symlinks cannot escape the validated repository', async t => {
  const f = await fixture(t), outside = join(f.directory, 'outside.js')
  await writeFile(outside, 'private outside bytes'); await symlink(outside, join(f.root, 'escape.js'))
  await assert.rejects(f.io.readSource('.', 'escape.js'), /path escapes repository/)
  await mkdir(join(f.root, 'ordinary-directory'))
  await assert.rejects(f.io.readSource('ordinary-directory', 'source.js'), /not a repository root/)
  const clean = await fixture(t), target = join(clean.root, 'source.js'), alias = join(clean.root, 'alias.js')
  await symlink(target, alias); await clean.io.readSource('.', 'alias.js')
  await rm(alias); await symlink(await realpath(outside), alias)
  await assert.rejects(clean.io.assertUnchanged(), /file target changed during validation/)
})
