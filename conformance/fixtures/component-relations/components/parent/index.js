const KEY = '../child/index'
function record(instance, event, target) { getApp().record('parent', event, instance, KEY, target) }
Component({
  data: { label: 'parent' },
  relations: {
    '../child/index': {
      type: 'descendant',
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
