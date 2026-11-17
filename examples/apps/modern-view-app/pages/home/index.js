Page({
  data: {
    count: 1,
    user: { profile: { name: 'Modern JS / TS' } },
    values: [3, 5, 8],
  },
  increment() {
    this.setData({ count: this.data.count + 1 })
  },
})
