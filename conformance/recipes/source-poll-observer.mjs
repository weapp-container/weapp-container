/** Observe the original Vitest assertion. No callback, matcher or retry loop is replaced. */
export function observeSourceExpectPoll({ expect, flag, collector }) {
  if (typeof expect?.poll !== 'function' || typeof flag !== 'function') throw new Error('Actual Vitest poll/Chai flag reader is absent')
  const original = expect.poll
  function observed(...args) {
    const assertion = Reflect.apply(original, this, args)
    return new Proxy(assertion, { get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (key !== 'toEqual' || typeof value !== 'function') return value
      return function (...matcherArgs) {
        return collector.sourcePoll({ timeoutMs: flag(target, '_poll.timeout'), intervalMs: flag(target, '_poll.interval'), matcher: 'toEqual' },
          () => Reflect.apply(value, target, matcherArgs))
      }
    } })
  }
  expect.poll = observed
  return () => { if (expect.poll === observed) expect.poll = original }
}
