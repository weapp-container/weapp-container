import { expectAssignable, expectType } from 'tsd'
import type { Plugin } from 'vite'
import type { ArtifactWatcher, ContainerArtifact } from '@weapp-container/node/artifact'
import {
  ARTIFACT_KEY,
  configureVitest,
  createWeappViteArtifactFactory,
  weappContainer,
} from '@weapp-container/vite'
import type {
  WeappContainerVitestContext,
  WeappViteCompiledArtifact,
  WeappViteTestCompiler,
} from '@weapp-container/vite'

const artifact: ContainerArtifact = { packPath: '/pack', sourceRoot: '/source' }
const compiler: WeappViteTestCompiler = {
  async buildTestArtifact() {
    return { appConfigPath: '/app.json', miniprogramRootPath: '/mini', projectPath: '/project', sourceRootPath: '/src' }
  },
  async watchTestArtifact(options) {
    await options.onRebuilt?.(await this.buildTestArtifact(options))
    return { artifact: await this.buildTestArtifact(options), close() {} }
  },
}

expectType<'weappContainerArtifact'>(ARTIFACT_KEY)
expectAssignable<Plugin>(weappContainer())
expectAssignable<Plugin>(weappContainer({
  compiler,
  weappVite: { cwd: '/project', mode: 'test', skipNpm: true },
  onArtifact(value) {
    expectType<string>(value.packPath)
  },
  onError(error) {
    expectType<unknown>(error)
  },
}))

const factory = createWeappViteArtifactFactory({ cwd: '/project' }, compiler)
expectType<ContainerArtifact | Promise<ContainerArtifact>>(factory.build())
expectType<ArtifactWatcher | Promise<ArtifactWatcher>>(factory.watch!({
  onRebuilt(value) {
    expectType<ContainerArtifact>(value)
  },
  onError(error) {
    expectType<unknown>(error)
  },
}))

const compiled: WeappViteCompiledArtifact = {
  appConfigPath: '/app.json',
  miniprogramRootPath: '/mini',
  projectPath: '/project',
  sourceRootPath: '/src',
}
expectType<string>(compiled.projectPath)

declare const context: WeappContainerVitestContext
expectType<Promise<void>>(configureVitest(factory, {}, context))

expectType<ContainerArtifact>(artifact)
