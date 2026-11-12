// Hand-authored public fixture. This is not official WeChat implementation code.
App({
  fixture: 'worker-dual-renderer-v1', launches: 0, ticks: 0, nextInstance: 1,
  trace: [], instances: [],
  record: function(kind, page, extra) {
    if (this.trace.length >= 96) throw new Error('fixture trace exceeded bounded scenario');
    this.trace.push({kind: kind, page: page || null, extra: extra || null});
  },
  onLaunch: function() {
    this.launches += 1;
    this.token = 'same-realm-' + Date.now() + '-' + Math.random();
    wx.setStorageSync('worker-dual-token', this.token);
    wx.setStorageSync('worker-dual-taps', 0);
    this.record('launch');
    var app = this;
    this.timer = setInterval(function() { app.ticks += 1; }, 40);
  },
  onShow: function() { this.record('app-show'); },
  onHide: function() { this.record('app-hide'); }
});
exports.dualRendererSmokeState = function() {
  var app = getApp();
  return {fixture: app.fixture, launches: app.launches, token: app.token,
    storedToken: wx.getStorageSync('worker-dual-token'),
    storedTaps: wx.getStorageSync('worker-dual-taps'), ticks: app.ticks, timer: app.timer,
    instances: app.instances, trace: app.trace,
    pages: getCurrentPages().map(function(page) { return page.data; })};
};
