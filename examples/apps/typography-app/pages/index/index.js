Page({
  data: { size: 20, taps: 0, multiline: 'AB\nCD' },
  onLoad() { getApp().trace.push('load') },
  onShow() { getApp().trace.push('show') },
  onReady() { getApp().trace.push('ready') },
  onResizeText() { this.setData({ size: this.data.size === 20 ? 30 : 20, taps: this.data.taps + 1 }) },
  onInspect() {
    const query = wx.createSelectorQuery()
    for (const id of ['number-parent', 'number-child', 'percent-parent', 'percent-child', 'multiline', 'zero-line', 'zero-font']) {
      query.select('#' + id).fields({ id: true, rect: true, size: true, computedStyle: ['font-size', 'line-height'] })
    }
    query.exec(geometry => wx.setStorageSync('typography:observation', {
      data: this.data, route: this.route, trace: getApp().trace.slice(), geometry,
    }))
  },
})
