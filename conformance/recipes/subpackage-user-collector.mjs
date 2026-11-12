/** Passive adapter for the unchanged two-test user source. */
import { descriptor } from './subpackage-user-descriptor.mjs'
import { createOrderedPlansCollector } from './ordered-plans-collector-core.mjs'
export function createCollector(options) { return createOrderedPlansCollector({ ...options, descriptor }) }
