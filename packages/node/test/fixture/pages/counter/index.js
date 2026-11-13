Page({
  data: {count:0, bubbles:0, message:'ready', order:[], value:''},
  increment() { this.setData({count:this.data.count+1}); return this.data.count; },
  bubble() { this.setData({bubbles:this.data.bubbles+1}); },
  input(event) { this.setData({value:event.detail.value}); },
  readClock() { return {now:Date.now(),date:+new Date(),performance:performance.now()}; },
  timing() {
    const record = value => this.setData({order:this.data.order.concat(value)});
    setTimeout(() => {record('timer'); Promise.resolve().then(() => record('microtask')); setTimeout(() => record('nested'),0);},10);
    setTimeout(() => record('second'),10);
  },
  ticks() { const step=n=>wx.nextTick(()=>{this.setData({count:n});if(n<4)step(n+1)}); step(1); },
  request() { return wx.request({url:'https://example.invalid/count',success:r=>this.setData({count:r.data.count}),fail:e=>this.setData({message:e.errMsg})}) && undefined; },
  throwLater() { queueMicrotask(() => {throw new Error('guest microtask failed')}); },
  logError() { console.error('expected console failure'); },
  infinite() { while(true) {} },
  endlessTimer() { const again=()=>setTimeout(again,0); again(); },
  remember() { wx.setStorageSync('count',this.data.count); },
  recalled() { return wx.getStorageSync('count'); },
  appData() { return getApp().globalData; },
  device() { return wx.getDeviceInfo(); },
  beginAbortableRequest() { this.__requestTask=wx.request({url:'https://example.invalid/count'}); },
  abortRequest() { this.__requestTask.abort(); }
});
