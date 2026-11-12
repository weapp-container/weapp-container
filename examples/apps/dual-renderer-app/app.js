// All pages and both presenters share this AppService and its interval.
var TOKEN_KEY = 'dual-renderer-app:session';
var TAPS_KEY = 'dual-renderer-app:taps';
App({
  launches: 0,
  ticks: 0,
  nextInstance: 1,
  trace: [],
  record: function(kind, route) {
    this.trace.push(kind + (route ? ' · ' + route : ''));
    if (this.trace.length > 24) this.trace.shift();
  },
  onLaunch: function() {
    this.launches += 1;
    this.token = 'session-' + Date.now();
    wx.setStorageSync(TOKEN_KEY, this.token);
    var taps = Number(wx.getStorageSync(TAPS_KEY));
    if (!isFinite(taps) || taps < 0) wx.setStorageSync(TAPS_KEY, 0);
    var app = this;
    this.timer = setInterval(function() { app.ticks += 1; }, 1000);
    this.record('app:launch');
  },
  onShow: function() { this.record('app:show'); },
  onHide: function() { this.record('app:hide'); }
});
