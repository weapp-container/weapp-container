import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import type { ArtifactFactory, ArtifactWatcher, ContainerArtifact } from '@weapp-container/node/artifact'
import { disposeOwnedArtifact, packArtifact } from '@weapp-container/node/artifact'
import { createWeappViteArtifactFactory } from './compiler.ts'
import { configureVitest } from './vitest.ts'
import type { WeappContainerPluginApi, WeappContainerViteOptions, WeappContainerVitestContext } from './types.ts'

export { ARTIFACT_KEY } from './vitest.ts'
export { createWeappViteArtifactFactory } from './compiler.ts'
export { configureVitest } from './vitest.ts'
export type {
  ArtifactContext,
  WeappContainerPluginApi,
  WeappContainerViteOptions,
  WeappContainerVitestContext,
  WeappViteBuildOptions,
  WeappViteCompiledArtifact,
  WeappViteTestCompiler,
} from './types.ts'

export type WeappContainerPlugin = Plugin & {
  api: WeappContainerPluginApi
  configureVitest(context: WeappContainerVitestContext): Promise<void>
}

function createFactory(options: WeappContainerViteOptions, config?: ResolvedConfig): ArtifactFactory {
  if (options.artifact) return options.artifact
  const weappVite = { ...options.weappVite }
  if (weappVite.cwd === undefined && config) weappVite.cwd = config.root
  if (weappVite.configFile === undefined && config?.configFile) weappVite.configFile = config.configFile
  if (weappVite.mode === undefined && config) weappVite.mode = config.mode
  return createWeappViteArtifactFactory(weappVite, options.compiler)
}

function isVitestConfig(config: ResolvedConfig) {
  return config.plugins.some(plugin => plugin.name === 'vitest:config' || plugin.name === 'vitest:project')
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

export function weappContainer(options: WeappContainerViteOptions = {}): WeappContainerPlugin {
  let config: ResolvedConfig | undefined
  let vitestConfig = false
  let watcher: ArtifactWatcher | undefined
  let current: ContainerArtifact | undefined
  let closed = false
  let closing: Promise<void> | undefined
  const pendingPublishes = new Set<Promise<void>>()
  const generations = new Set<ContainerArtifact>()

  const publish = (artifact: ContainerArtifact) => {
    generations.add(artifact)
    if (closed) return Promise.resolve()
    const task = (async () => {
      if (closed) return
      current = artifact
      await options.onArtifact?.(artifact)
    })()
    pendingPublishes.add(task)
    void task.then(
      () => pendingPublishes.delete(task),
      () => pendingPublishes.delete(task),
    )
    return task
  }

  const reportError = (error: unknown, server?: ViteDevServer) => {
    if (options.onError) {
      options.onError(error)
      return
    }
    const message = errorMessage(error)
    if (server) server.config.logger.error(message)
    else config?.logger.error(message)
  }

  const startViteWatch = async (server: ViteDevServer) => {
    if (vitestConfig || closed) return
    const factory = createFactory(options, config)
    if (!factory.watch) {
      await publish(await factory.build())
      return
    }
    watcher = await factory.watch({
      onRebuilt: publish,
      onError: error => reportError(error, server),
    })
    if (closed) {
      await watcher.close()
      return
    }
    for (const artifact of watcher.generations ?? []) generations.add(artifact)
    await publish(watcher.artifact)
    server.watcher.on('close', () => void close())
  }

  const close = () => closing ??= (async () => {
    closed = true
    const results = await Promise.allSettled([Promise.resolve().then(() => watcher?.close())])
    results.push(...await Promise.allSettled(pendingPublishes))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    for (const artifact of watcher?.generations ?? []) generations.add(artifact)
    if (options.disposeArtifacts !== false) {
      for (const artifact of generations) {
        try {
          await disposeOwnedArtifact(artifact)
        } catch (error) {
          errors.push(error)
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Weapp Container plugin cleanup failed')
  })()

  return {
    name: 'weapp-container:vite',
    api: {
      getArtifact: () => current,
      close,
    },
    configResolved(resolved) {
      config = resolved
      vitestConfig = isVitestConfig(resolved)
    },
    async configureServer(server) {
      await startViteWatch(server)
    },
    async writeBundle(output: { dir?: string | undefined }) {
      if (!config || vitestConfig || config.command !== 'build' || closed) return
      let artifact: ContainerArtifact
      if (options.artifact) {
        artifact = await options.artifact.build()
      } else if (config.plugins.some(plugin => plugin.name === 'weapp-vite:host')) {
        const outputRoot = output.dir ?? config.build.outDir
        artifact = await packArtifact({
          projectPath: config.root,
          miniprogramRootPath: outputRoot,
        })
      } else {
        artifact = await createFactory(options, config).build()
      }
      await publish(artifact)
    },
    async closeBundle() {
      await close()
    },
    configureVitest(context) {
      return configureVitest(createFactory(options, config), options, context)
    },
  }
}
