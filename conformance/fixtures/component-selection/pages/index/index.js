function describe(value) {
  const type = typeof value
  if (value === null) return { type: 'null' }
  if (type === 'undefined') return { type: 'undefined' }
  if (type !== 'object' && type !== 'function') return { type, value }
  if (Array.isArray(value)) return { type: 'array', values: value.map(describe) }
  const page = getCurrentPages()[getCurrentPages().length - 1]
  return {
    type,
    isPage: value === page,
    label: value.data && value.data.label || null,
    kind: value.data && value.data.kind || null,
    exported: value.exported === true,
    exportKind: typeof value.exportKind === 'string' ? value.exportKind : null,
    hasSetData: typeof value.setData === 'function',
    hasOwnerMethod: typeof value.selectOwnerComponent === 'function',
    route: typeof value.route === 'string' ? value.route : null,
  }
}
function attempt(fn) {
  try { return { ok: true, value: describe(fn()) } }
  catch (error) { return { ok: false, error: { name: error && error.name || '', message: error && error.message || String(error) } } }
}
Page({
  data: { phase: 'created', label: 'page' },
  onLoad() { getApp().record({ at: 'page.onLoad' }); this.setData({ phase: 'loaded' }) },
  onReady() { getApp().record({ at: 'page.onReady' }); this.setData({ phase: 'ready' }) },
  snapshot() {
    const selectors = [
      '#direct', '.target', '.target.target2', '.wrapper > .child', '.wrapper .child',
      '#parent .inner', '#parent > .inner', '#parent >>> .inner', '#parent >>> #nested',
      '#slotted', '#parent #slotted', '#parent >>> #slotted', '#plain-view',
      'probe-leaf', 'probe-parent probe-leaf', '[data-role="direct"]',
      '#direct, #slotted', '#not-present', '', '?', '*',
    ].map(selector => ({
      selector,
      one: attempt(() => this.selectComponent(selector)),
      all: attempt(() => this.selectAllComponents(selector)),
    }))
    const direct = this.selectComponent('#direct')
    const parent = this.selectComponent('#parent')
    const slotted = this.selectComponent('#slotted')
    const slottedWrapped = this.selectComponent('#slotted-wrapped')
    const objectExport = this.selectComponent('#export-object')
    return {
      schemaVersion: 1,
      phase: this.data.phase,
      selectors,
      owners: {
        direct: direct ? direct.ownerSnapshot() : { missing: true },
        nested: parent ? parent.inspectNestedOwner() : { missing: true },
        slotted: slotted ? slotted.ownerSnapshot() : { missing: true },
        slottedWrapped: slottedWrapped ? slottedWrapped.ownerSnapshot() : { missing: true },
        exported: objectExport && typeof objectExport.inspectInternalOwner === 'function' ? objectExport.inspectInternalOwner() : { missing: true },
        pageOwnMethod: attempt(() => typeof this.selectOwnerComponent === 'function' ? this.selectOwnerComponent() : '__method_unavailable__'),
      },
      parentSelectors: parent ? parent.selectionSnapshot() : null,
      exports: {
        undefined: attempt(() => this.selectComponent('#export-undefined')),
        null: attempt(() => this.selectComponent('#export-null')),
        false: attempt(() => this.selectComponent('#export-false')),
        zero: attempt(() => this.selectComponent('#export-zero')),
        object: attempt(() => this.selectComponent('#export-object')),
        nestedBehavior: attempt(() => this.selectComponent('#export-nested-behavior')),
        plain: attempt(() => this.selectComponent('#export-plain')),
        all: attempt(() => this.selectAllComponents('.export')),
      },
      lifecycle: getApp().selectionTrace.slice(),
      environment: wx.getSystemInfoSync(),
    }
  },
})
