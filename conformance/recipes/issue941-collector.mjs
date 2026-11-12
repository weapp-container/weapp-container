import { createOrderedStepsCollector } from './ordered-steps-collector-core.mjs'
import { descriptor } from './issue941-descriptor.mjs'
export const createCollector=options=>createOrderedStepsCollector({...options,descriptor})
