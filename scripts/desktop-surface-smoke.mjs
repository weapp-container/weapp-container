#!/usr/bin/env node
/**
 * Run the real desktop winit + softbuffer surface smoke.
 *
 * The child owns a native platform window and presents one deterministic
 * frame. This is desktop window/presentation evidence only: softbuffer is a
 * CPU path and can never satisfy the Skia/Metal/Vulkan GPU gate.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outPath = resolve(outIndex >= 0 && args[outIndex + 1]
  ? args[outIndex + 1]
  : 'artifacts/desktop/native-window-surface.json')
const allowBlocked = args.includes('--allow-blocked')
const cargo = process.env.CARGO || 'cargo'
const manifest = resolve(root, 'examples/hosts/desktop/Cargo.toml')

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    renameSync(temporary, path)
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
    rmSync(path, { force: true })
    renameSync(temporary, path)
  }
}

function parseChildReport(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index])
      if (value && typeof value === 'object' && value.scope === 'desktop-native-window-surface') return value
    } catch {
      // Cargo may print a warning to stdout on older toolchains; inspect the
      // final JSON line rather than assuming the first line is the report.
    }
  }
  return null
}

const child = spawnSync(cargo, [
  'run', '--quiet', '--locked', '--manifest-path', manifest, '--', '--out', outPath,
], {
  cwd: root,
  encoding: 'utf8',
  timeout: 180_000,
  maxBuffer: 16 * 1024 * 1024,
})
const childReport = parseChildReport(child.stdout || '')
const stderr = child.stderr || ''
const eventLoopBlocked = /(no displays? available|failed to create event loop|event loop.*(not|cannot)|display server|wayland|x11|window creation failed|failed to connect)/i.test(stderr)
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: 'desktop-native-window-surface',
  commit: gitCommit(),
  host: {
    platform: process.platform,
    arch: process.arch,
    display: process.env.DISPLAY || process.env.WAYLAND_DISPLAY || null,
  },
  command: ['cargo', 'run', '--quiet', '--locked', '--manifest-path', manifest, '--', '--out', outPath],
  child: {
    exitCode: child.status,
    signal: child.signal,
    error: child.error ? String(child.error.message || child.error) : null,
    stderrTail: stderr.slice(-4000),
  },
  ...(childReport || {
    status: eventLoopBlocked ? 'blocked' : 'failed',
    nativeSurface: false,
    gpuSurface: false,
    presentedFrame: false,
    reason: eventLoopBlocked
      ? 'No usable desktop display/event loop was available for the native window smoke.'
      : 'The desktop surface child did not emit a structured report.',
  }),
}
// The child already writes the report, but the wrapper adds commit and host
// context and atomically replaces it with the complete evidence document.
writeAtomic(outPath, report)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

if (report.status === 'passed') process.exitCode = 0
else if (report.status === 'blocked' && allowBlocked) process.exitCode = 0
else process.exitCode = 1
