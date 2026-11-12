function extension() {
  if (typeof weappContainer === 'undefined') throw new Error('此宿主未安装身份与支付扩展');
  return weappContainer;
}
function identityText(value) {
  return value.hostLoggedIn
    ? (value.appLoggedIn ? '宿主已登录，此小程序已授权' : '宿主已登录，此小程序尚未授权')
    : '请先在宿主登录';
}
Page({
  data: {busy:false,identityText:'读取登录状态…',profileText:'',phoneText:'',orderId:'',orderText:'尚未创建订单',message:''},
  onLoad() {
    this.businessSession=null; this.order=null; this.attempt=0; this.retired=false;
    this.identityChanged=value=>this.setData({identityText:identityText(value)});
    try {this.identityChanged(extension().identity.getState());extension().identity.onChange(this.identityChanged);}
    catch(error) {this.setData({message:error.errMsg||error.message});}
  },
  onUnload() {this.retired=true;try{extension().identity.offChange(this.identityChanged);}catch(_){}},
  async run(action) {
    if(this.data.busy) return;
    this.setData({busy:true,message:''});
    try {await action();} catch(error) {if(!this.retired)this.setData({message:error.errMsg||error.message||String(error)});}
    finally {if(!this.retired)this.setData({busy:false});}
  },
  async business(path,data,method='POST') {
    const origin=getApp().globalData.businessOrigin;
    const response=await wx.request({url:origin+path,method,data,
      header:{'content-type':'application/json',...(method==='GET'?{'Authorization':'Bearer '+this.requireLogin()}:{} )}});
    if(response.statusCode<200||response.statusCode>=300)throw new Error(response.data.message||'业务后端请求失败');
    return response.data;
  },
  requireLogin() {if(!this.businessSession)throw new Error('请先登录此小程序');return this.businessSession;},
  login() {return this.run(async()=>{
    const {code}=await wx.login();
    const result=await this.business('/demo/login',{code});
    this.businessSession=result.businessSession;
    await extension().invoke('demo.identity.refresh',{});
    await wx.checkSession();
    this.identityChanged(extension().identity.getState());
    this.setData({message:'应用登录凭证已由业务后端兑换'});
  });},
  profile() {return this.run(async()=>{
    const result=await wx.getUserProfile({desc:'在本小程序显示昵称和头像'});
    this.setData({profileText:'已授权昵称：'+result.userInfo.nickName});
  });},
  phone(event) {return this.run(async()=>{
    const detail=event.detail||{};
    if(!detail.code)throw new Error(detail.errMsg||'手机号授权被拒绝');
    const result=await this.business('/demo/phone',{businessSession:this.requireLogin(),code:detail.code});
    this.setData({phoneText:'已授权号码尾号：'+result.phoneNumber.slice(-4)});
  });},
  createOrder() {return this.run(async()=>{
    if(this.order&&this.order.status!=='paid'&&this.order.status!=='closed')throw new Error('当前订单仍在等待处理，请查询或支付当前订单');
    // The backend fixes the product and amount. The guest sends no authoritative price.
    this.pendingKey=this.pendingKey||('reference-'+Date.now()+'-'+(++this.attempt));
    const order=await this.business('/demo/orders',{businessSession:this.requireLogin(),productId:'reference-item',idempotencyKey:this.pendingKey});
    this.order=order;this.pendingKey=null;
    this.setData({orderId:order.orderId,orderText:'订单状态：'+order.status});
  });},
  payOrder() {return this.run(async()=>{
    this.requireLogin();if(!this.order)throw new Error('请先创建订单');
    try {await extension().payment.request({orderId:this.order.orderId});}
    finally {await this.refreshOrder();}
  });},
  queryOrder() {return this.run(()=>this.refreshOrder());},
  async refreshOrder() {
    if(!this.order)throw new Error('请先创建订单');
    this.order=await this.business('/demo/orders/'+encodeURIComponent(this.order.orderId),undefined,'GET');
    if(!this.retired)this.setData({orderText:'后端最终状态：'+this.order.status});
  },
  logout() {return this.run(async()=>{
    // Native app logout revokes this application's grants and rebuilds its owners.
    await extension().identity.logout();
    this.businessSession=null;this.order=null;
  });}
});
