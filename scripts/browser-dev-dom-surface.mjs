/** Harness observation only. A hidden pending/retiring iframe is not the
 * current input surface. Production still owns every permit and input fence. */
export const INTERACTIVE_DOM_SURFACE_SELECTOR = '#dev-surface [data-worker-web-session] iframe[title="Weapp Container DOM surface"]:not([inert])'

/** Serialized as an init script; importing this module starts no browser. */
export function installDomSurfaceProbe() {
  if (window !== window.top) return
  const selector = '#dev-surface [data-worker-web-session] iframe[title="Weapp Container DOM surface"]:not([inert])'
  const allSelector = '#dev-surface [data-worker-web-session] iframe[title="Weapp Container DOM surface"]'
  const ownerFields = ['workerEpoch', 'sessionId', 'packSha256', 'transportBackend']
  const keyFields = ['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile']
  const same = (a, b, fields) => a && b && fields.every(field => a[field] === b[field])
  const validKey = (key, owner) => key?.sessionId === owner.sessionId && key.profile === 'webview'
    && keyFields.slice(1, -1).every(field => typeof key[field] === 'string' && /^(?:0|[1-9][0-9]*)$/.test(key[field])
      && key[field].length <= 20 && BigInt(key[field]) <= 18446744073709551615n)
  const current = ({ owner: expectedOwner, key: expectedKey } = {}) => {
    const frames = [...document.querySelectorAll(selector)]
    if (frames.length > 1) throw new Error('Multiple interactive DOM surfaces violate the single-primary input boundary')
    const frame = frames[0], manager = window.weappContainerDev?.status.manager, executing = manager?.executing, owner = executing?.owner
    if (!frame || !owner || executing.inputEnabled !== true || owner.transportBackend !== 'browser-view'
      || frame.isConnected !== true || frame.ownerDocument !== document || frame.inert !== false
      || frame.style.pointerEvents !== 'auto' || frame.style.visibility !== 'visible'
      || !frame.contentDocument || !frame.contentWindow || expectedOwner && !same(owner, expectedOwner, ownerFields)) return null
    const audit = window.__browserDevSmokeAudit.read()
    if (audit.droppedEvents || audit.droppedTraces) throw new Error('Current DOM surface audit is incomplete')
    const traces = audit.traces.filter(value => value.direction === 'receive' && value.workerEpoch === owner.workerEpoch && value.sessionId === owner.sessionId)
    const finals = traces.flatMap((trace, traceIndex) => (trace.domPresentations ?? []).filter(value => validKey(value.key, owner)).map(value => ({ ...value, traceIndex })))
    const final = finals.reduce((latest, value) => {
      if (!latest || BigInt(value.key.presentationRevision) > BigInt(latest.key.presentationRevision)) return value
      if (value.key.presentationRevision === latest.key.presentationRevision) {
        if (!same(value.key, latest.key, keyFields) || value.inputEnabled !== latest.inputEnabled)
          throw new Error('Conflicting native DOM finals cannot identify a current surface')
        return value
      }
      return latest
    }, null)
    if (!final?.inputEnabled || expectedKey && !same(final.key, expectedKey, keyFields)) return null
    const key = final.key
    const prepared = traces.flatMap((trace, traceIndex) => (trace.domPreparations ?? []).map(value => ({ ...value, traceIndex })))
      .findLast(value => (value.traceIndex < final.traceIndex || value.traceIndex === final.traceIndex && value.messageIndex < final.messageIndex) && same(value.key, key, keyFields)
        && value.scheduling?.version === '1.0' && same(value.scheduling.key, key, keyFields))
    const input = prepared?.scheduling.consumedInput
    if (!input || input.pageId !== key.pageId || typeof input.routePath !== 'string' || !input.routePath
      || typeof input.templateRevision !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(input.templateRevision)
      || input.templateRevision.length > 20 || BigInt(input.templateRevision) > 18446744073709551615n
      || !input.viewport || !['x', 'y', 'width', 'height'].every(field => Number.isFinite(input.viewport[field]))
      || input.viewport.width <= 0 || input.viewport.height <= 0) return null
    const latest = traces.findLast(value => value.runtimeState)?.runtimeState
    if (!latest || latest.lifecycle !== 'Active' || latest.rendererProfile !== 'webview'
      || latest.surfaceGeneration !== key.surfaceGeneration || latest.currentPage?.pageId !== input.pageId
      || latest.currentPage?.path !== input.routePath || latest.templateRevision !== input.templateRevision
      || !['x', 'y', 'width', 'height'].every(field => latest.viewport?.[field] === input.viewport[field])) return null
    const observation = { kind: 'observed-dom-final', value: { owner, key, consumedInput: input,
      nativePreparation: { requestId: prepared.requestId, key: prepared.key, scheduling: prepared.scheduling },
      nativeFinal: { requestId: final.requestId, inputEnabled: final.inputEnabled, key: final.key } } }
    return { frame, owner, key, observation, allFrameCount: document.querySelectorAll(allSelector).length }
  }
  Object.defineProperty(window, '__browserDevDomSurface', { value: Object.freeze({ selector, current }) })
}
