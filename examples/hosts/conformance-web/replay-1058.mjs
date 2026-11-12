/** Node-side reviewed actions; request is bridged to the actual browser owner. */
import { caseDefinition, assertCheckpoint } from '../../../examples/hosts/conformance-desktop/replay.mjs'

export const CASE_ID = 'ide-issue-1058-template-tags-runtime'
const require = (value, message) => { if (!value) throw new Error(message) }
const routeOf = value => {
  require(typeof value === 'string' && value && !/[\\?#]/.test(value), 'Web Page needs an actual canonical route')
  const route = value.replace(/^\/+|\/+$/g, '')
  require(route && route.split('/').every(part => part && part !== '.' && part !== '..'), 'Web Page route is invalid')
  return route
}
export function createWebProgram(request) {
  const element = async (route, selector) => {
    const address = { route, selector }, actual = await request('query', address)
    require(actual.route === route && actual.selector === selector && Number.isSafeInteger(actual.count) && actual.count >= 0
      && Array.isArray(actual.nodes) && actual.nodes.length === actual.count, 'Web query has incomplete actual node evidence')
    if (actual.count === 0) return undefined
    require(actual.count === 1, 'Web action requires exactly one actual rendered node')
    return {
      async text() {
        const value = await request('query.text', address)
        require(value.route === route && value.selector === selector && value.count === 1 && typeof value.text === 'string', 'Web text observation is incomplete')
        return value.text
      },
      async tap() {
        const value = await request('tap', address)
        require(value.route === route && value.selector === selector && value.inputTransport === 'web-host-coordinate-event', 'Web tap lacks actual host coordinate transport')
        return value
      },
    }
  }
  return { async reLaunch(requested) {
    const actual = await request('reLaunch', { route: requested })
    require(actual.path === routeOf(requested) && actual.path === routeOf(actual.path), 'Web reLaunch returned another actual Page')
    return { path: actual.path, async $(selector) { return element(actual.path, selector) } }
  } }
}

export async function replay1058({ request }) {
  const definition = caseDefinition(CASE_ID), events = [], assertions = []
  const collector = definition.createCollector({ emit: event => events.push({ ...structuredClone(event), seq: events.length }) })
  const program = createWebProgram(request)
  collector.attach(program)
  const check = async (id, page, expected) => {
    // Original expected values stay in Node assertions; only addresses cross
    // into the browser and Rust projection. No oracle trace is an input.
    const selectors = expected.map(({ selector }) => selector)
    const evidence = await request('checkpoint', { route: page.path, checkpoint: id, selectors })
    require(evidence?.id === id && evidence.route === page.path, 'Web checkpoint belongs to another actual route or checkpoint')
    assertCheckpoint(evidence, expected)
    collector.checkpoint({ evidence })
  }
  try {
    await definition.replay({ program, check, assertion: id => assertions.push({ id, passed: true }) })
    collector.flush()
    return { candidateOnly: true, caseId: CASE_ID, host: 'web', engine: 'quickjs', events, assertions }
  } catch (error) {
    try { collector.flush() } catch { /* Keep the actual action/assertion failure. */ }
    throw error
  }
}
