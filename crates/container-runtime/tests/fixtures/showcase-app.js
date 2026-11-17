App({onLaunch:function(){
  wx.setStorageSync('cart',{items:[{id:'coffee',quantity:2}],total:36});
  wx.request({url:'https://example.invalid/never',fail:function(error){
    wx.setStorageSync('deniedCallback',error.code);
  }}).catch(function(error){wx.setStorageSync('deniedPromise',error.code);});
  weappContainer.postMessage({kind:'showcase-ready'});
}});
