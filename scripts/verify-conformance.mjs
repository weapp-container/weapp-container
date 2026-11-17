#!/usr/bin/env node
/** Validate the repository's portable conformance fixtures. */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixtureRoot = join(root, 'conformance', 'fixtures')
const fail = message => { throw new Error(`Conformance fixtures invalid: ${message}`) }

if (!existsSync(fixtureRoot) || !lstatSync(fixtureRoot).isDirectory()) fail('missing conformance/fixtures')

let files = 0
let jsonFiles = 0
const visit = directory => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) fail(`symbolic link is not allowed: ${path}`)
    if (stat.isDirectory()) { visit(path); continue }
    if (!stat.isFile()) fail(`unsupported fixture entry: ${path}`)
    files += 1
    if (name.endsWith('.json')) {
      jsonFiles += 1
      try { JSON.parse(readFileSync(path, 'utf8')) } catch (error) { fail(`${path}: ${error.message}`) }
    }
  }
}
visit(fixtureRoot)
if (files === 0 || jsonFiles === 0) fail('fixture directory is empty')
console.log(`Portable conformance fixtures accepted: ${files} files, ${jsonFiles} JSON documents`)
