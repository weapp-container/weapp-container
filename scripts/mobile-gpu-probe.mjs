/**
 * Parse platform-owned device graphics-context evidence.
 *
 * This module intentionally has no renderer promotion path. A probe may show
 * that EGL/Metal/ArkUI can create a device context, while
 * `containerSurfaceAttached` is always normalized to false. Weapp Container GPU evidence
 * still requires a runtime `skia-gpu-*` backend and a host-owned surface.
 */
export function parseGpuProbe(lines, source) {
  const line = lines.find(value => value.includes('WEAPP_CONTAINER_GPU_PROBE'))
  if (!line) {
    return {
      schemaVersion: 1,
      source,
      status: 'unavailable',
      contextCreated: false,
      hardwareAccelerated: false,
      containerSurfaceAttached: false,
      evidenceBoundary: 'device-context-only',
      reason: 'native sample did not emit WEAPP_CONTAINER_GPU_PROBE',
    }
  }
  const start = line.indexOf('{')
  if (start < 0) {
    return {
      schemaVersion: 1,
      source,
      status: 'failed',
      contextCreated: false,
      hardwareAccelerated: false,
      containerSurfaceAttached: false,
      evidenceBoundary: 'device-context-only',
      reason: 'WEAPP_CONTAINER_GPU_PROBE line did not contain JSON',
      raw: line,
    }
  }
  try {
    const value = JSON.parse(line.slice(start))
    if (!value || typeof value !== 'object' || value.schemaVersion !== 1) {
      throw new Error('schemaVersion must be 1')
    }
    // A device probe is never allowed to imply that the container renderer
    // owns the context. A malformed or over-claiming sample is rejected by
    // the evidence parser instead of being silently normalized to passed.
    if (value.containerSurfaceAttached === true) {
      return {
        ...value,
        source: value.source || source,
        status: 'failed',
        contextCreated: value.contextCreated === true,
        hardwareAccelerated: value.hardwareAccelerated === true,
        containerSurfaceAttached: false,
        evidenceBoundary: value.evidenceBoundary || 'device-context-only',
        reason: 'device probe cannot attest containerSurfaceAttached',
      }
    }
    return {
      ...value,
      source: value.source || source,
      contextCreated: value.contextCreated === true,
      hardwareAccelerated: value.hardwareAccelerated === true,
      containerSurfaceAttached: false,
      evidenceBoundary: value.evidenceBoundary || 'device-context-only',
    }
  } catch (error) {
    return {
      schemaVersion: 1,
      source,
      status: 'failed',
      contextCreated: false,
      hardwareAccelerated: false,
      containerSurfaceAttached: false,
      evidenceBoundary: 'device-context-only',
      reason: `invalid WEAPP_CONTAINER_GPU_PROBE JSON: ${error.message || error}`,
      raw: line,
    }
  }
}

/**
 * Parse evidence that the host uploaded a complete runtime snapshot into its
 * own platform window surface. This is intentionally weaker than a GPU
 * renderer proof: a software Rust frame may be presented through GLES while
 * the container still does not own a Skia GPU surface.
 */
export function parseSurfaceProbe(lines, source) {
  const line = lines.find(value => value.includes('WEAPP_CONTAINER_SURFACE_PROBE'))
  const unavailable = (status, reason, raw = undefined) => ({
    schemaVersion: 1,
    source,
    status,
    hostSurfaceAttached: false,
    containerSurfaceAttached: false,
    evidenceBoundary: 'runtime-snapshot-upload',
    reason,
    ...(raw ? { raw } : {}),
  })
  if (!line) return unavailable('unavailable', 'native sample did not emit WEAPP_CONTAINER_SURFACE_PROBE')
  const start = line.indexOf('{')
  if (start < 0) return unavailable('failed', 'WEAPP_CONTAINER_SURFACE_PROBE line did not contain JSON', line)
  try {
    const value = JSON.parse(line.slice(start))
    if (!value || typeof value !== 'object' || value.schemaVersion !== 1) {
      throw new Error('schemaVersion must be 1')
    }
    const rendererBackend = typeof value.rendererBackend === 'string'
      ? value.rendererBackend
      : null
    if (value.containerSurfaceAttached === true && !rendererBackend?.startsWith('skia-gpu')) {
      return {
        ...value,
        source: value.source || source,
        status: 'failed',
        hostSurfaceAttached: value.hostSurfaceAttached === true,
        containerSurfaceAttached: false,
        evidenceBoundary: value.evidenceBoundary || 'runtime-snapshot-upload',
        reason: 'host presentation probe cannot attest a GPU-owned container surface',
      }
    }
    return {
      ...value,
      source: value.source || source,
      hostSurfaceAttached: value.hostSurfaceAttached === true,
      containerSurfaceAttached: value.containerSurfaceAttached === true,
      evidenceBoundary: value.evidenceBoundary || 'runtime-snapshot-upload',
    }
  } catch (error) {
    return unavailable('failed', `invalid WEAPP_CONTAINER_SURFACE_PROBE JSON: ${error.message || error}`, line)
  }
}

