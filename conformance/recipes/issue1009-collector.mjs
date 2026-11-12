/** Passive original source operations; actual Vitest owns poll callbacks, retry timing and matcher completion. */
import { createOrderedStepsCollector } from './ordered-steps-collector-core.mjs'
import { observeSourceExpectPoll } from './source-poll-observer.mjs'
import { descriptor } from './issue1009-descriptor.mjs'
import { methodPollPolicies } from './issue1009-source-policy.mjs'
export const requiredSourceCollectorFeatures = Object.freeze(['source-single-element-acquisition', 'source-expect-poll-scope'])
export function createCollector(options) {
  const core = createOrderedStepsCollector({ ...options, descriptor, methodPollPolicies })
  let restore
  return { ...core,
    observeExpectPoll(expect, flag) { if (restore) throw new Error('Issue1009 original poll observer is already installed'); restore = observeSourceExpectPoll({ expect, flag, collector: core }) },
    flush() { try { core.flush() } finally { restore?.(); restore = undefined } },
  }
}
