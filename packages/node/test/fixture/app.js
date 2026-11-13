App({globalData:{},onLaunch(options){
 if(options.request) wx.request({url:'https://example.invalid/launch',success:r=>{this.globalData.launch=r.data}});
 if(options.device) this.globalData.device=wx.getDeviceInfo();
}});
