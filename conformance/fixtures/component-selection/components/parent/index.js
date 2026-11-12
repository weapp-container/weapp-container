Component({
  data: { label: 'parent' },
  lifetimes: {
    created() { this.captureChildren('created') },
    attached() { this.captureChildren('attached') },
    ready() { this.captureChildren('ready') },
  },
  methods: {
    captureChildren(phase) {
      let child
      let error
      try { child = this.selectComponent('#nested') } catch (value) { error = String(value) }
      getApp().record({ at: 'parent.' + phase, childPresent: !!child, childLabel: child && child.data && child.data.label || null, error: error || null })
    },
    inspectNestedOwner() {
      const child = this.selectComponent('#nested')
      return child ? child.ownerSnapshot() : { missing: true }
    },
    selectionSnapshot() {
      return ['#nested', '.inner', '.parent-wrapper > .inner', '#slotted', '#slotted-wrapped', '#direct', '#parent', 'probe-leaf'].map(selector => {
        try { const one = this.selectComponent(selector); const all = this.selectAllComponents(selector); return { selector, one: one && one.data && one.data.label || null, all: all.map(item => item && item.data && item.data.label || null) } }
        catch (error) { return { selector, error: String(error) } }
      })
    },
  },
})
