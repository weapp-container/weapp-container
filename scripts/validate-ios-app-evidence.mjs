#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This validates supplied evidence; it never manufactures simulator/GPU proof. */
export function validateIOSAppEvidence(probe, manifest) {
  return validateIOSSurfaceEvidence(probe, manifest, 'smoke')
}

/** A live embedding session proves presentation, not completed teardown. */
export function validateIOSEmbeddingEvidence(probe, manifest) {
  return validateIOSSurfaceEvidence(probe, manifest, 'embedding')
}

function validateIOSSurfaceEvidence(probe, manifest, mode) {
  const require = (condition, message) => { if (!condition) throw new Error(message) }
  require(probe?.status === 'passed', 'top-level app probe did not pass')
  require(probe.source === (mode === 'embedding' ? 'ios-skia-metal-embedding' : 'ios-skia-metal-app'), 'wrong evidence source')
  require(probe.schemaVersion === 1, 'unsupported iOS surface evidence schema version')
  require(probe.containerSurfaceAttached === true && probe.gpuSurface === true, 'direct container GPU surface missing')
  require(probe.rendererBackend === 'skia-gpu-metal', 'wrong renderer')
  require(probe.runtimeSurface?.loaded === true && probe.runtimeSurface?.nativeSurface === true
    && probe.runtimeSurface?.gpuSurface === true && probe.runtimeSurface?.renderer === 'skia-gpu-metal',
  'runtime did not confirm its own GPU surface')
  const drawable = probe.drawableReadback
  require(drawable?.format === 'bgra8-premultiplied' && drawable.width === probe.width && drawable.height === probe.height
    && Number.isInteger(drawable.width) && drawable.width > 0 && Number.isInteger(drawable.height) && drawable.height > 0
    && drawable.byteCount === drawable.width * drawable.height * 4
    && /^[0-9a-f]{64}$/.test(drawable.sha256 ?? '') && /^[0-9a-f]{64}$/.test(drawable.pngSha256 ?? ''),
  'actual GPU drawable readback is missing or invalid')
  const logicalViewport = probe.logicalViewport
  require(Number.isSafeInteger(logicalViewport?.width) && logicalViewport.width > 0
    && Number.isSafeInteger(logicalViewport?.height) && logicalViewport.height > 0,
  'logical viewport is missing or invalid')
  if (mode === 'embedding') require(probe.sessionOpen === true, 'embedding did not retain its live session')
  else require(probe.detachStatus === 0, 'Metal teardown failed')
  // MTLCommandBufferStatus.completed is 4. A completion callback is also
  // invoked for failed command buffers, so callback delivery is insufficient.
  require(probe.commandBufferStatus === 4, 'Metal command buffer did not complete successfully')
  require(probe.host === 'ios' && ['quickjs', 'v8'].includes(probe.engine), 'missing actual host/engine identity')
  require(typeof probe.sessionId === 'string' && probe.sessionId.length > 0, 'missing runtime session identity')
  const startup = probe.startup ?? {}
  require(startup.input === 'portable-pack', 'inline frame cannot satisfy the pack gate')
  require(/^[0-9a-f]{64}$/.test(startup.integrityRoot ?? '') && startup.integrityRoot === manifest?.integrity?.root, 'surface evidence uses another manifest')
  require(manifest.routes?.some(route => route.path === startup.route), 'surface route is absent from manifest')
  const renderRoute = mode === 'embedding' ? probe.route : startup.route
  require(manifest.routes?.some(route => route.path === renderRoute), 'current surface route is absent from manifest')
  require(probe.manifestIntegrity === startup.integrityRoot && startup.sessionId === probe.sessionId
    && startup.engine === probe.engine, 'surface uses another engine, session or manifest')
  const failedMessage = message => message?.op === 'error' || message?.payload?.ok === false
  require(Array.isArray(startup.diagnostics) && !startup.diagnostics.some(failedMessage), 'startup contains runtime errors or missing diagnostics')
  const requestIds = new Set()
  let renderFrameId
  for (const operation of ['app.init', 'app.lifecycle', 'page.push', 'render.commit', 'render.snapshot']) {
    const evidence = probe.operations?.[operation]
    require(evidence?.status === 0, `missing successful ${operation}`)
    let value
    try { value = JSON.parse(evidence.json) } catch { throw new Error(`invalid ${operation} response JSON`) }
    if (operation === 'render.snapshot') {
      require(evidence.sessionId === probe.sessionId && value.frame_id === renderFrameId,
        'snapshot uses another session or frame')
      require(/^[0-9a-f]{64}$/.test(value.sha256 ?? '') && probe.snapshotSha256 === value.sha256,
        'surface uses another logical snapshot')
      require(Number.isInteger(value.width) && value.width > 0 && Number.isInteger(value.height) && value.height > 0
        && value.format === 'rgba8-premultiplied' && value.pixelCount === value.width * value.height * 4,
      'missing rendered snapshot pixels')
      require(value.width === logicalViewport.width && value.height === logicalViewport.height,
        'snapshot dimensions differ from logical viewport')
      continue
    }
    let request
    try { request = evidence.request ?? JSON.parse(evidence.requestJson) } catch { throw new Error(`invalid ${operation} request JSON`) }
    require(request?.op === operation && request.kind === 'request' && request.sessionId === probe.sessionId
      && request.protocolVersion === '1.0' && typeof request.requestId === 'string' && request.requestId.length > 0,
    `invalid ${operation} request identity`)
    require(!requestIds.has(request.requestId), 'startup reused a request identity')
    requestIds.add(request.requestId)
    const messages = value.messages
    require(Array.isArray(messages), `missing ${operation} response batch`)
    const responses = messages.filter(message => message.kind === 'response' && message.op === operation)
    const response = responses.length === 1 ? responses[0] : null
    require(response?.payload?.ok === true, `missing successful ${operation} acknowledgement`)
    require(response.requestId === request.requestId && response.sessionId === probe.sessionId
      && response.protocolVersion === '1.0', `${operation} acknowledgement is from another request or session`)
    require(!messages.some(failedMessage), `${operation} emitted an error or failed payload`)
    if (operation === 'app.init') {
      require(response.payload.engineProviderAvailable === true, 'protocol-only app initialization')
      require(response.payload.loadedModules === manifest.modules?.length && manifest.modules.length > 0, 'not all manifest modules were loaded')
      require(response.payload.engine === probe.engine && response.payload.manifest?.integrity === startup.integrityRoot,
        'app.init acknowledged another engine or manifest')
    }
    if (operation === 'app.lifecycle') require(request.payload?.event === 'launch', 'startup did not launch app lifecycle')
    if (operation === 'page.push') require(request.payload?.path === startup.route, 'page request uses another route')
    if (operation === 'render.commit') {
      const templateId = `template:${renderRoute}.wxml`
      require(request.payload?.templateId === templateId && request.payload?.root === undefined
        && manifest.templates?.some(template => template.id === templateId), 'render did not use the route manifest template')
      const viewport = request.payload?.viewport
      require(viewport?.x === 0 && viewport?.y === 0
        && viewport.width === logicalViewport.width && viewport.height === logicalViewport.height,
      'render request viewport is missing or differs from logical viewport')
      require(response.payload.committed === true && response.payload.source === 'manifest'
        && response.payload.templateId === templateId, 'frame publication not acknowledged')
      renderFrameId = response.payload.frameId
      require(Number.isInteger(renderFrameId) && renderFrameId > 0 && probe.frameId === renderFrameId
        && request.payload?.frameId === renderFrameId, 'surface presented another frame')
    }
  }
  return { schemaVersion: 1, status: 'passed', source: probe.source, integrityRoot: startup.integrityRoot,
    route: renderRoute, mode, teardownVerified: mode === 'smoke', evidenceBoundary: 'rust-skia-metal-drawable' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length < 4 || process.argv.length > 5 || (process.argv[4] && !['smoke', 'embedding'].includes(process.argv[4]))) {
      throw new Error('usage: validate-ios-app-evidence.mjs <evidence.json> <manifest.json> [smoke|embedding]')
    }
    const probe = JSON.parse(await readFile(process.argv[2], 'utf8'))
    const manifest = JSON.parse(await readFile(process.argv[3], 'utf8'))
    const validate = process.argv[4] === 'embedding' ? validateIOSEmbeddingEvidence : validateIOSAppEvidence
    console.log(JSON.stringify(validate(probe, manifest), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
