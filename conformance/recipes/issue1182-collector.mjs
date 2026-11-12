/** Observe every unchanged1182 source step and its real exception interval. */
import { descriptor } from './issue1182-descriptor.mjs'
import { createSourceExceptionCollector } from './source-exception-capture.mjs'
export const createCollector = options => createSourceExceptionCollector({ ...options, descriptor })
