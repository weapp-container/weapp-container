/** Passive observation of the unchanged issue #1012 test.
 * Field projection retains actual values and contains no expected values. */
import { descriptor } from './issue1012-descriptor.mjs'
import { createPassiveCollector } from './passive-collector-core.mjs'

const emptyScope = value => value === undefined || Array.isArray(value) && value.length === 0

function projectNodes(groups, planned, require) {
  return Array.from(groups, (group, index) => {
    require(group && group.selector === planned.queries[index] && group.query === 'css' && group.has === undefined
      && emptyScope(group.scope) && Number.isSafeInteger(group.count) && group.count >= 0
      && Array.isArray(group.nodes) && group.nodes.length === group.count, 'Issue1012 actual node query or scope is incomplete')
    return { selector: group.selector, query: group.query, count: group.count, nodes: Array.from(group.nodes, node => {
      require(node && typeof node.text === 'string', 'Issue1012 actual rendered text is missing')
      return { text: node.text }
    }) }
  })
}

export function createCollector({ emit }) {
  return createPassiveCollector({ emit, descriptor, label: 'Issue1012',
    ownershipName: 'issue1012-observed-transport-owner', pageQueries: ['$'], projectNodes })
}
