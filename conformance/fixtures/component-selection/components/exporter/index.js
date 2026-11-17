Component({
  behaviors: ['wx://component-export'],
  properties: { kind: String },
  data: { label: 'exporter' },
  export() {
    if (this.data.kind === 'undefined') return undefined
    if (this.data.kind === 'null') return null
    if (this.data.kind === 'false') return false
    if (this.data.kind === 'zero') return 0
    return { exported: true, exportKind: this.data.kind, inspectInternalOwner: () => {
      const child = this.selectComponent('#export-owner-leaf')
      return child ? child.ownerSnapshot() : { missing: true }
    } }
  },
})
