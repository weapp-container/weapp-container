App({
  globalData: { lifecycle: [] },
  onLaunch() {
    this.globalData.lifecycle.push('app:launch')
  },
  onShow() {
    this.globalData.lifecycle.push('app:show')
  },
  onHide() {
    this.globalData.lifecycle.push('app:hide')
  },
})
