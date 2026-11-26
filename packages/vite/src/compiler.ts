import type { ArtifactFactory, ArtifactWatcher, ContainerArtifact } from '@weapp-container/node/artifact'
import { disposeOwnedArtifact, packArtifact } from '@weapp-container/node/artifact'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WeappViteArtifactWatcher, WeappViteBuildOptions, WeappViteCompiledArtifact, WeappViteTestCompiler } from './types.ts'

const compilerModule = 'weapp-vite/test'

async function loadCompiler(options: WeappViteBuildOptions): Promise<WeappViteTestCompiler> {
  try {
    const cwd = resolve(options.cwd ?? process.cwd())
    const require = createRequire(pathToFileURL(resolve(cwd, 'package.json')))
    const compilerPath = require.resolve(compilerModule)
    return await import(pathToFileURL(compilerPath).href) as WeappViteTestCompiler
  } catch (error) {
    throw new Error('The default artifact compiler requires weapp-vite with the "./test" export installed in the mini-program project. Install a compatible weapp-vite release or pass an artifact factory.', { cause: error })
  }
}

async function pack(compiled: WeappViteCompiledArtifact): Promise<ContainerArtifact> {
  return packArtifact({
    projectPath: compiled.projectPath,
    miniprogramRootPath: compiled.miniprogramRootPath,
    appConfigPath: compiled.appConfigPath,
  })
}

export function createWeappViteArtifactFactory(
  options: WeappViteBuildOptions = {},
  compiler?: WeappViteTestCompiler,
): ArtifactFactory {
  let compilerPromise: Promise<WeappViteTestCompiler> | undefined
  const getCompiler = () => compilerPromise ??= compiler ? Promise.resolve(compiler) : loadCompiler(options)

  return {
    async build() {
      const artifactCompiler = await getCompiler()
      return pack(await artifactCompiler.buildTestArtifact(options))
    },
    async watch(hooks): Promise<ArtifactWatcher> {
      const artifactCompiler = await getCompiler()
      const generations = new Set<ContainerArtifact>()
      let watcher: WeappViteArtifactWatcher | undefined
      try {
        const compiledWatcher = await artifactCompiler.watchTestArtifact({
          ...options,
          onError: hooks.onError,
          onRebuilt: async compiled => {
            const artifact = await pack(compiled)
            generations.add(artifact)
            await hooks.onRebuilt(artifact)
          },
        })
        watcher = compiledWatcher
        const artifact = await pack(compiledWatcher.artifact)
        generations.add(artifact)
        return { artifact, generations, close: () => compiledWatcher.close() }
      } catch (error) {
        const errors = [error]
        try {
          await watcher?.close()
        } catch (closeError) {
          errors.push(closeError)
        }
        for (const artifact of generations) {
          try {
            await disposeOwnedArtifact(artifact)
          } catch (disposeError) {
            errors.push(disposeError)
          }
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, 'Weapp Vite artifact watcher startup failed')
        }
        throw error
      }
    },
  }
}
