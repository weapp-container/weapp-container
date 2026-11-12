import { createOrderedStepsCollector } from './ordered-steps-collector-core.mjs'
import { descriptor } from './issue547-descriptor.mjs'
export const createCollector = options => createOrderedStepsCollector({ ...options, descriptor })
