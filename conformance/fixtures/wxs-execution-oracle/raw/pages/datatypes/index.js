Page({
  data: { phase: 'created', caseId: 'constructors' },
  onLoad: function(options) {
    if (options && options.caseId) this.setData({ caseId: options.caseId });
  },
  onReady: function() { this.setData({ phase: 'ready' }); },
  snapshot: function() {
    return { schemaVersion: 1, phase: this.data.phase, caseId: this.data.caseId,
      environment: wx.getSystemInfoSync(), lifecycle: getApp().oracleTrace.slice() };
  },
  sampleDatatype: function() {
    return new Promise(function(resolve) {
      wx.createSelectorQuery().select('#datatype-result').fields({ dataset: true }, function(value) {
        resolve(value || null);
      }).exec();
    });
  },
});
