Page({
  data: {
    motto: 'Taro 页面结构整理为可独立运行的示例',
    count: 0
  },
  increment () {
    this.setData({
      count: this.data.count + 1
    })
  }
})
