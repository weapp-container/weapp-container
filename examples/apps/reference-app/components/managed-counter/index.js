Component({
  properties: {
    config: {
      type: Object,
      value: {
        label: '组件独立状态',
        step: 1,
      },
    },
  },
  data: {
    count: 0,
  },
  methods: {
    increment() {
      this.setData({ count: this.data.count + this.properties.config.step })
    },
  },
})
