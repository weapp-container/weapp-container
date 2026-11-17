function recordLifecycle(page, event) {
  const trace = getApp().globalData.lifecycleTrace
  trace.push(event)
  page.setData({ lifecycleTrace: trace.slice() })
}

function readHostInfo() {
  return {
    window: wx.getWindowInfo(),
    device: wx.getDeviceInfo(),
    system: wx.getSystemInfoSync(),
    settings: wx.getSystemSetting(),
  }
}

Page({
  data: {
    count: 0,
    message: 'Loaded by the Weapp Container',
    componentConfig: {
      label: '组件独立状态',
      step: 1,
    },
    lifecycleTrace: [],
    windowInfo: null,
    moduleScopeHostInfo: null,
    resizeHostInfo: null,
    tapHostInfo: null,
    showHostInfo: null,
  },
  onLoad(query) {
    this.setData({
      message: query?.message || this.data.message,
      moduleScopeHostInfo: getApp().globalData.moduleScopeHostInfo,
    })
    recordLifecycle(this, 'page:load')
  },
  onShow() {
    this.setData({ showHostInfo: readHostInfo() })
    recordLifecycle(this, 'page:show')
  },
  onReady() {
    recordLifecycle(this, 'page:ready')
  },
  onHide() {
    recordLifecycle(this, 'page:hide')
  },
  onResize() {
    const hostInfo = readHostInfo()
    this.setData({ windowInfo: hostInfo.window, resizeHostInfo: hostInfo })
    recordLifecycle(this, 'page:resize')
  },
  onTap() {
    this.setData({ count: this.data.count + 1, tapHostInfo: readHostInfo() })
  },
})
