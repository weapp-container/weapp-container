const catalog = require('../../shared/catalog.js')
const cart = require('../../shared/cart.js')

function buildLines() {
  const source = cart.read()
  const lines = []
  for (let index = 0; index < source.length; index += 1) {
    const product = catalog.getProduct(source[index].id)
    if (!product) continue
    lines.push({
      id: product.id,
      name: product.name,
      image: product.image,
      price: product.price,
      quantity: source[index].quantity,
      lineTotal: product.price * source[index].quantity,
    })
  }
  return lines
}

function total(lines) {
  return lines.reduce((sum, line) => sum + line.lineTotal, 0)
}

Page({
  data: { lines: [], total: 0 },

  onShow() {
    this.refresh()
  },

  refresh() {
    const lines = buildLines()
    this.setData({ lines, total: total(lines) })
  },

  increase(event) {
    const id = event.currentTarget.dataset.id
    const line = this.data.lines.find(item => item.id === id)
    cart.setQuantity(id, (line ? line.quantity : 0) + 1)
    this.refresh()
  },

  decrease(event) {
    const id = event.currentTarget.dataset.id
    const line = this.data.lines.find(item => item.id === id)
    cart.setQuantity(id, (line ? line.quantity : 1) - 1)
    this.refresh()
  },

  remove(event) {
    cart.setQuantity(event.currentTarget.dataset.id, 0)
    this.refresh()
  },

  checkout() {
    if (!this.data.lines.length) return
    wx.navigateTo({ url: '/pages/order/index' })
  },
})
