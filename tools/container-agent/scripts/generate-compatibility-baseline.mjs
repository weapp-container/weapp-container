import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = join(packageRoot, '../..')
const inventory = JSON.parse(await readFile(join(repositoryRoot, 'docs/api-inventory-v1.json'), 'utf8'))
const baseline = {
  schemaVersion: 1,
  baseline: {
    kind: 'weapp-api-inventory',
    schemaVersion: inventory.schemaVersion,
    manifestVersion: inventory.manifestVersion,
    protocolVersion: inventory.protocolVersion,
    hosts: inventory.hosts,
    engines: inventory.engines,
  },
  apiRows: inventory.apis.flatMap(api => api.names.map(name => ({
    name,
    priority: 'P1',
    weappContainer: {
      status: api.support,
      evidence: api.conformance,
      hostCoverage: api.hostCoverage,
      engineCoverage: api.engineCoverage,
    },
  }))),
}
const output = join(packageRoot, 'dist/compatibility-baseline.json')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(baseline)}\n`)
