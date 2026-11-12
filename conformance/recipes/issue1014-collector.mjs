/** Passive observation of the unchanged issue #1014 test.
 * Field projection retains actual values and contains no expected values. */
import { descriptor } from './issue1014-descriptor.mjs'
import { createPassiveCollector } from './passive-collector-core.mjs'

const emptyScope = value => value === undefined || Array.isArray(value) && value.length === 0

function projectNodes(groups, planned, require) {
  return Array.from(groups, (group, index) => {
    require(group && group.selector === planned.queries[index].selector && group.query === 'css' && group.has === undefined
      && emptyScope(group.scope) && Number.isSafeInteger(group.count) && group.count >= 0
      && Array.isArray(group.nodes) && group.nodes.length === group.count, 'Issue1014 actual node query or scope is incomplete')
    return { selector: group.selector, query: group.query, count: group.count, nodes: Array.from(group.nodes, node => {
      const query = planned.queries[index], actual = {}
      require(node && typeof node === 'object', 'Issue1014 actual rendered node is missing')
      if (query.text) {
        require(typeof node.text === 'string', 'Issue1014 actual rendered text is missing')
        actual.text = node.text
      }
      if (query.attributes.length) {
        require(node.attributes && typeof node.attributes === 'object' && !Array.isArray(node.attributes), 'Issue1014 actual rendered attributes are missing')
        actual.attributes = {}
        for (const name of query.attributes) {
          require(Object.hasOwn(node.attributes, name) && typeof node.attributes[name] === 'string', 'Issue1014 required actual attribute is missing')
          actual.attributes[name] = node.attributes[name]
        }
      }
      return actual
    }) }
  })
}

export function createCollector({ emit }) {
  return createPassiveCollector({ emit, descriptor, label: 'Issue1014',
    ownershipName: 'issue1014-observed-transport-owner', pageQueries: ['$', '$$'], projectNodes })
}
