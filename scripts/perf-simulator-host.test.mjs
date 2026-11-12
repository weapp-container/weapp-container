import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const metric = value => ({ status: 'measured', unit: 'ms', value, p50: value, p95: value, p99: value })

for (const [description, setDataMs, expected] of [
  ['host runtime measurements replace the protocol baseline', 0.25, 'incomplete'],
  ['slow host setData fails despite a passing Node baseline', 80, 'failed'],
]) {
  test(description, { skip: process.platform === 'win32' }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'weapp-host-perf-test-'))
    try {
      const probe = join(directory, 'host-probe')
      const value = {
        metrics: { cold_start_ms: metric(5), first_frame_ms: metric(6), set_data_10k_ms: metric(setDataMs), bridge_p99_ms: metric(0.25) },
        hostProbe: { schemaVersion: 1, mode: 'simulator-process', rendererBackends: ['software-fallback'], nativeSurfaceAttached: false, gpuFrameSamplerAttached: false, evidenceBoundary: 'test software host', process: { sampleCount: 20 }, runtime: { lifecycleStates: ['Active'], snapshots: [], startupSampleCount: 20, setDataSampleCount: 20 } },
      }
      writeFileSync(probe, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(value))})\n`, { mode: 0o700 })
      const result = spawnSync(process.execPath, ['scripts/perf-simulator-host.mjs', '--pack', directory, '--simulator-bin', process.execPath, '--host-probe-bin', probe, '--iterations', '20'], { cwd: root, encoding: 'utf8', timeout: 30_000 })
      assert.equal(result.status, expected === 'failed' ? 1 : 0, result.stderr)
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, expected)
      assert.equal(report.metrics.set_data_10k_ms.p95, setDataMs)
      assert.equal(report.metrics.first_frame_ms.p95, 6)
      assert.equal(report.evidence.protocol, expected === 'failed' ? 'failed' : 'passed')
      assert.equal(report.evidence.nativeHost, 'not_measured')
      assert.equal(report.hostProbe.runtime.startupSampleCount, 20)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
