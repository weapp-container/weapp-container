Component({
  methods: {
    emit(name, options) {
      const app = getApp()
      const detail = { value: 7, callback: function() { return 9 } }
      detail.self = detail
      app.detail = detail
      app.records = [{ label: 'before' }]
      const returned = this.triggerEvent(name, detail, options)
      app.records.push({ label: 'after' })
      return {
        records: app.records.slice(),
        returnedUndefined: returned === undefined,
        circular: detail.self === detail,
        callable: detail.callback() === 9,
        handledBeforeReturn: detail.handled === true,
      }
    },
  },
})
