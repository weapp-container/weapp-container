import { createOrderedStepsCollector } from './ordered-steps-collector-core.mjs'
import { descriptor } from './issue289-descriptor.mjs'
export const createCollector = options => createOrderedStepsCollector({ ...options, descriptor })
