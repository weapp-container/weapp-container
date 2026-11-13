import { buildWeappViteArtifact, watchWeappViteArtifact, disposeArtifact } from '@weapp-container/node/artifact';

export const ARTIFACT_KEY = 'weappContainerArtifact';

/** Config entry never loads Vitest's worker-only APIs. */
export function weappContainerTest(options = {}) {
  return {
    name: 'weapp-container:vitest',
    async configureVitest({ project, vitest }) {
      const build = { cwd: project.config?.root, ...options.build };
      const factory = options.artifact ?? {
        build: () => buildWeappViteArtifact(build),
        watch: callbacks => watchWeappViteArtifact({ ...build, ...callbacks }),
      };
      let closed = false, ready = false, early, watcher, closing;
      let pending = Promise.resolve();
      let starting = Promise.resolve();
      const generations = new Set();
      const publish = artifact => {
        generations.add(artifact);
        project.provide(ARTIFACT_KEY, { artifact, options: options.container ?? {} });
      };
      const onError = error => {
        if (closed) return;
        // A failed generation must never silently rerun against the previous one.
        project.provide(ARTIFACT_KEY, { error: error.message ?? String(error) });
        vitest.state.catchError(error, 'Weapp Container Artifact Error');
        vitest.logger.printError(error);
      };
      const onRebuilt = artifact => {
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
        let artifact;
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
