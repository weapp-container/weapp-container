App({
  trace: [],
  intersections: [],
  heldObserver: null,
  inspect() {
    const pages = getCurrentPages()
    const page = pages[pages.length - 1]
    const query = wx.createSelectorQuery()
    query.select('#a').scrollOffset()
    query.select('#b').scrollOffset()
    query.select('#target-a').boundingClientRect()
    query.select('#target-b').boundingClientRect()
    query.selectViewport().scrollOffset()
    query.exec(geometry => {
      wx.setStorageSync('scroll:query', {
        route: page.route,
        data: page.data,
        trace: this.trace.slice(),
        geometry,
        intersections: this.intersections.slice(),
      })
    })
    wx.createSelectorQuery().select('#c').scrollOffset().exec(values => {
      wx.setStorageSync('scroll:catch', values[0])
    })
  },
})
