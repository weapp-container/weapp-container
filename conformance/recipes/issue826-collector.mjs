import {descriptor} from './issue826-descriptor.mjs'
import {createRuntimeLogCollector} from './source-runtime-log-capture.mjs'
export const createCollector=options=>createRuntimeLogCollector({...options,descriptor})
