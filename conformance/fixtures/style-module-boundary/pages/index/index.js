const helper = require('../../lib/helper.cjs')
const repeated = require('../../lib/helper.cjs')
const settings = require('../../lib/settings.json')

Page({
  data: {
    count: 0,
    boxStyle: '',
    moduleIdentity: false,
    jsonIdentity: false,
    moduleLabel: '',
    moduleTotal: 0,
    eventType: '',
    eventTarget: '',
    eventToken: '',
  },
  onLoad() {
    this.setData({
      boxStyle: helper.style(settings.initial),
      moduleIdentity: helper === repeated && helper.identity === repeated.identity,
      jsonIdentity: settings === helper.settings,
      moduleLabel: settings.label,
      moduleTotal: helper.sum(settings.numbers),
    })
  },
  changeStyle(event) {
    this.setData({
      count: this.data.count + 1,
      boxStyle: helper.style(settings.updated),
      eventType: event.type,
      eventTarget: event.currentTarget.id,
      eventToken: event.detail.token,
    })
    return JSON.parse(JSON.stringify(this.data))
  },
})
