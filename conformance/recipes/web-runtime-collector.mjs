/** Passive adapter for the unchanged four-test Web runtime source. */
import { descriptor } from './web-runtime-descriptor.mjs'
import { createOrderedPlansCollector } from './ordered-plans-collector-core.mjs'
export function createCollector(options) { return createOrderedPlansCollector({ ...options, descriptor }) }
