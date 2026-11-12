/** 原源码 expect.poll 的条件单独保存；只允许判断实际返回值，不允许生成返回值。 */
import { isDeepStrictEqual } from 'node:util'
import { descriptor } from './issue1009-descriptor.mjs'
import { expectedResults } from './issue1009-source-assertions.mjs'
const step = descriptor.plans[0].steps.find(value => value.kind === 'method.poll')
export const methodPollPolicies = Object.freeze({
  [step.sourceCallsite]: Object.freeze({
    sourceScopeCallsite: step.pollScopeCallsite,
    assertCallsite: step.pollAssertCallsite,
    timeoutMs: 10000,
    intervalMs: 50,
    satisfied: value => isDeepStrictEqual(value, expectedResults),
  }),
})
