Component({
  behaviors: [Behavior({ behaviors: ['wx://component-export'] })],
  properties: { kind: String },
  data: { label: 'nested-exporter' },
  export() { return { exported: true, exportKind: 'nested-behavior' } },
})
