const ids = [
  'row-a', 'row-b', 'grow-a', 'grow-b', 'shrink-a', 'shrink-b',
  'wrap', 'wrap-a', 'wrap-b', 'wrap-c', 'align-a', 'align-b',
  'percent', 'percent-child', 'percent-grandchild', 'absolute', 'fixed',
  'text-a', 'text-b', 'max-item', 'min-item',
]

Page({
  data: { wrapWidth: 220, taps: 0, scrolls: 0, fixedTaps: 0, label: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW' },
  onLoad() { getApp().trace.push('load') },
  onShow() { getApp().trace.push('show') },
  onReady() { getApp().trace.push('ready') },
  onToggle() {
    this.setData({ wrapWidth: this.data.wrapWidth === 220 ? 120 : 220, taps: this.data.taps + 1 })
  },
  onScroll() {
    wx.pageScrollTo({ scrollTop: 100, duration: 0,
      success: () => this.setData({ scrolls: this.data.scrolls + 1 }),
    })
  },
  onFixed() { this.setData({ fixedTaps: this.data.fixedTaps + 1 }) },
  onInspect() {
    const query = wx.createSelectorQuery()
    for (const id of ids) query.select('#' + id).fields({ id: true, rect: true, size: true })
    query.exec(geometry => wx.setStorageSync('flex:observation', {
      data: this.data, trace: getApp().trace.slice(), route: this.route,
      geometry: ids.map((id, index) => ({ id, ...geometry[index] })),
    }))
  },
})
