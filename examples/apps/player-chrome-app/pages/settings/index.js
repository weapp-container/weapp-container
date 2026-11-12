Page({data:{stored:0},onShow(){this.setData({stored:wx.getStorageSync('chrome-count')||0});}});
