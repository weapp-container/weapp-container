const catalog = require('../../shared/catalog.js')
const cart = require('../../shared/cart.js')

Page({
  data: {
    product: null,
    cartCount: 0,
  },

  onLoad(options) {
    this.setData({ product: catalog.getProduct(options.id) })
  },

  onShow() {
    this.setData({ cartCount: cart.count() })
  },

  back() {
    wx.navigateBack({ delta: 1 })
  },

  openCart() {
    wx.navigateTo({ url: '/pages/cart/index' })
  },

  addToCart() {
    if (!this.data.product) return
    cart.add(this.data.product.id, 1)
    this.setData({ cartCount: cart.count() })
    wx.showToast({ title: 'Added to cart', icon: 'success' })
  },
})
