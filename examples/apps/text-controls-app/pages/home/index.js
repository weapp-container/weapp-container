const LOG_LIMIT = 24

function position(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

function appendObservation(page, event) {
  const detail = event.detail || {}
  const observation = {
    type: event.type,
    id: event.currentTarget.id,
    value: typeof detail.value === 'string' ? detail.value : '',
    cursor: position(detail.cursor),
    selectionStart: position(detail.selectionStart),
    selectionEnd: position(detail.selectionEnd),
  }
  page._observations = (page._observations || []).concat(observation).slice(-LOG_LIMIT)
  return observation
}

function visibleLog(page) {
  return (page._observations || []).map(entry => JSON.stringify(entry)).join('\n')
}

Page({
  data: {
    singleValue: 'Start here',
    multiValue: 'First line\nSecond line',
    editorDisabled: false,
    eventCount: 0,
    confirmCount: 0,
    focusCount: 0,
    blurCount: 0,
    lastControl: '',
    lastCursor: null,
    lastSelectionStart: null,
    lastSelectionEnd: null,
    logText: 'Focus or edit a field, then refresh this log.',
  },
  onLoad() {
    this._observations = []
  },
  onInput(event) {
    const observation = appendObservation(this, event)
    const field = event.currentTarget.id === 'multiline' ? 'multiValue' : 'singleValue'
    this.setData({
      [field]: observation.value,
      eventCount: this.data.eventCount + 1,
      lastControl: observation.id,
      lastCursor: observation.cursor,
      lastSelectionStart: observation.selectionStart,
      lastSelectionEnd: observation.selectionEnd,
      logText: visibleLog(this),
    })
  },
  onFocus(event) {
    appendObservation(this, event)
    // This deliberately renders from a real focus callback. Presenter-internal
    // focus restoration must not report another application focus event.
    this.setData({ focusCount: this.data.focusCount + 1, logText: visibleLog(this) })
  },
  onBlur(event) {
    appendObservation(this, event)
    this.setData({ blurCount: this.data.blurCount + 1, logText: visibleLog(this) })
  },
  onConfirm(event) {
    appendObservation(this, event)
    this.setData({ confirmCount: this.data.confirmCount + 1, logText: visibleLog(this) })
  },
  toggleDisabled() {
    this.setData({ editorDisabled: !this.data.editorDisabled })
  },
  replaceValue() {
    this.setData({ singleValue: 'Replaced by AppService', multiValue: 'AppService replacement\nEdit this second line.' })
  },
  refreshLog() {
    this.setData({ logText: visibleLog(this) || 'No control events yet.' })
  },
  clearLog() {
    this._observations = []
    this.setData({ eventCount: 0, confirmCount: 0, focusCount: 0, blurCount: 0, logText: 'Log cleared.' })
  },
})
