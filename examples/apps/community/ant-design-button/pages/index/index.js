Page({
  data: {
    lastAction: '尚未点击按钮'
  },

  handleTap(event) {
    const label = event.currentTarget.dataset.label || 'Button'
    this.setData({ lastAction: `已点击${label}` })
    wx.showToast({ title: label, icon: 'none' })
  }
})
