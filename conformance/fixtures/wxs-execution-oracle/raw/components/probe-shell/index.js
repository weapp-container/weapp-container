Component({
  options: { multipleSlots: true },
  properties: { label: String, marker: String },
  observers: {
    marker: function(value) {
      getApp().record({ hook: 'component.marker', serial: this.oracleComponentSerial || null, label: this.data.label, value: value })
    },
  },
  lifetimes: {
    created: function() {
      this.oracleComponentSerial = ++getApp().componentSerial
      getApp().record({ hook: 'component.created', serial: this.oracleComponentSerial })
    },
    attached: function() { getApp().record({ hook: 'component.attached', serial: this.oracleComponentSerial, label: this.data.label }) },
    ready: function() { getApp().record({ hook: 'component.ready', serial: this.oracleComponentSerial, label: this.data.label }) },
    detached: function() { getApp().record({ hook: 'component.detached', serial: this.oracleComponentSerial, label: this.data.label }) },
  },
})
