const catalog = require('../../shared/catalog.js')
const cart = require('../../shared/cart.js')

Page({
  data: {
    products: catalog.products,
    cartCount: 0,
  },

  onShow() {
    this.setData({ cartCount: cart.count() })
  },

  openCart() {
    wx.navigateTo({ url: '/pages/cart/index' })
  },

  openDetail(event) {
    wx.navigateTo({ url: '/pages/detail/index?id=' + event.currentTarget.dataset.id })
  },

  addToCart(event) {
    cart.add(event.currentTarget.dataset.id, 1)
    this.setData({ cartCount: cart.count() })
    wx.showToast({ title: 'Added to cart', icon: 'success' })
  },
})
