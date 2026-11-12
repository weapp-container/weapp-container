Page({
  data: { leftA: 0, topA: 0, leftB: 0, topB: 0, unrelated: 0, taps: [] },
  onLoad() { getApp().trace.push('index:load') },
  onShow() { getApp().trace.push('index:show') },
  onReady() { getApp().trace.push('index:ready') },
  onHide() { getApp().trace.push('index:hide') },
  onUnload() { getApp().trace.push('index:unload') },
  onPageScroll(event) {
    getApp().trace.push(['index:scroll', event.scrollTop])
    getApp().inspect()
  },
  onInspect() { getApp().inspect() },
  onObserve() {
    const app = getApp()
    app.heldObserver = wx.createIntersectionObserver(this, { thresholds: [0, 0.5, 1] })
    app.heldObserver.relativeTo('#a').observe('#target-a', result => {
      app.intersections.push(result)
    })
  },
  onSetOffsets() { this.setData({ leftA: 40, topA: 30 }) },
  onUnrelatedPatch() { this.setData({ unrelated: this.data.unrelated + 1 }) },
  onScrollA(event) {
    getApp().trace.push(['a:scroll', event.detail.scrollLeft, event.detail.scrollTop])
  },
  onScrollB(event) {
    getApp().trace.push(['b:scroll', event.detail.scrollLeft, event.detail.scrollTop])
  },
  onNormalMove(event) {
    event.stopPropagation()
    getApp().trace.push('a:stopped-propagation')
  },
  onCatchMove() { getApp().trace.push('c:catchtouchmove') },
  onPageScrollCommand() {
    wx.pageScrollTo({ scrollTop: 120, duration: 0,
      success(result) { getApp().trace.push(['pageScrollTo:success', result.errMsg]) },
      complete(result) { getApp().trace.push(['pageScrollTo:complete', result.errMsg]) },
    })
  },
  onNavigate() { wx.navigateTo({ url: '/pages/other/index' }) },
  onRelaunch() { wx.reLaunch({ url: '/pages/other/index' }) },
  onTargetTap(event) {
    this.setData({ taps: this.data.taps.concat([{ id: event.currentTarget.id,
      owner: event.currentTarget.dataset.owner, target: event.target.id }]) })
    wx.setStorageSync('scroll:taps', this.data.taps)
  },
})
