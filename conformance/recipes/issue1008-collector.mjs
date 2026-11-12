import { createOrderedStepsCollector } from './ordered-steps-collector-core.mjs'
import { descriptor } from './issue1008-descriptor.mjs'
import { readinessPolicies } from './issue1008-source-policy.mjs'
export function createCollector(options) { return createOrderedStepsCollector({ ...options, descriptor, readinessPolicies }) }
