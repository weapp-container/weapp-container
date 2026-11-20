import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { weappContainerTest } from '../dist/config.mjs'

async function artifactRoot(t, managed) {
  const root = await mkdtemp(join(tmpdir(), 'weapp-container-vitest-'))
  await mkdir(join(root, 'pack'))
  await mkdir(join(root, 'source'))
  if (managed) await writeFile(join(root, '.weapp-container-test-artifact'), '1\n')
  t.after(() => rm(root, { recursive: true, force: true }))
  return { packPath: join(root, 'pack'), sourceRoot: join(root, 'source'), generationRoot: root }
}

function harness({ artifact, watch = false, options = {} }) {
  const provided = []
  const closeHandlers = []
  const errors = []
  const reruns = []
  const project = { config: { watch }, provide: (key, value) => provided.push({ key, value }) }
  const plugin = weappContainerTest({ artifact, ...options })
  return {
    provided, closeHandlers, errors, reruns,
    configure: () => plugin.configureVitest({
      project,
      vitest: {
        config: { watch },
        onClose: handler => closeHandlers.push(handler),
        globTestSpecifications: async () => [{ project }, { project: {} }],
        rerunTestSpecifications: async specifications => reruns.push(specifications),
        state: { catchError: error => errors.push(error) },
        logger: { printError: () => {} },
      },
    }),
  }
}

test('publishes a built artifact and closes the plugin lifecycle', async () => {
  const artifact = { packPath: '/tmp/weapp-pack', sourceRoot: '/tmp/weapp-source' }
  const provided = []
  const closeHandlers = []
  const errors = []
  const plugin = weappContainerTest({
    artifact: { build: async () => artifact },
    container: { nowMs: 1234 },
  })

  await plugin.configureVitest({
    project: {
      config: { watch: false },
      provide: (key, value) => provided.push({ key, value }),
    },
    vitest: {
      config: { watch: false },
      onClose: handler => closeHandlers.push(handler),
      state: { catchError: error => errors.push(error) },
      logger: { printError: () => {} },
    },
  })

  assert.deepEqual(provided, [{
    key: 'weappContainerArtifact',
    value: { artifact, options: { nowMs: 1234 } },
  }])
  assert.equal(closeHandlers.length, 1)
  assert.deepEqual(errors, [])
  await closeHandlers[0]()
})

test('preserves custom artifact directories owned by the factory', async t => {
  const artifact = await artifactRoot(t, false)
  const harnessed = harness({ artifact: { build: async () => artifact } })
  await harnessed.configure()
  await harnessed.closeHandlers[0]()
  await access(artifact.generationRoot)
})

test('disposes only marked generations and tolerates duplicate generation references', async t => {
  const artifact = await artifactRoot(t, true)
  const repeated = { ...artifact }
  const harnessed = harness({
    watch: true,
    artifact: {
      watch: async ({ onRebuilt }) => {
        await onRebuilt(repeated)
        return { artifact, generations: [repeated], close() {} }
      },
      build: async () => artifact,
    },
  })
  await harnessed.configure()
  await harnessed.closeHandlers[0]()
  await assert.rejects(access(artifact.generationRoot), { code: 'ENOENT' })
})

test('publishes rebuilds before rerunning only the owning project', async () => {
  const initial = { packPath: '/tmp/initial-pack', sourceRoot: '/tmp/initial-source' }
  const rebuilt = { packPath: '/tmp/rebuilt-pack', sourceRoot: '/tmp/rebuilt-source' }
  let hooks
  const harnessed = harness({
    watch: true,
    artifact: {
      build: async () => initial,
      watch: async value => { hooks = value; return { artifact: initial, close() {} } },
    },
  })
  await harnessed.configure()
  await hooks.onRebuilt(rebuilt)
  assert.equal(harnessed.provided.at(-1).value.artifact, rebuilt)
  assert.equal(harnessed.reruns.length, 1)
  assert.equal(harnessed.reruns[0].length, 1)
  await harnessed.closeHandlers[0]()
})
