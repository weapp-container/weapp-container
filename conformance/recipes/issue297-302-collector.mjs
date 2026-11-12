/** Complete passive observation of all three unchanged issue297-302 tests. */
import { descriptor } from './issue297-302-descriptor.mjs'
import { createOrderedStepsCollector } from './ordered-steps-collector-core.mjs'
export const createCollector = options => createOrderedStepsCollector({ ...options, descriptor })
