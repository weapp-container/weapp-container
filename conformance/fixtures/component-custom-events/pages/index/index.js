function currentPage() { const pages = getCurrentPages(); return pages[pages.length - 1] }
Page({
  data: { ready: false, summary: null },
  bare(event) { getApp().record('bare', this, event) },
  colon(event) { getApp().record('colon', this, event) },
  direct(event) { getApp().record('direct', this, event) },
  capture(event) { getApp().record('capture', this, event) },
  bubble(event) { getApp().record('bubble', this, event) },
  caught(event) { getApp().record('caught', this, event) },
  onLoad() {
    const aliases = {}
    const counters = {}
    for (const [id, name] of [
      ['bare', 'probe'], ['colon', 'probe'], ['both', 'probe'], ['reverse', 'probe'],
      ['hyphen-bare', 'probe-hyphen'], ['hyphen-colon', 'probe-hyphen'], ['hyphen-both', 'probe-hyphen'],
      ['under-bare', 'probe_under'], ['under-colon', 'probe_under'], ['under-both', 'probe_under'],
    ]) {
      const result = this.selectComponent('#' + id).emit(name, {})
      aliases[id] = result
      counters[id] = { bare: 0, colon: 0 }
      for (const record of result.records) if (record.label in counters[id]) counters[id][record.label]++
    }
    const scenarios = {}
    for (const [name, id, options] of [
      ['private', 'local', {}],
      ['capture', 'local', { capturePhase: true }],
      ['bubble', 'local', { bubbles: true }],
      ['capture-bubble', 'local', { capturePhase: true, bubbles: true }],
      ['caught', 'caught', { capturePhase: true, bubbles: true }],
      ['capture-caught', 'capture-caught', { capturePhase: true, bubbles: true }],
    ]) scenarios[name] = this.selectComponent('#' + id).emit('signal', options)
    const boundary = this.selectComponent('#boundary')
    scenarios.local = boundary.emit({ bubbles: true })
    scenarios.composed = boundary.emit({ bubbles: true, composed: true })
    this.setData({ ready: true, summary: { launched: getApp().launched, capability: wx.canIUse('Component.triggerEvent'), aliases, counters, scenarios } })
  },
})
exports.inspect = function() { return currentPage().data.summary }
