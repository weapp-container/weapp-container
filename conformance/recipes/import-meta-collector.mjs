import { createOrderedStepsCollector } from './ordered-steps-collector-core.mjs'
import { descriptor } from './import-meta-descriptor.mjs'
import { readinessPolicies } from './import-meta-source-policy.mjs'
export function createCollector(options) { return createOrderedStepsCollector({ ...options, descriptor, readinessPolicies }) }
