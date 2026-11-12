var initialRows = [
  { id: 'a', label: 'A', visible: true },
  { id: 'b', label: 'B', visible: true },
  { id: 'c', label: 'C', visible: true },
]
var patches = {
  'same-a-1': { marker: 'A' },
  'same-a-2': { marker: 'A' },
  'to-b': { marker: 'B' },
  'back-to-a': { marker: 'A' },
  'hide-branch': { showBranch: false },
  'show-branch': { showBranch: true },
  'reorder-rows': { rows: [initialRows[2], initialRows[0], initialRows[1]] },
  'hide-middle-row': { rows: [initialRows[0], { id: 'b', label: 'B', visible: false }, initialRows[2]] },
  'restore-rows': { rows: initialRows },
  'style-data': { background: '#ddeeff' },
  'same-style-data': { background: '#ddeeff' },
  'hide-slots': { showSlots: false },
  'show-slots': { showSlots: true },
}

Page({
  data: {
    phase: 'created', marker: 'BEFORE_ONLOAD', showBranch: true,
    showSlots: true, background: '#eeeeee', rows: initialRows,
  },
  onLoad: function() {
    var app = getApp()
    this.oraclePageSerial = ++app.pageSerial
    app.record({ hook: 'page.onLoad.before', page: this.oraclePageSerial, data: this.data })
    this.setData({ marker: 'A', phase: 'loaded' }, function() {
      app.record({ hook: 'page.onLoad.setData.callback', page: this.oraclePageSerial })
    }.bind(this))
    app.record({ hook: 'page.onLoad.after', page: this.oraclePageSerial })
  },
  onShow: function() { getApp().record({ hook: 'page.onShow', page: this.oraclePageSerial }) },
  onReady: function() {
    var app = getApp()
    app.record({ hook: 'page.onReady', page: this.oraclePageSerial })
    this.setData({ phase: 'ready' }, function() {
      app.record({ hook: 'page.onReady.setData.callback', page: this.oraclePageSerial })
    }.bind(this))
  },
  onUnload: function() { getApp().record({ hook: 'page.onUnload', page: this.oraclePageSerial }) },
  applyStep: function(name) {
    if (!Object.prototype.hasOwnProperty.call(patches, name)) throw new Error('Unknown oracle step: ' + name)
    var app = getApp()
    var page = this
    var patch = JSON.parse(JSON.stringify(patches[name]))
    app.record({ hook: 'step.before', name: name, page: page.oraclePageSerial, patch: patch })
    return new Promise(function(resolve) {
      page.setData(patch, function() {
        app.record({ hook: 'step.callback', name: name, page: page.oraclePageSerial })
        resolve({ name: name, patch: patch, pageSerial: page.oraclePageSerial })
      })
    })
  },
  // Observation reads do not setData or advance a view stamp.
  snapshot: function() {
    return {
      schemaVersion: 1, pageSerial: this.oraclePageSerial,
      phase: this.data.phase, data: JSON.parse(JSON.stringify(this.data)),
      lifecycle: getApp().oracleTrace.slice(), environment: wx.getSystemInfoSync(),
    }
  },
  sampleLayout: function() {
    return new Promise(function(resolve) {
      wx.createSelectorQuery().select('#style-probe').fields({
        rect: true, size: true, computedStyle: ['border-left-width', 'background-color'],
      }, function(result) { resolve(result || null) }).exec()
    })
  },
})
