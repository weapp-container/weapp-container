// Browser-side finite acceptance of the freshly installed default direct app.
// Root owns browser creation, invocation, screenshots and browser cleanup.
const ORIGINAL_NOTO_SHA256 = 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da'
const PROFILE = 'sfnt-unhinted-v1'
const check = (condition, message) => { if (!condition) throw new Error(`Installed font acceptance: ${message}`) }
const copy = value => structuredClone(value)
const near = (actual, expected, name) => {
  check(Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) < 0.001,
    `${name}: ${actual} differs from actual CanvasKit ${expected}`)
}
const sameIdentity = value => value && Object.keys(value).length === 3 && value.sha256 === ORIGINAL_NOTO_SHA256
  && value.face_index === 0 && value.profile === PROFILE
const hexDigest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')

function messageLeaf(frame, text) {
  const matches = [], visit = (node, inMessage = false) => {
    const selected = inMessage || node.attributes?.id === 'message'
    if (selected && node.text === text) matches.push(node)
    for (const child of node.children ?? []) visit(child, selected)
  }
  visit(frame.root)
  check(matches.length === 1, 'original query-bound #message text leaf was not unique')
  return matches[0]
}
function requireFontReceipt(receipt, frame, revision) {
  check(receipt?.backend === 'canvaskit-webgl2' && receipt.status === 'submitted', 'default app did not submit CanvasKit WebGL2')
  check(receipt.frameId === frame.frame_id && receipt.renderRevision === String(revision), 'submission did not belong to the inspected WASM frame')
  check(receipt.textPlans?.font > 0 && ['fallback', 'native', 'local', 'legacy'].every(name => (receipt.textPlans[name] ?? 0) === 0),
    'submitted frame used an unbound or fallback text plan')
  check(receipt.runtimeBoundary?.frameBatches === 1 && receipt.runtimeBoundary.perNodeRuntimeCalls === 0
    && receipt.runtimeBoundary.softwareRgbaUploads === 0, 'default app changed its committed-frame rendering boundary')
}

export async function runInstalledFontScope() {
  const report = {
    schemaVersion: 1, classification: 'installed-web-direct-exact-font-scalar-scope', status: 'running',
    location: { origin: location.origin, pathname: location.pathname }, fontIdentity: null, samples: [], cleanup: [],
    limits: [
      'Finite default direct WebWASM QuickJS and CanvasKit 0.42.0 path on the executing browser only; no Worker, V8, other OS or SDK claim.',
      'Only the original pinned Noto Sans SC face zero at default variation coordinates, 16px scalar advances and normal vertical metrics are checked.',
      'No CSS family selection, CSS weight matching, complex shaping, ligatures, bidirectional text, general combining-mark placement or fallback-font acceptance.',
      'CanvasKit GPU submission and synchronized GPU readback establish no physical display/compositor completion or hardware-device evidence.',
      'The original accepted package Page/template/styles remain unchanged; public page.push query.message selects each original #message sample.',
    ],
  }
  globalThis.__installedFontScope = report
  let session = null, presenter = null, rejectedBefore = null, rejectedAfter = null, failure = null
  try {
    check(location.pathname === '/direct/legacy.html', 'run this scope on the installed default /direct/legacy.html entry')
    check(globalThis.weappReady && await globalThis.weappReady === true, 'installed default direct app did not become ready')
    session = globalThis.weapp
    check(session?.state === 'ready' && session.closed === false && session.host && session.presenter, 'default direct wrapper has no live native/painter owner')
    presenter = session.presenter
    check(session.capabilities?.quickjs === true, 'installed default app did not report QuickJS')
    check(session.rendererConfig?.renderer === 'canvaskit' && session.rendererConfig.canvaskit.version === '0.42.0', 'unexpected installed renderer configuration')
    check(sameIdentity(presenter.fontIdentity), 'painter is not bound to the original pinned Noto face/profile')
    check(session.rendererConfig.font.binary.sha256 === ORIGINAL_NOTO_SHA256, 'installed renderer font pin changed')
    report.fontIdentity = copy(presenter.fontIdentity)
    report.session = { sessionId: session.sessionId, route: session.route.path, capabilities: copy(session.capabilities),
      renderer: session.rendererConfig.renderer, canvas: { width: session.canvas.width, height: session.canvas.height } }

    for (const text of ['微信', '汉字', 'WWii汉字', 'e\u0301汉W']) {
      session.request('page.push', { path: session.route.path, data: {}, query: { message: text } })
      session.render()
      const frame = JSON.parse(session.host.render_frame_json()), revision = session.host.render_revision()
      const leaf = messageLeaf(frame, text), layout = leaf.text_layout, style = leaf.text_style
      check(style?.font_size === 16 && style.line_height === 'normal', 'original #message no longer has 16px normal text')
      check(sameIdentity(layout?.measurement?.font) && Object.keys(layout.measurement).length === 1, 'Rust layout is not bound to the painter face/profile')
      requireFontReceipt(session.presentation, frame, revision)
      const font = presenter.font, previousSize = font.getSize()
      let ids, advances, metrics
      try {
        font.setSize(16)
        ids = Array.from(font.getGlyphIDs(text))
        advances = Array.from(font.getGlyphWidths(ids, null))
        metrics = copy(font.getMetrics())
      } finally { font.setSize(previousSize) }
      check(ids.length === [...text].length && ids.every(glyph => glyph !== 0), 'original face has a missing sample glyph')
      check(layout.metrics.line_count === 1 && layout.glyphs.length === ids.length, 'finite original #message unexpectedly wrapped or lost a scalar')
      const expectedHeight = -metrics.ascent + metrics.descent + metrics.leading
      const expectedBaseline = -metrics.ascent + metrics.leading / 2
      let x = 0
      for (let index = 0; index < ids.length; index++) {
        const glyph = layout.glyphs[index]
        check(glyph.character === [...text][index], 'WASM layout changed scalar order')
        near(glyph.x, x, `committed x for ${text} scalar ${index}`)
        near(glyph.baseline_y, expectedBaseline, `normal baseline for ${text} scalar ${index}`)
        x += advances[index]
      }
      near(layout.metrics.width, x, `actual line width for ${text}`)
      near(layout.metrics.height, expectedHeight, `normal line height for ${text}`)
      if (layout.flow) {
        check(layout.flow.lines.length === 1, 'source-mapped line count differs')
        const line = layout.flow.lines[0]
        near(line.x, 0, 'finite start-aligned line x')
        near(line.advance_width, x, 'source-mapped advance')
        near(line.height, expectedHeight, 'source-mapped line height')
        near(line.baseline_y - line.y, expectedBaseline, 'source-mapped line baseline')
      }
      if (text.includes('\u0301')) check(advances[[...text].indexOf('\u0301')] === 0, 'actual combining acute advance changed')
      report.samples.push({ query: { message: text }, leaf: { id: leaf.id, bounds: copy(leaf.bounds), textStyle: copy(style) },
        committed: copy(layout), actualCanvasKit: { glyphIds: ids, advances, metrics, totalWidth: x },
        receipt: { backend: session.presentation.backend, status: session.presentation.status, frameId: session.presentation.frameId,
          renderRevision: session.presentation.renderRevision, generation: session.presentation.generation, textPlans: copy(session.presentation.textPlans),
          presentation: copy(session.presentation.presentation), runtimeBoundary: copy(session.presentation.runtimeBoundary),
          semanticGaps: copy(session.presentation.semanticGaps) } })
      if (typeof globalThis.__captureInstalledFontScreenshot === 'function') {
        await globalThis.__captureInstalledFontScreenshot({ index: report.samples.length, text })
      }
    }

    // Submit a cloned, corrupt binding through the actual presenter. Its CPU
    // preflight must retain the same receipt/generation and actual GPU pixels.
    const acceptedFrame = JSON.parse(session.host.render_frame_json())
    const invalid = copy(acceptedFrame), invalidLeaf = messageLeaf(invalid, 'e\u0301汉W')
    invalidLeaf.text_layout.measurement.font.sha256 = '0'.repeat(64)
    const acceptedReceipt = presenter.lastReceipt, generation = presenter.generation
    rejectedBefore = presenter.snapshotEvidence().rgba
    let rejection
    try { presenter.submit(invalid) }
    catch (error) { rejection = { code: error.code ?? null, message: String(error.message ?? error), nodeId: error.nodeId ?? null } }
    check(rejection?.code === 'ERR_RENDER', 'cloned wrong digest was not rejected by the real presenter')
    check(presenter.lastReceipt === acceptedReceipt && presenter.generation === generation, 'wrong digest replaced accepted receipt/generation')
    check(JSON.stringify(JSON.parse(session.host.render_frame_json())) === JSON.stringify(acceptedFrame), 'presenter modified the original WASM frame')
    rejectedAfter = presenter.snapshotEvidence().rgba
    check(rejectedBefore.length === rejectedAfter.length && rejectedBefore.every((value, index) => value === rejectedAfter[index]),
      'wrong digest changed the actual accepted GPU pixels')
    report.wrongDigest = { rejection, retainedReceipt: true, retainedGeneration: generation, actualGpuPixelsEqual: true,
      readback: { source: 'CanvasKit GPU surface readback', synchronization: 'gl.finish', byteLength: rejectedBefore.length } }
    report.checks = { installedDefaultEntry: true, publicQueryToQuickJS: true, originalWasmFontBoundLayout: true,
      exactPinnedPainterFace: true, actualGlyphAdvances: true, actualNormalMetrics: true, noFallbackPlans: true,
      wrongDigestRejectedBeforeReplacement: true, originalFrameUnmodified: true }
  } catch (error) {
    failure = error
    report.error = { code: error.code ?? null, message: String(error.message ?? error) }
  } finally {
    // Also close a partially initialized default owner if ready rejected.
    session ??= globalThis.weapp
    if (session) {
      presenter ??= session.presenter
      let closeError = null
      try { session.close() } catch (error) { closeError = String(error.message ?? error) }
      const closed = {
        kind: 'installed-default-direct-owner', ownership: 'borrowed-for-acceptance', id: session.sessionId,
        publicCloseReturned: closeError === null, wrapperClosed: session.closed === true, state: session.state,
        hostReleased: session.host === null, scheduledFrameCleared: session.frameRequest === null,
        abortSignalled: session.abortController.signal.aborted,
        painterDisposed: presenter?.disposed === true,
        painterResourcesReleased: !!presenter && ['font', 'typeface', 'surface', 'context'].every(key => presenter[key] === null)
          && presenter.contextHandle === 0,
        ...(closeError ? { error: closeError } : {}),
      }
      closed.terminal = closed.publicCloseReturned && closed.wrapperClosed && closed.state === 'closed'
        && closed.hostReleased && closed.scheduledFrameCleared && closed.abortSignalled
        && closed.painterDisposed && closed.painterResourcesReleased ? 'closed' : 'failed'
      report.cleanup.push(closed)
      if (closed.terminal !== 'closed' && !failure) {
        failure = new Error('Installed font acceptance: actual direct owner cleanup was incomplete')
        report.error = { code: null, message: failure.message }
      }
    }
  }
  if (report.wrongDigest && rejectedBefore && rejectedAfter) {
    report.wrongDigest.readback.beforeSha256 = await hexDigest(rejectedBefore)
    report.wrongDigest.readback.afterSha256 = await hexDigest(rejectedAfter)
  }
  report.status = failure ? 'failed' : 'passed'
  if (failure) { failure.report = report; throw failure }
  return report
}
