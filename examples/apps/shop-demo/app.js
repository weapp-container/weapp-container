const catalog = require('./shared/catalog.js')

App({
  globalData: {
    appName: 'Morrow Supply',
    catalog: catalog.products,
  },
  onLaunch() {
    this.globalData.startedAt = Date.now()
  },
})
