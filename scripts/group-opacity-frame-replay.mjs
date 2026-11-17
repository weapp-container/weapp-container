#!/usr/bin/env node
/** Real CanvasKit CPU replay of the complete fixed opacity corpus. */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSquareFrameReplay, runFrameReplayCli } from './runtime-frame-replay.mjs'

export const GROUP_OPACITY_FRAME_CASES = Object.freeze([
  'opaque', 'half', 'quarter', 'restored', 'zero', 'zero-after-tap', 'zero-after-touch',
  'nested-outer-opaque', 'nested-half', 'percent-and-css-wide',
  'overflow-clamps', 'negative-overflow-clamps', 'underflow-clamps',
  'double-overflow-clamps', 'double-underflow-clamps',
  'rejected-explicit-frame', 'recovered-after-rejection',
  ...Array.from({ length: 7 }, (_, index) => `rejected-deferred-${index}`),
  ...Array.from({ length: 7 }, (_, index) => `recovered-deferred-${index}`),
].sort())

export const runGroupOpacityFrameReplay = createSquareFrameReplay({
  caseNames: GROUP_OPACITY_FRAME_CASES, size: 160, sourceFile: 'scripts/group-opacity-frame-replay.mjs',
})
export const main = argv => runFrameReplayCli(runGroupOpacityFrameReplay, argv)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() }
  catch (error) { process.stderr.write((error.stack || String(error)) + '\n'); process.exitCode = 1 }
}
