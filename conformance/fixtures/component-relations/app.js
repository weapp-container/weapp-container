App({
  launched: false,
  trace: [],
  callbacks: [],
  children: [],
  onLaunch() { this.launched = true },
  record(label, event, instance, key, target) {
    if (label === 'child' && event === 'attached') this.children.push(instance)
    const nodes = instance.getRelationNodes(key)
    this.trace.push(label + ':' + event + ':' + (nodes.map(node => node.data.label).join(',') || 'none'))
    if (target) this.callbacks.push({ label, event, instance, target,
      childGeneration: this.children.indexOf(label === 'child' ? instance : target) })
  },
})
