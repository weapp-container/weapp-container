App({ globalData: { lifecycleTrace: [] },
  onLaunch() { this.globalData.lifecycleTrace.push('app:launch') },
  onShow() { this.globalData.lifecycleTrace.push('app:show') },
  onHide() { this.globalData.lifecycleTrace.push('app:hide') },
})
