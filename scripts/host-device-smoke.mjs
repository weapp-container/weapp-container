#!/usr/bin/env node
/**
 * Probe owned Android, iOS and Harmony emulator surfaces without claiming
 * that the container itself has passed a device conformance suite.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const marker = 'weapp-container-host-smoke'
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outPath = outIndex >= 0 ? args[outIndex + 1] : null
const requireAll = args.includes('--require-all')

function commandPath(command) {
  const resolver = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(resolver, [command], { encoding: 'utf8' })
  return result.status === 0 ? (result.stdout || '').trim().split(/\r?\n/)[0] : null
}

function run(command, args) {
  const path = commandPath(command) || command
  const result = spawnSync(path, args, { encoding: 'utf8', timeout: 30_000 })
  return {
    command: [path, ...args].join(' '),
    status: result.error ? 'error' : result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
  }
}

function probeAndroid() {
  const list = run('adb', ['devices'])
  const serial = list.stdout
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    .find(parts => parts[0] && parts[1] === 'device')?.[0]
  if (!serial) return { platform: 'android', status: 'unavailable', probes: [list] }
  const shell = run('adb', ['-s', serial, 'shell', 'echo', marker])
  const version = run('adb', ['-s', serial, 'shell', 'getprop', 'ro.build.version.release'])
  return { platform: 'android', status: shell.status === 'passed' ? 'passed' : shell.status, serial, probes: [list, shell, version] }
}

function probeIos() {
  const devices = run('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'])
  if (devices.status !== 'passed') return { platform: 'ios', status: 'unavailable', probes: [devices] }
  let booted = []
  try {
    booted = Object.values(JSON.parse(devices.stdout).devices || {}).flat().filter(device => device.state === 'Booted')
  } catch {
    return { platform: 'ios', status: 'error', probes: [devices], error: 'simctl JSON was invalid' }
  }
  if (booted.length === 0) return { platform: 'ios', status: 'unavailable', probes: [devices] }
  const shell = run('xcrun', ['simctl', 'spawn', booted[0].udid, '/usr/bin/printf', marker])
  return { platform: 'ios', status: shell.status === 'passed' ? 'passed' : shell.status, udid: booted[0].udid, probes: [devices, shell] }
}

function probeHarmony() {
  const targets = run('hdc', ['list', 'targets'])
  const target = targets.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean)
  if (!target) return { platform: 'harmony', status: 'unavailable', probes: [targets] }
  const shell = run('hdc', ['-t', target, 'shell', 'echo', marker])
  return { platform: 'harmony', status: shell.status === 'passed' ? 'passed' : shell.status, target, probes: [targets, shell] }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: 'device-surface-probe',
  requireAll,
  platforms: [probeAndroid(), probeIos(), probeHarmony()],
  notes: [
    'A passed entry proves only that the selected emulator shell is reachable.',
    'This probe does not load the container, render a manifest, or prove API/device conformance.',
    'Use the platform-specific native host harness after cross-target compilation to produce runtime evidence.',
    '--require-all turns an unavailable or failed platform probe into a non-zero process exit.',
  ],
}
const output = `${JSON.stringify(report, null, 2)}\n`
process.stdout.write(output)
if (outPath) {
  mkdirSync(dirname(resolve(outPath)), { recursive: true })
  writeFileSync(resolve(outPath), output, 'utf8')
}
if (requireAll && report.platforms.some(platform => platform.status !== 'passed')) {
  process.exitCode = 1
}
