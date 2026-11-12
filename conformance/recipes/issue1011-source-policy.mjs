import { isDeepStrictEqual } from 'node:util'
import { descriptor } from './issue1011-descriptor.mjs'
import { expectedSnapshot } from './issue1011-original-values.mjs'
const step=descriptor.plans[0].steps.find(step=>step.kind==='method.poll')
export const methodPollPolicies=Object.freeze({[step.sourceCallsite]:Object.freeze({timeoutMs:10000,intervalMs:50,satisfied:value=>isDeepStrictEqual(value,expectedSnapshot)})})
