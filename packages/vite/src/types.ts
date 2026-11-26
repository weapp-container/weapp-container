import type { ContainerOptions } from '@weapp-container/node'
import type { ArtifactFactory, ContainerArtifact } from '@weapp-container/node/artifact'

export interface WeappViteBuildOptions {
  cwd?: string
  configFile?: string
  mode?: string
  outDir?: string
  projectConfigPath?: string
  skipNpm?: boolean
}

export interface WeappViteCompiledArtifact {
  appConfigPath: string
  miniprogramRootPath: string
  projectPath: string
  sourceRootPath: string
}

export interface WeappViteArtifactWatcher {
  artifact: WeappViteCompiledArtifact
  close(): void | Promise<void>
}

export interface WeappViteTestCompiler {
  buildTestArtifact(options: WeappViteBuildOptions): Promise<WeappViteCompiledArtifact>
  watchTestArtifact(options: WeappViteBuildOptions & {
    onError?: (error: unknown) => void
    onRebuilt?: (artifact: WeappViteCompiledArtifact) => void | Promise<void>
  }): Promise<WeappViteArtifactWatcher>
}

export interface WeappContainerViteOptions {
  artifact?: ArtifactFactory
  compiler?: WeappViteTestCompiler
  container?: Omit<ContainerOptions, 'host' | 'signal'>
  disposeArtifacts?: boolean
  onArtifact?: (artifact: ContainerArtifact) => void | Promise<void>
  onError?: (error: unknown) => void
  weappVite?: WeappViteBuildOptions
}

export interface WeappContainerPluginApi {
  getArtifact(): ContainerArtifact | undefined
  close(): Promise<void>
}

export interface VitestSpecification {
  project: VitestProject
}

export interface VitestProject {
  config: { watch: boolean }
  provide(key: string, value: unknown): void
}

export interface WeappContainerVitestContext {
  project: VitestProject
  vitest: {
    config: { watch: boolean }
    onClose(callback: () => void | Promise<void>): void
    globTestSpecifications(): Promise<VitestSpecification[]>
    rerunTestSpecifications(specifications: VitestSpecification[]): Promise<unknown>
    state: { catchError(error: unknown, title: string): void }
    logger: { printError(error: unknown): void }
  }
}

export interface ArtifactContext {
  artifact?: ContainerArtifact
  options?: ContainerOptions
  error?: string
}
