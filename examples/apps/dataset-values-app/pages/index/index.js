function record(owner, event) {
  const copy = value => JSON.parse(JSON.stringify(value))
  getApp().events.push({ owner, type: event.type,
    target: { id: event.target.id, dataset: copy(event.target.dataset) },
    currentTarget: { id: event.currentTarget.id, dataset: copy(event.currentTarget.dataset) },
    mark: copy(event.mark),
  })
}
Page({
  data: {
    number: 42, yes: true, no: false, nil: null, text: 'bound',
    object: { k: 1, nested: [false, null, { value: 'before' }] },
    array: [7, true, null, 'x', { k: 'before' }],
    phase: 'initial', left: 0, captureMeta: { owner: 'capture', phase: 'before' },
  },
  onLoad() { getApp().trace.push('load') },
  onShow() { getApp().trace.push('show') },
  onReady() { getApp().trace.push('ready') },
  onPageTarget(event) { record('page-target', event) },
  onPageParent(event) { record('page-parent', event) },
  onCaptureParent(event) { record('capture-parent', event) },
  onCapturePhase(event) { record('capture-phase', event) },
  onUnderlay(event) { record('underlay', event) },
  onCaptureStart(event) {
    record('capture-target', event)
    this.setData({ phase: 'changed', left: 160,
      object: { k: 2, nested: [true, null, { value: 'after' }] },
      array: [8, false, null, 'y', { k: 'after' }],
      captureMeta: { owner: 'capture', phase: 'after' },
    })
  },
  onCaptureTarget(event) { record('capture-target', event) },
  onInspect() {
    const query = wx.createSelectorQuery()
    query.selectAll('.page-probe').fields({ id: true, dataset: true, mark: true, rect: true, size: true })
    query.exec(values => wx.setStorageSync('dataset-values:page', {
      route: this.route, data: this.data, trace: getApp().trace.slice(),
      events: getApp().events.slice(), nodes: values[0],
    }))
  },
})
