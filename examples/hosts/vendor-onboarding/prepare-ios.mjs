import { cp, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeProject } from '../../../sdk/ios/examples/consumer/make-project.mjs'

const [sdk, pack, out] = process.argv.slice(2)
if (!sdk || !pack || !out) throw new Error('Usage: node prepare-ios.mjs <WeappContainer-directory> <portable-pack> <new-output-directory>')
await readFile(join(sdk, 'Package.swift'))
await readFile(join(pack, 'manifest.json'))
const output = resolve(out)
await mkdir(output)
const source = join(dirname(fileURLToPath(import.meta.url)), 'ios')
await cp(join(source, 'Consumer.swift'), join(output, 'Consumer.swift'))
await cp(join(source, 'ConsumerUITests.swift'), join(output, 'ConsumerUITests.swift'))
await cp(sdk, join(output, 'WeappContainer'), { recursive: true })
await cp(pack, join(output, 'portable-pack'), { recursive: true })
console.log(makeProject(output, 'dev.weapp.vendor'))
