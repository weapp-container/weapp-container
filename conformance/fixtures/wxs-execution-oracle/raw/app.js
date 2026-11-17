App({
  oracleTrace: [],
  pageSerial: 0,
  componentSerial: 0,
  record: function(entry) {
    this.oracleTrace.push({ sequence: this.oracleTrace.length, atMs: Date.now(), entry: JSON.parse(JSON.stringify(entry)) })
  },
  onLaunch: function() { this.record({ hook: 'app.onLaunch' }) },
  onShow: function() { this.record({ hook: 'app.onShow' }) },
  onHide: function() { this.record({ hook: 'app.onHide' }) },
  onError: function(message) { this.record({ hook: 'app.onError', message: String(message) }) },
  onUnhandledRejection: function(event) {
    this.record({ hook: 'app.onUnhandledRejection', reason: String(event && event.reason) })
  },
})
