Component({
  data: { count: 0 },
  properties: { label: { type: String, value: "default", observer(next, previous) {
    __managed_trace.push(["property", this.scopeId, next, previous]);
  } }, titleText: { type: String, value: "fallback" } },
  lifetimes: {
    created() {
      __managed_trace.push(["created", this.scopeId]);
      this.setData({ count: this.data.count + 1 });
    },
    attached() { __managed_trace.push(["attached", this.scopeId]); },
    ready() { __managed_trace.push(["ready", this.scopeId]); },
    detached() { __managed_trace.push(["detached", this.scopeId]); }
  },
  methods: {
    handle(event) {
      __managed_trace.push(["component", this.scopeId, event.currentTarget.id]);
      this.setData({ count: this.data.count + 1 });
    },
    stop(event) {
      __managed_trace.push(["stop", this.scopeId]);
      event.stopPropagation();
    },
    editLabel(value) { this.setData({ label: value }); },
    late() {
      const instance = this;
      setTimeout(function() { instance.setData({ count: 99 }); }, 1);
    }
  }
});
