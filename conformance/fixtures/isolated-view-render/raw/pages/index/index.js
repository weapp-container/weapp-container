Page({
  data: {
    title: 'fixture',
    rows: [
      { id: 'a', label: 'A', visible: true },
      { id: 'b', label: 'B', visible: false },
      { id: 'c', label: 'C', visible: true }
    ]
  },
  onTap: function () { this.setData({ title: 'updated' }); }
});
