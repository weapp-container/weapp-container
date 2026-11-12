Component({
  properties: { label: String, marker: String },
  lifetimes: {
    created: function() {
      this.oracleComponentSerial = ++getApp().componentSerial
      getApp().record({ hook: 'no-slot.created', serial: this.oracleComponentSerial })
    },
    attached: function() { getApp().record({ hook: 'no-slot.attached', serial: this.oracleComponentSerial, label: this.data.label }) },
    ready: function() { getApp().record({ hook: 'no-slot.ready', serial: this.oracleComponentSerial, label: this.data.label }) },
    detached: function() { getApp().record({ hook: 'no-slot.detached', serial: this.oracleComponentSerial, label: this.data.label }) },
  },
})
