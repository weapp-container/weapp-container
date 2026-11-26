Page({
  data: {
    count: 0,
    message: 'DevTools loop fixture ready'
  },
  onTap() {
    this.setData({ count: this.data.count + 1 })
  }
})
