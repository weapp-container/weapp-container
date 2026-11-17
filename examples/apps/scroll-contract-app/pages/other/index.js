Page({
  data: { other: true },
  onLoad() { getApp().trace.push('other:load') },
  onShow() { getApp().trace.push('other:show') },
  onReady() { getApp().trace.push('other:ready') },
  onInspect() { getApp().inspect() },
  onBack() { wx.navigateBack({ delta: 1 }) },
  onUnload() { getApp().trace.push('other:unload') },
})
