import type { ContainerOptions } from '@weapp-container/node'
import type { ArtifactFactory, ArtifactWatcher, CompilerOptions, ContainerArtifact } from '@weapp-container/node/artifact'
import type { VitestPluginContext } from 'vitest/node'
export interface WeappContainerTestOptions {
  artifact?: ArtifactFactory
  build?: CompilerOptions
  container?: Omit<ContainerOptions, 'host' | 'signal'>
  disposeArtifacts?: boolean
}
export interface ArtifactContext { artifact?: ContainerArtifact; options?: ContainerOptions; error?: string }
declare module 'vitest' { interface ProvidedContext { weappContainerArtifact?: ArtifactContext } }
import { buildWeappViteArtifact, watchWeappViteArtifact, disposeArtifact } from '@weapp-container/node/artifact';

export const ARTIFACT_KEY = 'weappContainerArtifact';

/** Config entry never loads Vitest's worker-only APIs. */
export function weappContainerTest(options: WeappContainerTestOptions = {}) {
  return {
    name: 'weapp-container:vitest',
    async configureVitest({ project, vitest }: VitestPluginContext) {
      const build = { ...(project.config?.root ? { cwd: project.config.root } : {}), ...options.build };
      const factory = options.artifact ?? {
        build: () => buildWeappViteArtifact(build),
        watch: (callbacks: Parameters<NonNullable<ArtifactFactory['watch']>>[0]) => watchWeappViteArtifact({ ...build, ...callbacks }),
      };
      let closed = false, ready = false;
      let early: ContainerArtifact | undefined, watcher: ArtifactWatcher | undefined, closing: Promise<void> | undefined;
      let pending = Promise.resolve();
      let starting = Promise.resolve();
      const generations = new Set<ContainerArtifact>();
      const publish = (artifact: ContainerArtifact) => {
        generations.add(artifact);
        project.provide(ARTIFACT_KEY, { artifact, options: options.container ?? {} });
      };
      const onError = (error: unknown) => {
        if (closed) return;
        // A failed generation must never silently rerun against the previous one.
        project.provide(ARTIFACT_KEY, { error: error instanceof Error ? error.message : String(error) });
        vitest.state.catchError(error, 'Weapp Container Artifact Error');
        vitest.logger.printError(error);
      };
      const onRebuilt = (artifact: ContainerArtifact) => {
        generations.add(artifact);
        if (closed) return Promise.resolve();
        if (!ready) { early = artifact; return Promise.resolve(); }
        const update = pending.then(async () => {
          if (closed) return;
          publish(artifact);
          const specifications = await vitest.globTestSpecifications();
          if (!closed) await vitest.rerunTestSpecifications(specifications.filter(spec => spec.project === project));
        });
        pending = update.catch(onError);
        return pending;
      };
      vitest.onClose(() => closing ??= (async () => {
        closed = true;
        await starting.catch(() => {});
        const results = await Promise.allSettled([Promise.resolve().then(() => watcher?.close()), pending]);
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        for (const artifact of watcher?.generations ?? []) generations.add(artifact);
        for (const artifact of generations) {
          if (options.disposeArtifacts !== false) {
            try { await disposeArtifact(artifact); } catch (error) { errors.push(error); }
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Weapp Container plugin cleanup failed');
      })());
      starting = (async () => {
        let artifact: ContainerArtifact;
        if (vitest.config.watch && factory.watch) {
          watcher = await factory.watch({ onRebuilt, onError });
          artifact = watcher.artifact;
        } else artifact = await factory.build();
        generations.add(artifact);
        if (!closed) { publish(early ?? artifact); ready = true; }
      })();
      await starting;
    },
  };
}
