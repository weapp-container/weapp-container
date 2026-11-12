/** Select page and recursively declared component WXSS from the portable graph.
 * Component style isolation remains a runtime concern; unrelated route styles
 * must not enter a host frame merely because they share the same pack.
 */
export function routeStyleIds(manifest, route) {
  const records = new Map((manifest.components || []).map(record => [record.owner, record]))
  const owners = new Set()
  const visit = owner => {
    if (owners.has(owner)) return
    owners.add(owner)
    for (const target of Object.values(records.get(owner)?.usingComponents || {})) {
      if (typeof target !== 'string' || !target || target.startsWith('/') || target.split('/').includes('..')) {
        throw new Error('ERR_INVALID_MANIFEST: component style graph requires normalized relative paths')
      }
      visit(`${target}.json`)
    }
  }
  visit(manifest.app.appJson)
  visit(route.config || `${route.path}.json`)
  const reachable = new Set(Array.from(owners, owner => `style:${owner.replace(/\.json$/, '.wxss')}`))
  return manifest.styles.filter(style => style.scope === 'app' || reachable.has(style.id)).map(style => style.id)
}
