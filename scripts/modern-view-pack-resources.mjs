/** Required modern execution resources shared by the host pack copiers. */
export function modernViewBlobHashes(manifest) {
  const modern = manifest.modernView
  if (![1, 2, 3].includes(manifest.schemaVersion)
      || (manifest.schemaVersion === 1 && modern !== undefined)
      || (manifest.schemaVersion === 2 && modern === undefined)) {
    throw new Error('modernView requires schema v2 or v3; schema v2 requires modernView')
  }
  const rendering = manifest.rendering
  if ((manifest.schemaVersion === 3) !== (rendering !== undefined)) {
    throw new Error('rendering requires schema v3; schema v3 requires rendering')
  }
  if (rendering !== undefined) {
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const profiles = new Set(['skia', 'webview', 'skyline-compat'])
    if (!record(rendering) || rendering.version !== '1.0' || !profiles.has(rendering.default)
        || !record(rendering.pages) || Object.keys(rendering).some(key => !['version', 'default', 'pages'].includes(key))) {
      throw new Error('unsupported rendering profile version or declaration')
    }
    const routes = new Set((manifest.routes ?? []).map(route => route.path))
    for (const [page, profile] of Object.entries(rendering.pages)) {
      if (!page || /[\\#?:\x00-\x1f\x7f-\x9f]/.test(page) || page.startsWith('/')
          || page.split('/').some(part => !part || part === '.' || part === '..')
          || /\.(?:wxml|json)$/.test(page) || !routes.has(page) || !profiles.has(profile)) {
        throw new Error('invalid rendering page profile')
      }
    }
  }
  if (modern === undefined) return []
  if (!modern || modern.compiler !== 'weapp-container-modern-view' || modern.version !== '1.0.0'
      || modern.abi !== '1.0' || modern.target !== 'es2022' || !Array.isArray(modern.units) || !modern.units.length) {
    throw new Error('unsupported modernView compiler, ABI or target')
  }
  const hashes = new Set(), ids = new Set(), documents = new Set()
  const add = hash => {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid modernView blob hash')
    hashes.add(hash)
  }
  for (const unit of modern.units) {
    if (!unit || !/^modern:[a-f0-9]{64}$/.test(unit.id) || ids.has(unit.id)
        || !Array.isArray(unit.sources) || !unit.sources.length || !Array.isArray(unit.documents) || !unit.documents.length) throw new Error('invalid modernView unit')
    ids.add(unit.id)
    add(unit.executableSha256); add(unit.sourceMapSha256)
    for (const source of unit.sources) {
      if (typeof source?.path !== 'string' || !source.path.length) throw new Error('invalid modernView source')
      add(source.sha256)
    }
    for (const document of unit.documents) {
      if (typeof document?.documentId !== 'string' || !document.documentId.endsWith('.wxml')
          || documents.has(document.documentId) || !Array.isArray(document.aliases)) throw new Error('invalid modernView document')
      documents.add(document.documentId)
    }
  }
  return [...hashes].sort()
}
