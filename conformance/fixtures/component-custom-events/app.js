App({
  launched: false,
  records: [],
  detail: null,
  onLaunch() { this.launched = true },
  record(label, owner, event) {
    this.records.push({
      label,
      owner: owner.id || 'page',
      target: event.target.id,
      current: event.currentTarget.id,
      phase: event.phase,
      sameDetail: event.detail === this.detail,
      circular: event.detail.self === event.detail,
      callable: event.detail.callback() === 9,
      value: event.detail.value,
    })
    event.detail.handled = true
  },
})
