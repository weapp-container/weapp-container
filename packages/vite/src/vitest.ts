import type { ArtifactFactory, ArtifactWatcher, ContainerArtifact } from '@weapp-container/node/artifact'
import { disposeOwnedArtifact } from '@weapp-container/node/artifact'
import type { WeappContainerViteOptions, WeappContainerVitestContext } from './types.ts'

export const ARTIFACT_KEY = 'weappContainerArtifact'

export function configureVitest(
  factory: ArtifactFactory,
  options: WeappContainerViteOptions,
  { project, vitest }: WeappContainerVitestContext,
) {
  let closed = false
  let ready = false
  let early: ContainerArtifact | undefined
  let watcher: ArtifactWatcher | undefined
  let closing: Promise<void> | undefined
  let pending = Promise.resolve()
  let starting = Promise.resolve()
  const generations = new Set<ContainerArtifact>()

  const publish = (artifact: ContainerArtifact) => {
    generations.add(artifact)
    project.provide(ARTIFACT_KEY, { artifact, options: options.container ?? {} })
  }

  const onError = (error: unknown) => {
    if (closed) return
    project.provide(ARTIFACT_KEY, { error: error instanceof Error ? error.message : String(error) })
    vitest.state.catchError(error, 'Weapp Container Artifact Error')
    vitest.logger.printError(error)
  }

  const onRebuilt = (artifact: ContainerArtifact) => {
    generations.add(artifact)
    if (closed) return Promise.resolve()
    if (!ready) {
      early = artifact
      return Promise.resolve()
    }
    const update = pending.then(async () => {
      if (closed) return
      publish(artifact)
      const specifications = await vitest.globTestSpecifications()
      if (!closed) await vitest.rerunTestSpecifications(specifications.filter(spec => spec.project === project))
    })
    pending = update.catch(onError)
    return pending
  }

  vitest.onClose(() => closing ??= (async () => {
    closed = true
    await starting.catch(() => undefined)
    const results = await Promise.allSettled([Promise.resolve().then(() => watcher?.close()), pending])
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
  })())

  starting = (async () => {
    let artifact: ContainerArtifact
    if (vitest.config.watch && factory.watch) {
      watcher = await factory.watch({ onRebuilt, onError })
      artifact = watcher.artifact
    } else {
      artifact = await factory.build()
    }
    generations.add(artifact)
    if (!closed) {
      publish(early ?? artifact)
      ready = true
    }
  })()

  return starting
}
