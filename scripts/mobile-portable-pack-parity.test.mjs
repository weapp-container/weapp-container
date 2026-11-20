import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultIOSPack, defaultPortablePackSource } from './sync-ios-portable-pack.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const androidPack = resolve(root, 'examples/hosts/android/app/src/main/assets/portable-pack')

async function filesUnder(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      for (const child of await filesUnder(path)) files.push(`${entry.name}/${child}`)
    } else files.push(entry.name)
  }
  return files.sort()
}

test('Android and iOS checked-in portable packs remain byte-identical', async () => {
  assert.equal(defaultPortablePackSource, androidPack)
  const files = await filesUnder(androidPack)
  assert.deepEqual(await filesUnder(defaultIOSPack), files)
  for (const file of files) {
    assert.deepEqual(
      await readFile(resolve(defaultIOSPack, file)),
      await readFile(resolve(androidPack, file)),
      `portable pack differs: ${file}`,
    )
  }
})
