#!/usr/bin/env node
/** Real CanvasKit CPU replay of final-box transform matrices and accepted frames. */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSquareFrameReplay, runFrameReplayCli } from './runtime-frame-replay.mjs'

export const TRANSFORM_FRAME_CASES = Object.freeze([
  'percentage-content-box', 'percentage-border-box', 'percentage-auto-height',
  'flex-final-border-box', 'dynamic-small', 'dynamic-large', 'dynamic-small-again', 'dynamic-none',
  'origin-keyword-order', 'function-order-and-nesting', 'inherit-before', 'inherit-after', 'invalid-cascade',
  ...Array.from({ length: 6 }, (_, index) => `retained-unsupported-${index}`),
  ...Array.from({ length: 6 }, (_, index) => `recovered-unsupported-${index}`),
].sort())
export const runTransformFrameReplay = createSquareFrameReplay({
  caseNames: TRANSFORM_FRAME_CASES, size: 256, sourceFile: 'scripts/transform-frame-replay.mjs', sampleTolerance: 0,
})
export const main = argv => runFrameReplayCli(runTransformFrameReplay, argv)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() }
  catch (error) { process.stderr.write((error.stack || String(error)) + '\n'); process.exitCode = 1 }
}
