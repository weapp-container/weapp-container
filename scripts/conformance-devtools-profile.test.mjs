import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareSelectedDevtoolsProfile } from './conformance-devtools-runner.mjs'

test('first-use selected profile initializes empty Default and preserves existing account files', async t => {
  const profileDir = await mkdtemp(join(tmpdir(), 'weapp-selected-profile-'))
  t.after(() => rm(profileDir, { recursive: true, force: true }))
  const initial = await prepareSelectedDevtoolsProfile({ profileDir })
  assert.equal(initial.created, true)
  assert.equal(initial.accountDataCopied, false)
  assert.deepEqual(await readdir(initial.directory), [])
  await writeFile(join(initial.directory, 'existing-settings.json'), '{"preserved":true}\n')
  const repeated = await prepareSelectedDevtoolsProfile({ profileDir })
  assert.equal(repeated.created, false)
  assert.equal(await readFile(join(initial.directory, 'existing-settings.json'), 'utf8'), '{"preserved":true}\n')
})

test('profile initialization rejects nonabsolute or redirected Default paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'weapp-profile-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(prepareSelectedDevtoolsProfile({ profileDir: 'relative' }), /absolute/)
  const profileDir = join(root, 'selected')
  const foreign = join(root, 'foreign')
  await mkdir(profileDir)
  await mkdir(foreign)
  await symlink(foreign, join(profileDir, 'Default'), 'junction')
  await assert.rejects(prepareSelectedDevtoolsProfile({ profileDir }), /not a symlink or file/)
  assert.deepEqual(await readdir(foreign), [])
})
