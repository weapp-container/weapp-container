/** Bind an explicitly selected external reference fixture to committed bytes. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

const SOURCE = 'examples/apps/reference-app'
const GENERATED = new Set(['.weapp-container', '.weapp-vite', 'dist', 'node_modules'])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export function verifyReferenceFixture(root, project) {
  const projectStat = lstatSync(project)
  assert.equal(projectStat.isSymbolicLink(), false, 'reference fixture project cannot alias another source')
  assert.equal(projectStat.isDirectory(), true, 'reference fixture project must be a directory')
  const git = args => execFileSync('git', args, { cwd: root })
  const sourceCommit = git(['rev-parse', 'HEAD']).toString().trim()
  const files = git(['ls-tree', '-rz', '--name-only', sourceCommit, '--', SOURCE]).toString().split('\0').filter(Boolean)
  assert.ok(files.length > 0, 'committed reference-app files must exist')
  const hashes = {}
  const expected = new Set()
  for (const file of files) {
    const local = file.slice(`${SOURCE}/`.length)
    assert.ok(local && !local.startsWith('..'), 'reference path stays inside project')
    const target = resolve(project, local)
    let cursor = target
    while (cursor !== resolve(project)) {
      assert.equal(lstatSync(cursor).isSymbolicLink(), false, `reference fixture cannot alias another source: ${local}`)
      cursor = resolve(cursor, '..')
    }
    const bytes = readFileSync(target)
    const committed = git(['show', `${sourceCommit}:${file}`])
    assert.ok(bytes.equals(committed), `reference fixture differs from committed source: ${local}`)
    hashes[local] = sha256(bytes)
    expected.add(local)
  }
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && GENERATED.has(entry.name)) continue
      const target = resolve(directory, entry.name)
      const local = relative(project, target).split(sep).join('/')
      assert.equal(entry.isSymbolicLink(), false, `reference fixture cannot contain source symlinks: ${local}`)
      if (entry.isDirectory()) visit(target)
      else assert.ok(expected.has(local), `uncommitted source may change reference behavior: ${local}`)
    }
  }
  visit(project)
  return { schemaVersion: 1, kind: 'committed-reference-app', sourceCommit, sourceRoot: SOURCE,
    project: resolve(project), fileCount: files.length, sha256: hashes,
    rootSha256: sha256(JSON.stringify(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)))),
    verified: true }
}
