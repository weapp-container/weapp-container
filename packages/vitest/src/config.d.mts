import type { ContainerOptions } from '@weapp-container/node';
import type { ArtifactFactory, ContainerArtifact } from '@weapp-container/node/artifact';
import type { VitestPluginContext } from 'vitest/node';
export const ARTIFACT_KEY: 'weappContainerArtifact';
export interface WeappContainerTestOptions {
  artifact?: ArtifactFactory;
  build?: Record<string, unknown>;
  container?: Omit<ContainerOptions, 'host' | 'signal'>;
  disposeArtifacts?: boolean;
}
export function weappContainerTest(options?: WeappContainerTestOptions): {
  name: string;
  configureVitest(context: VitestPluginContext): Promise<void>;
};
declare module 'vitest' {
  interface ProvidedContext { weappContainerArtifact?: { artifact?: ContainerArtifact; options?: ContainerOptions; error?: string } }
}
