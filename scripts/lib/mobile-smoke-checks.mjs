const SHA256 = /^[0-9a-f]{64}$/

export function isValidatedRgbaSnapshot(operation, expectedFrameId = 1) {
  if (operation?.status !== 0 || typeof operation.json !== 'string') return false

  let snapshot
  try { snapshot = JSON.parse(operation.json) } catch { return false }
  return snapshot?.format === 'rgba8-premultiplied'
    && snapshot.frame_id === expectedFrameId
    && Number.isSafeInteger(snapshot.width) && snapshot.width > 0
    && Number.isSafeInteger(snapshot.height) && snapshot.height > 0
    && snapshot.pixelCount === snapshot.width * snapshot.height * 4
    && SHA256.test(snapshot.sha256 || '')
}
