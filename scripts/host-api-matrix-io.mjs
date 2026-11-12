import { realpath, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, sep } from 'node:path'

const run = promisify(execFile)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const key = (...parts) => JSON.stringify(parts)
const fingerprint = value => key(...['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(name => String(value[name])))
const memo = (cache, id, operation) => {
  if (!cache.has(id)) cache.set(id, Promise.resolve().then(operation))
  return cache.get(id)
}

/** One validation run owns one immutable read snapshot. No cache survives a
 * process run, and the final barrier rechecks every current file and Git HEAD.
 * Content hashes supplement inode/ctime/mtime checks, including same-size edits
 * and replacements that restore their original mtime. */
export async function createMatrixValidationIo(root, { execute = run } = {}) {
  const rootPath = await realpath(root)
  const repositories = new Map(), current = new Map(), committed = new Map(), ancestors = new Map()
  const counts = { repositories: 0, currentFiles: 0, committedFiles: 0, ancestryChecks: 0 }
  let sealed = false
  const active = () => { if (sealed) throw new Error('Matrix validation I/O snapshot is already sealed') }
  const inside = (directory, target) => target.startsWith(directory + sep)
  const repositoryPath = repository => {
    active()
    return memo(repositories, repository, async () => {
      const requested = resolve(rootPath, repository), directory = await realpath(requested)
      if (directory !== rootPath && !inside(rootPath, directory)) throw new Error('Evidence source escapes repository')
      const { stdout } = await execute('git', ['rev-parse', '--show-toplevel'], { cwd: directory })
      if (await realpath(stdout.trim()) !== directory) throw new Error('Evidence source is not a repository root')
      const { stdout: head } = await execute('git', ['rev-parse', '--verify', 'HEAD'], { cwd: directory })
      counts.repositories++
      return { requested, directory, head: head.trim() }
    })
  }
  async function capture(directory, relative) {
    const requested = resolve(directory, relative)
    let target
    try { target = await realpath(requested) }
    catch (error) {
      // A missing optional native translation unit is itself an inventory
      // observation. It must remain absent until the final barrier.
      if (error.code === 'ENOENT') return { requested, missing: true, error }
      throw error
    }
    if (!inside(directory, target)) throw new Error('Evidence path escapes repository')
    const handle = await open(target, 'r')
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile()) throw new Error('Evidence path is not a regular file')
      const bytes = await handle.readFile(), after = await handle.stat({ bigint: true })
      if (fingerprint(before) !== fingerprint(after) || await realpath(requested) !== target) throw new Error(`Evidence file changed during read: ${requested}`)
      return { requested, directory, relative, target, bytes, sha256: digest(bytes), fingerprint: fingerprint(after) }
    } finally { await handle.close() }
  }
  async function readSource(repository, relative) {
    active()
    const entry = await memo(current, key(repository, relative), async () => {
      const { directory } = await repositoryPath(repository)
      counts.currentFiles++
      return capture(directory, relative)
    })
    if (entry.missing) throw entry.error
    // A consumer cannot mutate the cached byte snapshot through its Buffer.
    return Buffer.from(entry.bytes)
  }
  const readCommittedSource = (repository, commit, relative) => {
    active()
    return memo(committed, key(repository, commit, relative), async () => {
      const { directory } = await repositoryPath(repository)
      counts.committedFiles++
      return (await execute('git', ['show', `${commit}:${relative}`], { cwd: directory, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })).stdout
    }).then(bytes => Buffer.from(bytes))
  }
  const verifyCommit = (repository, commit) => {
    active()
    return memo(ancestors, key(repository, commit), async () => {
      const { directory, head } = await repositoryPath(repository)
      counts.ancestryChecks++
      try { await execute('git', ['merge-base', '--is-ancestor', commit, head], { cwd: directory }); return true }
      catch { return false }
    })
  }
  async function assertUnchanged() {
    active()
    // Seal first: no late caller can add an unchecked entry during the barrier.
    sealed = true
    for (const pending of current.values()) {
      const entry = await pending
      if (entry.missing) {
        try { await realpath(entry.requested) }
        catch (error) { if (error.code === 'ENOENT') continue; throw error }
        throw new Error(`Evidence file appeared during validation: ${entry.requested}`)
      }
      if (await realpath(entry.requested) !== entry.target) throw new Error(`Evidence file target changed during validation: ${entry.requested}`)
      const fresh = await capture(entry.directory, entry.relative)
      if (fresh.fingerprint !== entry.fingerprint || fresh.sha256 !== entry.sha256) throw new Error(`Evidence file changed during validation: ${entry.requested}`)
    }
    for (const pending of repositories.values()) {
      const repository = await pending
      if (await realpath(repository.requested) !== repository.directory) throw new Error('Evidence repository target changed during validation')
      const { stdout } = await execute('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repository.directory })
      if (stdout.trim() !== repository.head) throw new Error(`Evidence repository HEAD changed during validation: ${repository.directory}`)
    }
  }
  return { readSource, read: async relative => (await readSource('.', relative)).toString('utf8'), load: relative => readSource('.', relative),
    readCommittedSource, verifyCommit, assertUnchanged, stats: () => ({ ...counts }) }
}
