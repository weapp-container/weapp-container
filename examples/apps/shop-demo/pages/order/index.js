const catalog = require('../../shared/catalog.js')
const cart = require('../../shared/cart.js')

function calculateTotal() {
  return cart.read().reduce((sum, item) => {
    const product = catalog.getProduct(item.id)
    return sum + (product ? product.price * item.quantity : 0)
  }, 0)
}

Page({
  data: {
    total: 0,
    submitted: false,
    orderNumber: '',
  },

  onShow() {
    if (!this.data.submitted) this.setData({ total: calculateTotal() })
  },

  placeOrder() {
    if (!this.data.total) return
    const orderNumber = 'MS-' + String(Date.now()).slice(-6)
    cart.clear()
    this.setData({ submitted: true, orderNumber })
    wx.showToast({ title: 'Order placed', icon: 'success' })
  },

  backHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },
})
