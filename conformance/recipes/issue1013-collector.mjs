/** Complete passive adapter for the unchanged issue1013 source. */
import { descriptor } from './issue1013-descriptor.mjs'
import { createOrderedStepsCollector } from './ordered-steps-collector-core.mjs'
export function createCollector(options) { return createOrderedStepsCollector({ ...options, descriptor }) }
