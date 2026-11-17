const STORAGE_KEY = 'transform-app-state'
const TRANSFORMS = [
  'translate(-50%, -50%)',
  'translate(-50%, -50%) rotate(90deg)',
  'none',
]

function save(page) {
  const data = page.data
  wx.setStorageSync(STORAGE_KEY, {
    large: data.large,
    width: data.width,
    height: data.height,
    mode: data.mode,
    transform: data.transform,
    taps: data.taps,
    lastTarget: data.lastTarget,
  })
}

function record(page, event) {
  const lifecycle = getApp().globalData.lifecycle
  lifecycle.push(event)
  page.setData({ lifecycle: lifecycle.slice() })
}

Page({
  data: {
    large: false,
    width: 40,
    height: 20,
    mode: 0,
    transform: TRANSFORMS[0],
    origin: 'left top',
    taps: 0,
    lastTarget: '',
    geometry: null,
    geometryLabel: '',
    persisted: null,
    lifecycle: [],
  },
  onLoad() {
    save(this)
    record(this, 'page:load')
  },
  onShow() {
    record(this, 'page:show')
  },
  onReady() {
    record(this, 'page:ready')
    this.onInspect()
  },
  onHide() {
    record(this, 'page:hide')
  },
  onToggle(event) {
    const large = !this.data.large
    this.setData({
      large,
      width: large ? 80 : 40,
      height: large ? 40 : 20,
      taps: this.data.taps + 1,
      lastTarget: event?.target?.id || 'method',
    }, () => {
      save(this)
      this.onInspect()
    })
  },
  onTransform(event) {
    const mode = (this.data.mode + 1) % TRANSFORMS.length
    this.setData({
      mode,
      transform: TRANSFORMS[mode],
      origin: mode === 1 ? 'bottom left' : 'left top',
      lastTarget: event?.target?.id || 'method',
    }, () => {
      save(this)
      this.onInspect()
    })
  },
  onReset() {
    this.setData({
      large: false,
      width: 40,
      height: 20,
      mode: 0,
      transform: TRANSFORMS[0],
      origin: 'left top',
      taps: 0,
      lastTarget: 'reset',
    }, () => {
      save(this)
      this.onInspect()
    })
  },
  onInspect() {
    const query = wx.createSelectorQuery()
    query.select('#box').boundingClientRect()
    query.exec((values) => {
      const geometry = values[0]
      this.setData({
        geometry,
        geometryLabel: geometry
          ? `${geometry.left}, ${geometry.top}, ${geometry.width}, ${geometry.height}`
          : 'unavailable',
        persisted: wx.getStorageSync(STORAGE_KEY),
      })
      console.log('transform-app:geometry', {
        geometry,
        width: this.data.width,
        height: this.data.height,
        transform: this.data.transform,
        origin: this.data.origin,
        lastTarget: this.data.lastTarget,
      })
    })
  },
})
