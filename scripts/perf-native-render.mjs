#!/usr/bin/env node
/**
 * Combine the portable protocol baseline with the native Skia renderer probe.
 *
 * The Rust example is intentionally the owner of renderer timings: it submits
 * real RenderFrame batches through the feature-gated Skia backend. This script
 * only joins those measurements with the protocol metrics and validates the
 * resulting versioned report. The current `skia-backend` feature is an
 * offscreen CPU raster implementation, so it is deliberately rejected here.
 * A host GPU integration must report a `skia-gpu-*` backend before this can
 * produce native evidence.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const iterationsIndex = args.indexOf('--iterations')
const outPath = outIndex >= 0 ? args[outIndex + 1] : null
const iterations = iterationsIndex >= 0 ? args[iterationsIndex + 1] : '60'
if (!/^\d+$/.test(iterations) || Number(iterations) < 20) {
  throw new Error('--iterations must be an integer >= 20')
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runJson = (command, commandArgs, options = {}) => {
  const output = execFileSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  }).trim()
  return JSON.parse(output)
}

const native = runJson('cargo', [
  'run', '--quiet', '-p', 'container-render-skia',
  '--example', 'native-perf', '--features', 'skia-backend', '--',
  '--iterations', iterations,
])

const report = runJson('node', ['scripts/perf-baseline.mjs', '--host', 'desktop', '--engine', 'host', '--iterations', iterations])
const writeReport = async (value) => {
  const output = `${JSON.stringify(value, null, 2)}\n`
  process.stdout.write(output)
  if (outPath) {
    await mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
    await writeFile(outPath, output, 'utf8')
  }
}

if (!String(native.backend || '').startsWith('skia-gpu')) {
  // Preserve the protocol measurements as useful diagnostics, but mark the
  // host renderer unavailable. This lets CI upload a blocking report instead
  // of failing before an artifact exists or silently passing CPU raster data
  // as native GPU evidence.
  report.evidence.nativeHost = 'blocked'
  report.availability = {
    status: 'blocked',
    reason: `renderer backend ${native.backend || 'unknown'} is not an attached GPU surface`,
  }
  report.status = 'incomplete'
  report.disclaimer = 'Protocol metrics are available; host renderer metrics were not promoted because the probe did not attach a GPU surface. A skia-raster readback is CPU evidence only.'
  await writeReport(report)
} else {
  report.metrics.cold_start_ms = native.cold_start_ms
  report.metrics.hot_start_ms = native.hot_start_ms
  report.metrics.first_frame_ms = native.first_frame_ms
  report.metrics.scroll_dropped_frame_rate = native.scroll_dropped_frame_rate
  report.metrics.steady_state_memory_mb = native.steady_state_memory_mb
  report.evidence.nativeHost = 'passed'
  report.availability = {
    status: 'available',
    reason: 'The native Skia GPU probe collected host lifecycle, frame, scroll and RSS metrics on the current build machine.',
  }
  report.status = 'passed'
  report.disclaimer = 'Protocol metrics come from the portable batch baseline; renderer and host metrics come from the native Skia GPU probe. This is host evidence for the current build environment and is not a device certification.'
  await writeReport(report)
}
