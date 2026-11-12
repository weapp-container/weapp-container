/** Pure field/address projection of actual checkpoint evidence. Counts and
 * values are observations; the descriptor carries no expected count/value. */
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const address = value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
const keys = value => Object.keys(value).sort().join(',')
const defaultRequire = (ok, message) => { if (!ok) throw new Error(message) }

export function orderedQueryFields(query, require = defaultRequire) {
  require(object(query) && Object.keys(query).every(key => ['selector', 'query', 'scope', 'has', 'text', 'attributes'].includes(key))
    && address(query.selector) && (query.query === undefined || ['css', 'xpath'].includes(query.query))
    && (query.text === undefined || typeof query.text === 'boolean') && (query.has === undefined || address(query.has)),
  'ordered DOM query descriptor contains an unsupported address/field or expected value')
  require(query.scope === undefined || Array.isArray(query.scope), 'ordered DOM scope is not an ordered address array')
  const scope = Array.from(query.scope ?? [], part => {
    require(address(part) || object(part) && keys(part) === 'has' && address(part.has), 'ordered DOM component scope address is malformed')
    return typeof part === 'string' ? part : { has: part.has }
  })
  require(query.attributes === undefined || Array.isArray(query.attributes), 'ordered DOM attributes must be field names')
  const attributes = Array.from(query.attributes ?? [], name => {
    require(address(name) && name.trim() === name, 'ordered DOM attribute name is malformed')
    return name
  })
  require(new Set(attributes).size === attributes.length, 'ordered DOM attribute names are duplicated')
  const mode = query.query ?? 'css'
  require(mode !== 'xpath' || scope.length === 0 && query.has === undefined, 'ordered DOM XPath must express its scope/descendants in the address')
  return { selector: query.selector, query: mode, scope, ...(query.has === undefined ? {} : { has: query.has }), text: query.text === true, attributes }
}

export function projectOrderedDomNodes(groups, queries, require = defaultRequire) {
  require(Array.isArray(groups) && Array.isArray(queries) && groups.length === queries.length,
    'ordered DOM selector observations are incomplete')
  return Array.from(groups, (group, index) => {
    const query = orderedQueryFields(queries[index], require), scope = group?.scope ?? []
    require(group && group.selector === query.selector && group.query === query.query && group.has === query.has
      && Array.isArray(scope) && scope.length === query.scope.length && Array.from(scope).every((part, at) =>
        typeof query.scope[at] === 'string' ? part === query.scope[at] : object(part) && keys(part) === 'has' && part.has === query.scope[at].has)
      && Number.isSafeInteger(group.count) && group.count >= 0 && Array.isArray(group.nodes) && group.nodes.length === group.count,
    'ordered DOM actual query, scope or count differs from the source addresses')
    return { selector: group.selector, query: group.query,
      ...(query.scope.length ? { scope: query.scope.map(part => typeof part === 'string' ? part : { has: part.has }) } : {}),
      ...(query.has === undefined ? {} : { has: group.has }), count: group.count,
      nodes: Array.from(group.nodes, node => {
        require(object(node), 'ordered DOM actual rendered node is malformed')
        const actual = {}
        if (query.text) {
          require(typeof node.text === 'string', 'ordered DOM actual rendered text is missing')
          actual.text = node.text
        }
        if (query.attributes.length) {
          require(object(node.attributes), 'ordered DOM actual rendered attributes are missing')
          actual.attributes = Object.fromEntries(query.attributes.map(name => {
            require(Object.hasOwn(node.attributes, name) && typeof node.attributes[name] === 'string', 'ordered DOM selected actual attribute is missing')
            return [name, node.attributes[name]]
          }))
        }
        return actual
      }) }
  })
}

/** The current native wire supports CSS and concrete string scopes. Other
 * observed source addresses stay unavailable until that capability is reviewed.
 * Count-only uses the legacy snapshot form, then projects unused fields away;
 * an empty fields object is not supported by the existing native wire. */
export function orderedNativeQuery(query) {
  const value = orderedQueryFields(query)
  defaultRequire(value.query === 'css' && value.has === undefined && value.scope.every(part => typeof part === 'string'),
    'ordered DOM native wire does not support this query/scope/has address')
  if (!value.scope.length && value.text && !value.attributes.length) return value.selector
  return { selector: value.selector, ...(value.scope.length ? { scope: value.scope } : {}),
    ...(value.attributes.length ? { fields: { text: value.text, attributes: value.attributes } } : {}) }
}
