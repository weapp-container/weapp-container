var TAPS_KEY = 'dual-renderer-app:taps';
exports.create = function(route, profile) {
  return {
    data: {route: route, profile: profile, count: 0, instance: 0,
      ready: false, readyCount: 0, showCount: 0, sharedTaps: 0,
      ticks: 0, timerId: 0, launches: 0, token: '', lastEvent: '', color: '#243f75'},
    onLoad: function() {
      var app = getApp();
      this.setData({instance: app.nextInstance++});
      app.record('page:load', route);
    },
    onShow: function() {
      getApp().record('page:show', route);
      this.setData({showCount: this.data.showCount + 1});
      this.refresh();
    },
    onReady: function() {
      getApp().record('page:ready', route);
      this.setData({ready: true, readyCount: this.data.readyCount + 1});
      this.refresh();
    },
    onHide: function() { getApp().record('page:hide', route); },
    onUnload: function() { getApp().record('page:unload', route); },
    refresh: function() {
      var app = getApp();
      this.setData({sharedTaps: Number(wx.getStorageSync(TAPS_KEY)) || 0,
        ticks: app.ticks, timerId: app.timer, launches: app.launches,
        token: app.token, lastEvent: app.trace[app.trace.length - 1] || ''});
    },
    increment: function() {
      this.setData({count: this.data.count + 1, color: '#1e8449'});
      wx.setStorageSync(TAPS_KEY, (Number(wx.getStorageSync(TAPS_KEY)) || 0) + 1);
      getApp().record('page:tap', route);
      this.refresh();
    },
    toSkia: function() { wx.navigateTo({url: '/pages/skia/index'}); },
    back: function() { wx.navigateBack({delta: 1}); },
    toReturn: function() { wx.redirectTo({url: '/pages/return/index'}); }
  };
};
