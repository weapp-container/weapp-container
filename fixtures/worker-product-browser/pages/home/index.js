Page({
  data: { count: 0 },
  increment() {
    var state = getApp().globalData
    state.count += 1
    state.taps += 1
    this.setData({ count: state.count })
  },
  onResize() { getApp().globalData.resizes += 1 },
})
