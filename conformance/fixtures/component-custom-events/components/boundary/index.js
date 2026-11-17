Component({
  methods: {
    direct(event) { getApp().record('boundary-direct', this, event) },
    bubble(event) { getApp().record('boundary-bubble', this, event) },
    emit(options) { return this.selectComponent('#nested').emit('signal', options) },
  },
})
