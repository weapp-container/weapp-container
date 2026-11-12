// The host must install real window metadata before evaluating app modules.
const moduleScopeHostInfo = {
  window: wx.getWindowInfo(),
  device: wx.getDeviceInfo(),
  system: wx.getSystemInfoSync(),
  settings: wx.getSystemSetting(),
}

App({
  globalData: { bootCount: 0, lifecycleTrace: [], moduleScopeHostInfo },
  onLaunch(options) {
    this.globalData.bootCount += 1
    this.globalData.lifecycleTrace.push('app:launch')
    console.log('reference-app:onLaunch', options)
  },
  onShow() {
    this.globalData.lifecycleTrace.push('app:show')
    console.log('reference-app:onShow')
  },
  onHide() {
    this.globalData.lifecycleTrace.push('app:hide')
    console.log('reference-app:onHide')
  },
})
