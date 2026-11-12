// All observations remain ordinary page data for the read-only device inspector.
// Geometries are lossless JSON strings, de-duplicated per page; events reference
// them by index. Entries append and the first lifecycle sample is never replaced.
const TARGET_CONTROL_IDS = ['increment', 'save', 'custom', 'normal', 'back', 'tab', 'scroll', 'fault'].map(id => 'p0-' + id);
const TARGET_ATTEMPTS = 8;
const TARGET_DEADLINE_MS = 250;
const TARGET_RETRY_MS = 16;

export function createPage(kind) {
  return {
    data: {
      fixtureVersion: 1, kind, runMarker: '', instance: 0, journal: null, count: 0, stored: 0, ticks: 0,
      triggerViewFault: false, timerRunning: false, scrollEvents: 0,
      selectedRow: -1, events: [], geometries: [], first: null,
      lastRetired: null, targets: [], targetGeometry: null, targetError: null, error: '',
      rows: Array.from({ length: 40 }, (_, id) => ({ id, label: 'P0 row ' + id })),
    },
    record(event, detail) {
      const app = getApp();
      const sequence = ++app.globalData.sequence;
      let geometry;
      try { geometry = { window: wx.getWindowInfo(), capsule: wx.getMenuButtonBoundingClientRect() }; }
      catch (error) { geometry = { error: String(error.message || error) }; }
      const encoded = JSON.stringify(geometry);
      const geometries = this.data.geometries.slice();
      let geometryIndex = geometries.indexOf(encoded);
      if (geometryIndex < 0) { geometryIndex = geometries.length; geometries.push(encoded); }
      const sample = { sequence, event, geometry: geometryIndex, detail: detail || null };
      const events = this.data.events.concat([JSON.stringify(sample)]);
      const journal = app.globalData.journal;
      let globalGeometry = journal.geometries.indexOf(encoded);
      if (globalGeometry < 0) { globalGeometry = journal.geometries.length; journal.geometries.push(encoded); }
      // Compact tuples keep the complete cross-page history within the 48 KiB
      // read-only inspector limit: seq, kind, instance, event, geometry, detail.
      journal.events.push(JSON.stringify([sequence, kind, this.data.instance, event, globalGeometry, detail || null]));
      // Deliberately fail rather than silently erase old observations on long runs.
      if (events.length > 256) throw new Error('P0 fixture event capacity exceeded; start a fresh session');
      this.setData({ events, geometries, first: this.data.first || sample, journal: this._visible === false ? null : journal });
      return sample;
    },
    onLoad(options) {
      this._visible = true;
      this._unloaded = false;
      this.setData({ instance: ++getApp().globalData.instances, runMarker: getApp().globalData.runMarker });
      this.record('onLoad', { options });
      this.setData({ stored: wx.getStorageSync('p0-correctness-count') || 0, timerRunning: true });
      this._timer = setInterval(() => this.setData({ ticks: this.data.ticks + 1 }), 250);
    },
    onShow() {
      this._visible = true;
      this._targetLifecycleSequence = this.record('onShow').sequence;
      this.setData({ lastRetired: getApp().globalData.retired });
      this.measureTargets();
    },
    onReady() { this._targetLifecycleSequence = this.record('onReady').sequence; this.measureTargets(); },
    onResize(size) { this._targetLifecycleSequence = this.record('onResize', { size }).sequence; this.measureTargets(); },
    onHide() {
      this.record('onHide'); this._visible = false; this._cancelTargetMeasurement();
      this.setData({ journal: null, targets: [], targetGeometry: null });
    },
    onUnload() {
      this.record('onUnload');
      this._unloaded = true;
      this._cancelTargetMeasurement();
      this.setData({ targets: [], targetGeometry: null });
      clearInterval(this._timer);
      getApp().globalData.retired = {
        kind, first: this.data.first, events: this.data.events,
        geometries: this.data.geometries, ticks: this.data.ticks,
      };
    },
    _cancelTargetMeasurement() {
      this._targetEpoch = (this._targetEpoch || 0) + 1;
      if (this._targetRetryTimer != null) clearTimeout(this._targetRetryTimer);
      if (this._targetWatchdog != null) clearTimeout(this._targetWatchdog);
      this._targetRetryTimer = this._targetWatchdog = null;
    },
    measureTargets() {
      if (!this._visible || this._unloaded) return;
      this._cancelTargetMeasurement();
      const epoch = this._targetEpoch;
      const sequence = this._targetMeasurementSequence = (this._targetMeasurementSequence || 0) + 1;
      const lifecycleSequence = this._targetLifecycleSequence;
      const deadline = Date.now() + TARGET_DEADLINE_MS;
      let attempts = 0;
      this.setData({ targets: [], targetGeometry: null, targetError: null });
      const active = () => this._visible && !this._unloaded && this._targetEpoch === epoch;
      const fail = (code, message) => {
        if (!active()) return;
        this._cancelTargetMeasurement();
        const error = { code, message: String(message).slice(0, 256), attempts, measurementSequence: sequence };
        this.setData({ targets: [], targetGeometry: null, targetError: error });
        this.record('targets.error', error);
      };
      const timedOut = () => fail('ERR_TARGET_MEASUREMENT_TIMEOUT', 'Selector measurement exceeded 250 ms or 8 attempts.');
      let geometry;
      try { geometry = { window: wx.getWindowInfo(), capsule: wx.getMenuButtonBoundingClientRect() }; }
      catch (error) { fail(error.code || 'ERR_TARGET_MEASUREMENT', error.message || error); return; }
      this._targetWatchdog = setTimeout(timedOut, TARGET_DEADLINE_MS);
      const rejected = error => {
        if (!active()) return;
        // This is the container's typed temporary error, not a guessed delay
        // used as a render fence. All other failures remain explicit evidence.
        if (error && error.code === 'ERR_RENDER' &&
            String(error.message || error.errMsg || '').includes('selector query awaits presentation')) {
          if (attempts >= TARGET_ATTEMPTS || Date.now() + TARGET_RETRY_MS >= deadline) { timedOut(); return; }
          this._targetRetryTimer = setTimeout(attempt, TARGET_RETRY_MS);
          return;
        }
        fail(error && error.code || 'ERR_TARGET_MEASUREMENT', error && (error.message || error.errMsg) || error);
      };
      const measured = rects => {
        if (!active()) return;
        if (Date.now() >= deadline) { timedOut(); return; }
        let current;
        try { current = { window: wx.getWindowInfo(), capsule: wx.getMenuButtonBoundingClientRect() }; }
        catch (error) { rejected(error); return; }
        if (JSON.stringify(current) !== JSON.stringify(geometry)) {
          fail('ERR_TARGET_GEOMETRY_CHANGED', 'Window/capsule changed while selector measurement was pending.'); return;
        }
        const expected = kind === 'scroll' ? TARGET_CONTROL_IDS.concat(['p0-scroll-region']) : TARGET_CONTROL_IDS;
        if (!Array.isArray(rects) || rects.length !== expected.length ||
            !expected.every(id => rects.filter(rect => rect && rect.id === id).length === 1) ||
            !rects.every(rect => ['left', 'top', 'width', 'height'].every(key =>
              typeof rect[key] === 'number' && Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0)) {
          fail('ERR_TARGET_MEASUREMENT', 'Selector returned incomplete or invalid fixture rectangles.'); return;
        }
        this._cancelTargetMeasurement();
        this.setData({ targets: rects, targetError: null, targetGeometry: {
          schemaVersion: 1, kind, instance: this.data.instance, runMarker: this.data.runMarker,
          measurementSequence: sequence, lifecycleSequence, geometry,
          // Source tests pin fixed heading/status heights, control order and
          // CSS. Count/storage/timer text and this metadata cannot move controls.
          layoutProfile: 'p0-fixed-controls-v1',
          layoutInputs: { kind, windowWidth: geometry.window.windowWidth, windowHeight: geometry.window.windowHeight },
          targetCount: rects.length,
        } });
      };
      const attempt = () => {
        if (!active()) return;
        if (Date.now() >= deadline || attempts >= TARGET_ATTEMPTS) { timedOut(); return; }
        attempts++;
        try {
          const result = wx.createSelectorQuery().in(this).selectAll('.p0-target').boundingClientRect(measured).exec();
          // Official exec can return void; the container also exposes a Promise.
          if (result && typeof result.then === 'function') result.then(null, rejected);
        } catch (error) { rejected(error); }
      };
      attempt();
    },
    increment(event) {
      this.record('increment.begin', { x: event.detail && event.detail.x, y: event.detail && event.detail.y });
      this.setData({ count: this.data.count + 1 }, () => this.record('increment.callback'));
      this.record('increment.return');
    },
    save() {
      wx.setStorageSync('p0-correctness-count', this.data.count);
      this.setData({ stored: this.data.count }); this.record('storage.saved');
    },
    custom() { this.record('navigateTo.custom'); wx.navigateTo({ url: '/pages/custom/index' }); },
    normal() { this.record('navigateTo.normal'); wx.navigateTo({ url: '/pages/detail/index' }); },
    scrollPage() { this.record('navigateTo.scroll'); wx.navigateTo({ url: '/pages/scroll/index' }); },
    tab() { this.record('switchTab'); wx.switchTab({ url: '/pages/settings/index' }); },
    back() { this.record('navigateBack'); wx.navigateBack(); },
    home() { wx.switchTab({ url: '/pages/home/index' }); },
    fault() {
      this.record('fault.requested');
      this.setData({ triggerViewFault: true }, () => this.record('fault.callback'));
    },
    scroll(event) {
      this.setData({ scrollEvents: this.data.scrollEvents + 1 });
      if (this.data.scrollEvents === 1) this.record('scroll.first', { scrollTop: event.detail.scrollTop });
    },
    row(event) { this.setData({ selectedRow: event.currentTarget.dataset.id }); this.record('row.selected'); },
  };
}
