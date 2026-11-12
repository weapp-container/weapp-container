function ownerDescription(value) {
  if (value === null) return { type: 'null', isPage: false }
  if (typeof value === 'undefined') return { type: 'undefined', isPage: false }
  const pages = getCurrentPages()
  return {
    type: typeof value,
    isPage: value === pages[pages.length - 1],
    label: value && value.data && value.data.label || null,
    exported: !!(value && value.exported),
    exportKind: value && value.exportKind || null,
    hasSetData: !!value && typeof value.setData === 'function',
    route: value && typeof value.route === 'string' ? value.route : null,
  }
}
Component({
  properties: { label: { type: String, value: 'default' } },
  lifetimes: {
    created() { this.captureOwner('created') },
    attached() { this.captureOwner('attached') },
    ready() { this.captureOwner('ready') },
  },
  methods: {
    ownerSnapshot() {
      try { return { ok: true, value: ownerDescription(this.selectOwnerComponent()) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    captureOwner(phase) { getApp().record({ at: 'leaf.' + phase, label: this.data.label, owner: this.ownerSnapshot() }) },
  },
})
