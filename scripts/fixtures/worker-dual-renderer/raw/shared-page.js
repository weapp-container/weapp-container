exports.create = function(route) {
  return {
    data: {route: route, count: 0, ready: false, readyCount: 0, resizeCount: 0,
      width: 375, height: 667, color: '#1f4b99', instance: 0},
    onLoad: function() {
      var app = getApp();
      this.setData({instance: app.nextInstance++});
      app.instances.push({route: route, instance: this.data.instance});
      app.record('load', route, this.data.instance);
    },
    onShow: function() { getApp().record('show', route, this.data.instance); },
    onReady: function() {
      this.setData({ready: true, readyCount: this.data.readyCount + 1});
      getApp().record('ready', route, this.data.instance);
    },
    onHide: function() { getApp().record('hide', route, this.data.instance); },
    onUnload: function() { getApp().record('unload', route, this.data.instance); },
    onResize: function(event) {
      this.setData({resizeCount: this.data.resizeCount + 1,
        width: event.size.windowWidth, height: event.size.windowHeight});
      getApp().record('resize', route, event.size);
    },
    increment: function() {
      this.setData({count: this.data.count + 1, color: '#1e8449'});
      var app = getApp();
      wx.setStorageSync('worker-dual-taps', wx.getStorageSync('worker-dual-taps') + 1);
      app.record('tap', route, this.data.instance);
    },
    toSkia: function() { wx.navigateTo({url: '/pages/skia/index'}); },
    back: function() { wx.navigateBack({delta: 1}); },
    toReturn: function() { wx.redirectTo({url: '/pages/return/index'}); }
  };
};
