App({
  trace: [],
  inspect() {
    const page = getCurrentPages().slice(-1)[0]
    const query = wx.createSelectorQuery()
    query.select('#panel').fields({rect: true, size: true, computedStyle: ['background-color']})
    query.select('#imported').fields({rect: true, size: true, computedStyle: ['background-color']})
    query.exec(geometry => wx.setStorageSync('styles:observation', {
      data: page.data, route: page.route, trace: this.trace.slice(), geometry,
    }))
  },
})
