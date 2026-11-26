import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { build } from 'vite'
import { weappContainer } from '../dist/index.mjs'

async function artifactRoot(t, managed) {
  const root = await mkdtemp(join(tmpdir(), 'weapp-container-vite-'))
  await mkdir(join(root, 'pack'))
  await mkdir(join(root, 'source'))
  if (managed) await writeFile(join(root, '.weapp-container-test-artifact'), '1\n')
  t.after(() => rm(root, { recursive: true, force: true }))
  return { packPath: join(root, 'pack'), sourceRoot: join(root, 'source'), generationRoot: root }
}

function resolvedConfig(overrides = {}) {
  return {
    command: 'build',
    mode: 'test',
    root: '/project',
    configFile: '/project/vite.config.ts',
    plugins: [],
    build: { outDir: '/project/dist' },
    logger: { error() {} },
    ...overrides,
  }
}

test('build publishes a custom artifact and disposes owned generations', async t => {
  const artifact = await artifactRoot(t, true)
  const published = []
  const plugin = weappContainer({
    artifact: { build: async () => artifact },
    onArtifact: value => published.push(value),
  })

  plugin.configResolved(resolvedConfig())
  await plugin.writeBundle({})

  assert.equal(plugin.api.getArtifact(), artifact)
  assert.deepEqual(published, [artifact])
  await plugin.closeBundle()
  await assert.rejects(access(artifact.generationRoot), { code: 'ENOENT' })
})

test('runs through the Vite build lifecycle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'weapp-container-vite-project-'))
  const artifact = await artifactRoot(t, true)
  const published = []
  await writeFile(join(root, 'index.html'), '<!doctype html><script type="module">export default 1</script>\n')
  t.after(() => rm(root, { recursive: true, force: true }))

  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [weappContainer({
      artifact: { build: async () => artifact },
      onArtifact: value => published.push(value),
    })],
    build: { outDir: join(root, 'dist'), emptyOutDir: true },
  })

  assert.deepEqual(published, [artifact])
  await assert.rejects(access(artifact.generationRoot), { code: 'ENOENT' })
})

test('dev watch publishes rebuilt generations and closes the watcher', async t => {
  const initial = await artifactRoot(t, true)
  const rebuilt = await artifactRoot(t, true)
  const published = []
  const errors = []
  let hooks
  let watcherClosed = false
  const plugin = weappContainer({
    artifact: {
      build: async () => initial,
      watch: async value => {
        hooks = value
        return { artifact: initial, generations: [initial], close: async () => { watcherClosed = true } }
      },
    },
    onArtifact: value => published.push(value),
    onError: error => errors.push(error),
  })
  const server = {
    config: resolvedConfig({ command: 'serve' }),
    watcher: { on() {} },
  }

  plugin.configResolved(server.config)
  await plugin.configureServer(server)
  await hooks.onRebuilt(rebuilt)
  await hooks.onError(new Error('compile failed'))

  assert.equal(plugin.api.getArtifact(), rebuilt)
  assert.deepEqual(published, [initial, rebuilt])
  assert.equal(errors[0].message, 'compile failed')
  await plugin.api.close()
  assert.equal(watcherClosed, true)
  await assert.rejects(access(initial.generationRoot), { code: 'ENOENT' })
  await assert.rejects(access(rebuilt.generationRoot), { code: 'ENOENT' })
})

test('disposeArtifacts false leaves custom generations for the factory', async t => {
  const artifact = await artifactRoot(t, true)
  const plugin = weappContainer({
    artifact: { build: async () => artifact },
    disposeArtifacts: false,
  })

  plugin.configResolved(resolvedConfig())
  await plugin.writeBundle({})
  await plugin.closeBundle()
  await access(artifact.generationRoot)
})

test('configureVitest injects artifacts and reruns only the owning project', async t => {
  const initial = await artifactRoot(t, true)
  const rebuilt = await artifactRoot(t, true)
  const provided = []
  const reruns = []
  const closeHandlers = []
  let hooks
  const project = { config: { watch: true }, provide: (key, value) => provided.push({ key, value }) }
  const plugin = weappContainer({
    artifact: {
      build: async () => initial,
      watch: async value => {
        hooks = value
        return { artifact: initial, generations: [initial], close() {} }
      },
    },
    container: { nowMs: 1234 },
  })

  await plugin.configureVitest({
    project,
    vitest: {
      config: { watch: true },
      onClose: handler => closeHandlers.push(handler),
      globTestSpecifications: async () => [{ project }, { project: {} }],
      rerunTestSpecifications: async specifications => reruns.push(specifications),
      state: { catchError() {} },
      logger: { printError() {} },
    },
  })
  await hooks.onRebuilt(rebuilt)

  assert.deepEqual(provided[0], {
    key: 'weappContainerArtifact',
    value: { artifact: initial, options: { nowMs: 1234 } },
  })
  assert.equal(provided.at(-1).value.artifact, rebuilt)
  assert.deepEqual(reruns, [[{ project }]])
  await closeHandlers[0]()
  await assert.rejects(access(initial.generationRoot), { code: 'ENOENT' })
  await assert.rejects(access(rebuilt.generationRoot), { code: 'ENOENT' })
  await t.test('close is idempotent', async () => closeHandlers[0]())
})

test('Vitest compilation errors publish an error context', async () => {
  const artifact = { packPath: '/pack', sourceRoot: '/source' }
  const provided = []
  const errors = []
  const closeHandlers = []
  let hooks
  const project = { config: { watch: true }, provide: (key, value) => provided.push({ key, value }) }
  const plugin = weappContainer({
    artifact: {
      build: async () => artifact,
      watch: async value => {
        hooks = value
        return { artifact, close() {} }
      },
    },
  })

  await plugin.configureVitest({
    project,
    vitest: {
      config: { watch: true },
      onClose: handler => closeHandlers.push(handler),
      globTestSpecifications: async () => [],
      rerunTestSpecifications: async () => {},
      state: { catchError: error => errors.push(error) },
      logger: { printError() {} },
    },
  })
  const error = new Error('compile failed')
  hooks.onError(error)

  assert.deepEqual(provided.at(-1), {
    key: 'weappContainerArtifact',
    value: { error: 'compile failed' },
  })
  assert.deepEqual(errors, [error])
  await closeHandlers[0]()
})
