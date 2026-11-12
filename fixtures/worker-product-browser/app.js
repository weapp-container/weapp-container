// Dedicated real AppService fixture; the browser runner never appends probes.
App({
  globalData: { fixture: 'worker-product-counter-v1', count: 0, taps: 0, launches: 0, shows: 0, hides: 0, resizes: 0 },
  onLaunch() { this.globalData.launches += 1 },
  onShow() { this.globalData.shows += 1 },
  onHide() { this.globalData.hides += 1 },
})
exports.productSmokeState = function () {
  var state = getApp().globalData
  return { fixture: state.fixture, count: state.count, taps: state.taps, launches: state.launches,
    shows: state.shows, hides: state.hides, resizes: state.resizes }
}
