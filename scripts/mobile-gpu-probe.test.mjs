import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGpuProbe, parseSurfaceProbe } from './mobile-gpu-probe.mjs'

test('missing probe remains unavailable and cannot claim a container surface', () => {
  const report = parseGpuProbe([], 'android-egl')
  assert.equal(report.status, 'unavailable')
  assert.equal(report.contextCreated, false)
  assert.equal(report.containerSurfaceAttached, false)
})

test('valid platform context evidence preserves hardware metadata', () => {
  const report = parseGpuProbe([
    'I/WEAPP_CONTAINER_GPU_PROBE: {"schemaVersion":1,"source":"android-egl","status":"passed","contextCreated":true,"hardwareAccelerated":true,"containerSurfaceAttached":false,"renderer":"Adreno"}',
  ], 'android-egl')
  assert.equal(report.status, 'passed')
  assert.equal(report.contextCreated, true)
  assert.equal(report.hardwareAccelerated, true)
  assert.equal(report.renderer, 'Adreno')
  assert.equal(report.containerSurfaceAttached, false)
})

test('device probe overclaim is downgraded and reported as failed', () => {
  const report = parseGpuProbe([
    'WEAPP_CONTAINER_GPU_PROBE {"schemaVersion":1,"source":"ios-metal","status":"passed","contextCreated":true,"hardwareAccelerated":true,"containerSurfaceAttached":true}',
  ], 'ios-metal')
  assert.equal(report.status, 'failed')
  assert.equal(report.containerSurfaceAttached, false)
  assert.match(report.reason, /cannot attest/)
})

test('malformed probe is failed instead of silently accepted', () => {
  const report = parseGpuProbe(['WEAPP_CONTAINER_GPU_PROBE {not-json}'], 'harmony-arkui')
  assert.equal(report.status, 'failed')
  assert.equal(report.contextCreated, false)
  assert.equal(report.containerSurfaceAttached, false)
})

test('host GLES presentation is recorded without promoting the container renderer', () => {
  const report = parseSurfaceProbe([
    'I/WEAPP_CONTAINER_SURFACE_PROBE: {"schemaVersion":1,"source":"android-gles-window","status":"passed","backend":"gles-window-blit","hostSurfaceAttached":true,"containerSurfaceAttached":false,"rendererBackend":"software-fallback"}',
  ], 'android-gles-window')
  assert.equal(report.status, 'passed')
  assert.equal(report.hostSurfaceAttached, true)
  assert.equal(report.containerSurfaceAttached, false)
  assert.equal(report.rendererBackend, 'software-fallback')
})

test('surface probe rejects a container GPU overclaim from a non-GPU renderer', () => {
  const report = parseSurfaceProbe([
    'WEAPP_CONTAINER_SURFACE_PROBE {"schemaVersion":1,"status":"passed","hostSurfaceAttached":true,"containerSurfaceAttached":true,"rendererBackend":"software-fallback"}',
  ], 'android-gles-window')
  assert.equal(report.status, 'failed')
  assert.equal(report.containerSurfaceAttached, false)
})

test('iOS Metal layer probe preserves a headless drawable block', () => {
  const report = parseSurfaceProbe([
    'WEAPP_CONTAINER_SURFACE_PROBE {"schemaVersion":1,"source":"ios-metal-layer","status":"blocked","hostSurfaceAttached":false,"containerSurfaceAttached":false,"gpuSurface":false,"rendererBackend":"software-fallback","evidenceBoundary":"runtime-snapshot-upload","reason":"CAMetalLayer.nextDrawable returned nil"}',
  ], 'ios-metal-layer')
  assert.equal(report.status, 'blocked')
  assert.equal(report.hostSurfaceAttached, false)
  assert.equal(report.containerSurfaceAttached, false)
  assert.equal(report.evidenceBoundary, 'runtime-snapshot-upload')
})

test('iOS Metal layer probe accepts a direct Skia drawable surface', () => {
  const report = parseSurfaceProbe([
    'WEAPP_CONTAINER_SURFACE_PROBE {"schemaVersion":1,"source":"ios-skia-metal-layer","status":"passed","hostSurfaceAttached":true,"containerSurfaceAttached":true,"gpuSurface":true,"rendererBackend":"skia-gpu-metal","evidenceBoundary":"rust-skia-metal-drawable"}',
  ], 'ios-skia-metal-layer')
  assert.equal(report.status, 'passed')
  assert.equal(report.hostSurfaceAttached, true)
  assert.equal(report.containerSurfaceAttached, true)
  assert.equal(report.gpuSurface, true)
  assert.equal(report.rendererBackend, 'skia-gpu-metal')
  assert.equal(report.evidenceBoundary, 'rust-skia-metal-drawable')
})

