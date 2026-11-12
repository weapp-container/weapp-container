// Shared wire fixture for tests of the shipped inspector, not a second client.
export const presentationFixture = {
  schemaVersion: 1, revision: 0, generation: 0, logicalWidth: 375, logicalHeight: 667,
  renderScale: 'auto', effectiveScale: 1, fps: 60,
}

export function encodeFrame(frame, overrides = {}) {
  const pixels = Uint8Array.from(frame.pixels)
  const header = {
    schemaVersion: 1, sessionId: '', frameId: frame.frameId ?? frame.frame_id ?? 1,
    configGeneration: 0, logicalWidth: 375, logicalHeight: 667,
    width: frame.width, height: frame.height, stride: frame.width * 4,
    format: 'rgba8', byteLength: pixels.byteLength, ...overrides,
  }
  const json = new TextEncoder().encode(JSON.stringify(header))
  const output = new Uint8Array(4 + json.length + pixels.length)
  new DataView(output.buffer).setUint32(0, json.length, true)
  output.set(json, 4)
  output.set(pixels, 4 + json.length)
  return output.buffer
}
