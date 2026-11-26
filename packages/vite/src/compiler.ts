import type { ArtifactFactory, ArtifactWatcher, ContainerArtifact } from '@weapp-container/node/artifact'
import { packArtifact } from '@weapp-container/node/artifact'
import type { WeappViteBuildOptions, WeappViteCompiledArtifact, WeappViteTestCompiler } from './types.ts'

const compilerModule = 'weapp-vite/test'

async function loadCompiler(): Promise<WeappViteTestCompiler> {
  try {
    return await import(compilerModule) as WeappViteTestCompiler
  } catch (error) {
    throw new Error('The default artifact compiler requires weapp-vite with the "./test" export. Install a compatible weapp-vite release or pass an artifact factory.', { cause: error })
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
  const getCompiler = () => compilerPromise ??= compiler ? Promise.resolve(compiler) : loadCompiler()

  return {
    async build() {
      const artifactCompiler = await getCompiler()
      return pack(await artifactCompiler.buildTestArtifact(options))
    },
    async watch(hooks): Promise<ArtifactWatcher> {
      const artifactCompiler = await getCompiler()
      const generations = new Set<ContainerArtifact>()
      const watcher = await artifactCompiler.watchTestArtifact({
        ...options,
        onError: hooks.onError,
        onRebuilt: async compiled => {
          const artifact = await pack(compiled)
          generations.add(artifact)
          await hooks.onRebuilt(artifact)
        },
      })

      try {
        const artifact = await pack(watcher.artifact)
        generations.add(artifact)
        return { artifact, generations, close: () => watcher.close() }
      } catch (error) {
        try { await watcher.close() } catch {}
        throw error
      }
    },
  }
}
