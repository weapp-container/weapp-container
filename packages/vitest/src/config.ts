import type { ContainerOptions } from '@weapp-container/node'
import type { ArtifactFactory, ContainerArtifact } from '@weapp-container/node/artifact'
import type { VitestPluginContext } from 'vitest/node'
import { configureVitest as configureSharedVitest } from '@weapp-container/vite'
export interface WeappContainerTestOptions {
  artifact?: ArtifactFactory
  container?: Omit<ContainerOptions, 'host' | 'signal'>
  disposeArtifacts?: boolean
}
export interface ArtifactContext { artifact?: ContainerArtifact; options?: ContainerOptions; error?: string }
declare module 'vitest' { interface ProvidedContext { weappContainerArtifact?: ArtifactContext } }

export const ARTIFACT_KEY = 'weappContainerArtifact';

/** Config entry never loads Vitest's worker-only APIs. */
export function weappContainerTest(options: WeappContainerTestOptions = {}) {
  return {
    name: 'weapp-container:vitest',
    configureVitest(context: VitestPluginContext) {
      const factory = options.artifact;
      if (!factory) throw new Error('weappContainerTest requires an explicit artifact factory; compilers are outside this package');
      return configureSharedVitest(factory, options, context);
    },
  };
}
