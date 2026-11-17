Page({
 data: { count: 0, stored: 0, geometry: '', error: '' },
 onLoad() { this.refreshMetrics(); this.setData({ stored: wx.getStorageSync('chrome-count') || 0 }); },
 onResize() { this.refreshMetrics(); },
 refreshMetrics() { try { this.setData({ geometry: JSON.stringify({ window: wx.getWindowInfo(), capsule: wx.getMenuButtonBoundingClientRect() }), error: '' }); } catch (e) { this.setData({ error: String(e.message || e) }); } },
 increment() { this.setData({ count: this.data.count + 1 }); },
 save() { wx.setStorageSync('chrome-count', this.data.count); this.setData({ stored: this.data.count }); },
 detail() { wx.navigateTo({ url: '/pages/detail/index' }); },
 custom() { wx.navigateTo({ url: '/pages/custom/index' }); },
 title() { wx.setNavigationBarTitle({ title: '动态标题 ' + this.data.count }); },
 dark() { wx.setNavigationBarColor({ frontColor: '#ffffff', backgroundColor: '#16382f' }); }
});
