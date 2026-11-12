/** Synthetic compatibility fixtures only. Archived producer bytes are inert;
 * these helpers create CAS references without importing archived JavaScript. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertReviewedFixtureProducer, reviewedCompilerProducer } from '../conformance-producer-revisions.mjs'

const directory = new URL('./reviewed-producers/cjs-v4-r5b-v1/', import.meta.url)
const metadata = JSON.parse(readFileSync(new URL('revision.json', directory)))
export function reviewedR5bFixture(identity, put, load) {
  const scope = metadata.caseScopes.find(item => ['caseId', 'sourceSha256', 'caseSourcePath'].every(key => item[key] === identity[key]))
  assert(scope?.snapshotProfile, 'synthetic fixture requires an exact reviewed snapshot source scope')
  const sources = Object.fromEntries(Object.entries(metadata.sources).map(([key, item]) => [key, put(readFileSync(new URL(item.path, directory)))]))
  const consumer = { ...identity, producer: sources.compilerUseProducer, preload: sources.compilerUsePreload,
    macroObservation: { profile: metadata.profile, producer: sources.macroProducer, manifest: sources.macroManifest,
      observer: sources.macroObserver, validator: sources.macroValidator } }
  const built = { ...identity, producer: sources.fixtureBuildProducer, packer: { preload: sources.fixturePackerPreload },
    producerProfile: scope.snapshotProfile, producerInputs: metadata.snapshotModules.map(({ key, path }) => ({ path, artifact: sources[key] })) }
  return { sources, token: assertReviewedFixtureProducer(built, reviewedCompilerProducer(consumer, load), load) }
}

/** Rebind only synthetic transaction/cleanup references after changing the
 * complete producer/transport identities; all files, helper transitions, owners and times stay intact. */
export function rebindSyntheticSnapshotProducer(final, producer, put, load, transport) {
  return final.map(item => {
    const transaction = put(JSON.stringify({ ...JSON.parse(load(item.transaction)), producer, transport }))
    const cleanup = JSON.parse(load(item.cleanup)), before = JSON.parse(load(cleanup.beforeCleanup))
    const beforeCleanup = put(JSON.stringify({ ...before, transaction }))
    return { transaction, cleanup: put(JSON.stringify({ ...cleanup, transaction, beforeCleanup })) }
  })
}
