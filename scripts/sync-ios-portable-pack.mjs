#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncPortablePack } from './portable-pack.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const defaultIOSPack = resolve(root, 'examples/hosts/ios/Sources/WeappContainerSmoke/Resources/portable-pack')
export function syncIOSPortablePack(options = {}) {
  return syncPortablePack({
    source: resolve(root, 'artifacts/reference-app/pack'),
    destination: defaultIOSPack,
    ...options,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const options = {}
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--check') options.check = true
      else if (args[index] === '--source' || args[index] === '--destination') {
        const name = args[index].slice(2)
        if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${args[index]} needs a path`)
        options[name] = resolve(args[++index])
      } else throw new Error(`unknown argument: ${args[index]}`)
    }
    console.log(JSON.stringify(await syncIOSPortablePack(options), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
