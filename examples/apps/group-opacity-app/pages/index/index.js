Page({
  data: { groupOpacity: 0.5, ghostOpacity: 0, hiddenTaps: 0, resets: 0 },
  onLoad() { getApp().trace.push('load') },
  onShow() { getApp().trace.push('show') },
  onReady() { getApp().trace.push('ready') },
  onGhost(event) {
    getApp().hits.push({ target: event.target.id, currentTarget: event.currentTarget.id,
      dataset: event.currentTarget.dataset, beforeOpacity: this.data.ghostOpacity })
    this.setData({ groupOpacity: 1, ghostOpacity: 1, hiddenTaps: this.data.hiddenTaps + 1 })
  },
  onGhostBubble(event) {
    getApp().hits.push({ target: event.target.id, currentTarget: event.currentTarget.id,
      dataset: event.currentTarget.dataset })
  },
  onReset() {
    this.setData({ groupOpacity: 0.5, ghostOpacity: 0, resets: this.data.resets + 1 })
  },
  onInspect() {
    const query = wx.createSelectorQuery()
    query.selectAll('.measured').fields({ id: true, rect: true, size: true,
      computedStyle: ['opacity', 'background-color'] })
    query.exec(values => wx.setStorageSync('group-opacity:observation', {
      data: { groupOpacity: this.data.groupOpacity, ghostOpacity: this.data.ghostOpacity,
        hiddenTaps: this.data.hiddenTaps, resets: this.data.resets },
      trace: getApp().trace.slice(), route: this.route, geometry: values[0],
      hits: getApp().hits.slice(),
    }))
  },
})
