function record(page, event) {
  const trace = getApp().globalData.lifecycleTrace
  trace.push(event)
  page.setData({ lifecycleTrace: trace.slice() })
}

Page({
  data: { count: 0, timerCount: 0, microtaskCount: 0, lifecycleTrace: [], windowInfo: null },
  onLoad() { record(this, 'page:load') },
  onShow() { record(this, 'page:show') },
  onReady() { record(this, 'page:ready') },
  onHide() { record(this, 'page:hide') },
  onResize() {
    this.setData({ windowInfo: wx.getWindowInfo() })
    record(this, 'page:resize')
  },
  onTap() {
    this.setData({ count: this.data.count + 1 })
    this.timer = setTimeout(() => {
      this.setData({ timerCount: this.data.timerCount + 1 })
      Promise.resolve().then(() => this.setData({ microtaskCount: this.data.microtaskCount + 1 }))
    }, 100)
  },
  onUnload() { clearTimeout(this.timer) },
})
