import { descriptor } from '../../../conformance/recipes/import-meta-descriptor.mjs'
import { readinessPolicies } from '../../../conformance/recipes/import-meta-source-policy.mjs'
import { sourceActionTape, replaySourcePlan } from './source-plan-replay.mjs'
import { assertImportMetaOutputs } from './import-meta-static.mjs'
export const importMetaActionTape = trace => sourceActionTape(descriptor, trace, { readinessPolicies })
export const replayImportMeta = options => replaySourcePlan({ ...options, descriptor, readinessPolicies, assertStatic: assertImportMetaOutputs })
