function record(owner, event) {
  const copy = value => JSON.parse(JSON.stringify(value))
  getApp().events.push({ owner, type: event.type,
    target: { id: event.target.id, dataset: copy(event.target.dataset) },
    currentTarget: { id: event.currentTarget.id, dataset: copy(event.currentTarget.dataset) },
    mark: copy(event.mark),
  })
}
Component({
  data: {
    number: 42, yes: true, no: false, nil: null, text: 'bound',
    object: { k: 1, nested: [false, null, { value: 'before' }] },
    array: [7, true, null, 'x', { k: 'before' }],
  },
  methods: {
    onTarget(event) { record('component-target', event) },
    onParent(event) { record('component-parent', event) },
    onInspect() {
      const query = this.createSelectorQuery()
      query.selectAll('.component-probe').fields({ id: true, dataset: true, mark: true, rect: true, size: true })
      query.exec(values => wx.setStorageSync('dataset-values:component', {
        data: this.data, nodes: values[0],
        events: getApp().events.filter(event => event.owner.indexOf('component-') === 0),
      }))
    },
  },
})
