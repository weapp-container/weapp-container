import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { verifyReferenceFixture } from './simulator-reference-fixture.mjs'

test('external reference identity requires every committed byte and rejects extra source, changes and aliases', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'weapp-reference-fixture-'))
  try {
    const repository = resolve(directory, 'repo')
    const source = resolve(repository, 'examples/apps/reference-app')
    const project = resolve(directory, 'copy')
    mkdirSync(source, { recursive: true })
    writeFileSync(resolve(source, 'app.js'), 'App({})\n')
    writeFileSync(resolve(source, 'app.json'), '{"pages":[]}\n')
    const git = args => execFileSync('git', args, { cwd: repository, stdio: 'pipe' })
    git(['init', '--quiet'])
    git(['add', '.'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'])
    cpSync(source, project, { recursive: true })
    const result = verifyReferenceFixture(repository, project)
    assert.equal(result.verified, true)
    assert.equal(result.fileCount, 2)
    assert.match(result.rootSha256, /^[a-f0-9]{64}$/)
    if (process.platform !== 'win32') {
      const alias = resolve(directory, 'project-alias')
      symlinkSync(source, alias, 'dir')
      assert.throws(() => verifyReferenceFixture(repository, alias), /project cannot alias another source/)
      rmSync(alias)
    }
    mkdirSync(resolve(project, '.weapp-container'))
    writeFileSync(resolve(project, '.weapp-container/generated.json'), '{}')
    assert.equal(verifyReferenceFixture(repository, project).rootSha256, result.rootSha256, 'owned generated state does not alter source identity')
    writeFileSync(resolve(project, 'vite.config.js'), 'export default {}')
    assert.throws(() => verifyReferenceFixture(repository, project), /uncommitted source/)
    rmSync(resolve(project, 'vite.config.js'))
    writeFileSync(resolve(project, 'app.js'), 'App({changed:true})\n')
    assert.throws(() => verifyReferenceFixture(repository, project), /differs from committed source/)
    rmSync(resolve(project, 'app.js'))
    if (process.platform !== 'win32') {
      symlinkSync(resolve(source, 'app.js'), resolve(project, 'app.js'))
      assert.throws(() => verifyReferenceFixture(repository, project), /alias another source/)
      rmSync(resolve(project, 'app.js'))
    }
    assert.throws(() => verifyReferenceFixture(repository, project), /ENOENT/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
