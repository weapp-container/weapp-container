Component({
  data: { label: 'plain-exporter' },
  export() { return { exported: true, exportKind: 'without-behavior' } },
})
