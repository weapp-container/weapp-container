import { initSync, project_frame_json } from './generated/projection.js'
import { PROJECTION_WASM_PIN } from './generated/projection-pin.mjs'
import { WebConformanceError } from './frame-observer.mjs'

export async function loadRustProjection() {
  const response = await fetch(new URL('./generated/projection_bg.wasm', import.meta.url), { cache: 'no-store' })
  if (!response.ok) throw new WebConformanceError('ERR_CONFORMANCE_PROJECTION', 'Rust projection asset could not be loaded')
  const bytes = await response.arrayBuffer()
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
  if (bytes.byteLength !== PROJECTION_WASM_PIN.bytes || sha256 !== PROJECTION_WASM_PIN.sha256) {
    throw new WebConformanceError('ERR_CONFORMANCE_PROJECTION', 'Rust projection bytes do not match the built candidate pin')
  }
  initSync({ module: bytes })
  return project_frame_json
}
