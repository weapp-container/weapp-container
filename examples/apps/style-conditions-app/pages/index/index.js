Page({
  data: { count: 0 },
  onLoad() { getApp().trace.push('load') },
  onShow() { getApp().trace.push('show') },
  onReady() { getApp().trace.push('ready') },
  onPanelTap() { this.setData({ count: this.data.count + 1 }) },
  onInspect() { getApp().inspect() },
})
