Page({
  data: {
    phase: 'initial', toggles: 0,
    whiteSpace: 'normal', wordBreak: 'normal', textAlign: 'start',
    raw: '  AA\tBB\r\n CC  DD  ',
    longLatin: 'Supercalifragilisticexpialidocious',
    cjk: '甲乙丙丁戊己庚辛壬癸',
    graphemes: 'A\u0301👩‍💻🇨🇳',
    alignment: 'AB',
  },
  onLoad() { getApp().trace.push('load') },
  onShow() { getApp().trace.push('show') },
  onReady() { getApp().trace.push('ready') },
  onToggle() {
    const changed = this.data.phase === 'initial'
    this.setData({
      phase: changed ? 'changed' : 'initial', toggles: this.data.toggles + 1,
      whiteSpace: changed ? 'break-spaces' : 'normal',
      wordBreak: changed ? 'break-all' : 'normal',
      textAlign: changed ? 'right' : 'start',
    })
  },
  onInspect() {
    const query = wx.createSelectorQuery()
    query.selectAll('.sample').fields({
      id: true, rect: true, size: true,
      computedStyle: ['font-size', 'line-height', 'white-space', 'word-break', 'text-align'],
    })
    query.exec(values => wx.setStorageSync('text-flow:observation', {
      route: this.route, data: this.data, trace: getApp().trace.slice(), geometry: values[0],
    }))
  },
})
