/** Passive adapter for the unchanged two-test item source. */
import { descriptor } from './subpackage-item-descriptor.mjs'
import { createOrderedPlansCollector } from './ordered-plans-collector-core.mjs'
export function createCollector(options) { return createOrderedPlansCollector({ ...options, descriptor }) }
