Page({
  data: { order: 2, toggles: 0 },
  onLoad() { getApp().trace.push('load') },
  onShow() { getApp().trace.push('show') },
  onReady() { getApp().trace.push('ready') },
  onToggle() {
    this.setData({ order: this.data.order === 2 ? -1 : 2, toggles: this.data.toggles + 1 })
  },
  onHit(event) {
    getApp().hits.push({
      target: event.target.id, currentTarget: event.currentTarget.id,
      dataset: event.currentTarget.dataset,
    })
  },
  onInspect() {
    const query = wx.createSelectorQuery()
    query.selectAll('.measured').fields({ id: true, rect: true, size: true })
    for (const group of ['row', 'column', 'wrap', 'stack']) {
      query.selectAll('.' + group + '-item').fields({ id: true })
    }
    query.exec(values => wx.setStorageSync('flex-order:observation', {
      data: { order: this.data.order, toggles: this.data.toggles },
      trace: getApp().trace.slice(), route: this.route, geometry: values[0],
      domOrder: {
        row: values[1].map(node => node.id), column: values[2].map(node => node.id),
        wrap: values[3].map(node => node.id), stack: values[4].map(node => node.id),
      },
      hits: getApp().hits.slice(),
    }))
  },
})
