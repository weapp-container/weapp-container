const KEY = '../parent/index'
function record(instance, event, target) { getApp().record('child', event, instance, KEY, target) }
Component({
  data: { label: 'child', count: 0, color: '#e53935' },
  methods: {
    bump() { this.setData({ count: this.data.count + 1, color: '#1976d2' }) },
  },
  relations: {
    '../parent/index': {
      type: 'ancestor',
      linked(target) { record(this, 'linked', target) },
      unlinked(target) { record(this, 'unlinked', target) },
    },
  },
  lifetimes: {
    attached() { record(this, 'attached') },
    ready() { record(this, 'ready') },
    detached() { record(this, 'detached') },
  },
})
