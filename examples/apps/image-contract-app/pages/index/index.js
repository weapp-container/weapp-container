const ids = ['scale', 'fit', 'fill', 'width', 'height', 'top', 'bottom', 'center',
  'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right',
  'dynamic', 'width-ratio', 'height-ratio', 'percent-ratio', 'default', 'empty']

Page({
  data: { src: '/assets/grid.png', taps: 0 },
  onLoad() { getApp().trace.push('load') },
  onShow() { getApp().trace.push('show') },
  onReady() { getApp().trace.push('ready') },
  onSwap() { this.setData({ src: '/assets/alpha.png', taps: this.data.taps + 1 }) },
  onUnsupported() { this.setData({ src: 'https://example.invalid/image.png' }) },
  onRecover() { this.setData({ src: '/assets/grid.png' }) },
  onImage(event) { wx.setStorageSync('image:tap', { id: event.target.id, dataset: event.currentTarget.dataset }) },
  onInspect() {
    const query = wx.createSelectorQuery()
    for (const id of ids) query.select('#' + id).fields({ id: true, rect: true, size: true })
    query.exec(geometry => wx.setStorageSync('image:observation', {
      data: this.data, trace: getApp().trace.slice(), route: this.route,
      geometry: ids.map((id, index) => ({ id, ...geometry[index] })),
    }))
  },
})
