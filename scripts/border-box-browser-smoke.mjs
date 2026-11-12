import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAcceptedFrameSmoke, runFrameSmokeCli } from './overflow-clipping-browser-smoke.mjs'

export const BORDER_CASES = Object.freeze([
  'asymmetric-content-box', 'border-box-auto-height', 'page-default-viewport', 'minimum-border-box', 'zero-border',
  'padding-box-overflow', 'rounded-alpha-ring', 'transformed-border', 'cascade-currentcolor-reset',
  'dynamic-before', 'dynamic-after', 'retained-after-unsupported', 'recovered', 'saved-shared-style-values',
])

// Only consumes frames accepted by border_box.rs on both real JS engines.
// Importing this module never starts a browser, server, runtime or device.
export function runBorderBoxSmoke(options) {
  return runAcceptedFrameSmoke({ ...options, expectedCases: BORDER_CASES,
    title: 'Weapp Container border box verification' })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runFrameSmokeCli(runBorderBoxSmoke)
}
