#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function tomlNames(content, section) {
  let current = null
  const names = []
  for (const line of content.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/)
    if (header) current = header[1]
    if (current !== section) continue
    const name = line.match(/^\s*name\s*=\s*(?:"([^"]+)"|'([^']+)')\s*(?:#.*)?$/)
    if (name) names.push(name[1] ?? name[2])
  }
  return names
}

// Check declarations at the public package, executable and embedding boundary.
// Test fixtures and private evidence are not a source of public interface names.
export async function auditProductNaming({ root = ROOT } = {}) {
  const report = { schemaVersion: 2, status: 'passed', checkedFiles: 0, checkedDeclarations: 0, findings: [] }
  const contents = new Map()
  async function source(path) {
    if (contents.has(path)) return contents.get(path)
    try {
      const location = resolve(root, path)
      const info = await lstat(location)
      if (!info.isFile() || info.isSymbolicLink()) throw Error('Declaration must be a regular file')
      const text = await readFile(location, 'utf8')
      contents.set(path, text)
      report.checkedFiles += 1
      return text
    } catch (error) {
      contents.set(path, null)
      report.findings.push({ path, kind: 'unreadable-declaration', reason: error.code || error.message })
      return null
    }
  }
  function check(path, declaration, actual, expected) {
    report.checkedDeclarations += 1
    if (JSON.stringify(actual) !== JSON.stringify(expected)) report.findings.push({ path, kind: 'public-name', declaration, actual, expected })
  }
  async function packageJson(path, expectedName, expectedBin) {
    const text = await source(path)
    if (text === null) return
    let value
    try { value = JSON.parse(text) } catch { report.findings.push({ path, kind: 'invalid-json' }); return }
    check(path, 'package.name', value.name ?? null, expectedName)
    if (expectedBin) check(path, 'package.bin', value.bin ?? null, expectedBin)
  }
  await packageJson('package.json', '@sonofmagic/weapp-container')
  await packageJson('tools/container-manifest/package.json', '@sonofmagic/container-manifest', { 'container-pack': './dist/cli.mjs' })
  for (const [path, names] of [
    ['crates/container-simulator/Cargo.toml', { package: 'container-simulator', bin: 'weapp-simulator' }],
    ['crates/container-sdk-ffi/Cargo.toml', { package: 'container-sdk-ffi', lib: 'weapp_container_sdk' }],
  ]) {
    const text = await source(path)
    if (text === null) continue
    for (const [section, expected] of Object.entries(names)) check(path, section + '.name', tomlNames(text, section), [expected])
  }
  const readme = await source('README.md')
  if (readme !== null) check('README.md', 'product title', readme.match(/^#\s+(.+)$/m)?.[1] ?? null, 'Weapp Container')
  const abiPath = 'crates/container-sdk-ffi/src/lib.rs'
  const abi = await source(abiPath)
  if (abi !== null) {
    const names = [...abi.matchAll(/#\[no_mangle\]\s*pub\s+(?:unsafe\s+)?extern\s*"C"\s+fn\s+([A-Za-z_]\w*)/g)].map(match => match[1])
    report.checkedDeclarations += 1
    if (!names.length || names.some(name => !name.startsWith('weapp_container_sdk_')) || new Set(names).size !== names.length) {
      report.findings.push({ path: abiPath, kind: 'public-abi', actual: names, expectedPrefix: 'weapp_container_sdk_' })
    }
  }
  if (report.findings.length) report.status = 'failed'
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await auditProductNaming()
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = report.status === 'passed' ? 0 : 1
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
