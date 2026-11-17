const settings = require('./settings.json')
const identity = { token: 'shared-cjs-instance' }

module.exports = {
  identity,
  settings,
  sum(values) { return values.reduce((total, value) => total + value, 0) },
  style(box) {
    return 'position:absolute;left:' + box.left + 'px;top:' + box.top
      + 'px;width:' + box.width + 'px;height:' + box.height
      + 'px;background-color:' + box.color + ';'
  },
}
