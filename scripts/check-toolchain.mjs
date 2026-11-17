#!/usr/bin/env node
/**
 * 检查容器开发所需的基础工具，并把可选移动端 SDK 缺失显示为明确状态。
 * 默认只要求 Rust/Node/Git；--strict 才会将显式声明的 SDK 缺失视为失败。
 */
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const strict = process.argv.includes('--strict')
const json = process.argv.includes('--json')
const outIndex = process.argv.indexOf('--out')
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : null

function probe(command, args = []) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return {
    command,
    available: result.status === 0,
    version: (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null,
    error: result.error?.code || null,
  }
}

function sdkProbe({ name, env, candidates = [], command, args = [], requiredFiles = [], requireCommand = false }) {
  const envPath = process.env[env] || null
  const existingCandidates = candidates.filter((candidate) => candidate && fs.existsSync(candidate))
  const completeCandidate = existingCandidates.find((candidate) =>
    requiredFiles.every((file) => fs.existsSync(path.join(candidate, file))),
  )
  const rootPath = envPath || completeCandidate || existingCandidates[0] || null
  const commandProbe = command ? probe(command, args) : null
  const required = requiredFiles.map((file) => rootPath ? path.join(rootPath, file) : null)
  const filesComplete = required.every((file) => file && fs.existsSync(file))
  const complete = filesComplete && (!requireCommand || commandProbe?.available === true)
  return {
    name,
    env,
    configured: Boolean(envPath),
    // A tool is detected when we found an SDK candidate or its probe command
    // is available.  Checking `path` here would always be truthy because it
    // is the imported node:path module, which made missing SDKs look present.
    detected: Boolean(rootPath || commandProbe?.available),
    path: rootPath,
    complete,
    probe: commandProbe,
  }
}

function rustTargetProbe() {
  const result = spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' })
  const sysroot = (result.stdout || '').trim() || null
  // Homebrew's rustc and rustup may be installed side by side. In that
  // setup `rustc --print sysroot` points at the Homebrew sysroot while Cargo
  // resolves target stdlibs from the rustup toolchain, so checking only the
  // former reports valid cross targets as missing. Ask rustup first and keep
  // the sysroot check as a fallback for standalone Rust installations.
  const rustup = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' })
  const rustupTargets = new Set((rustup.stdout || '').split(/\r?\n/).map((target) => target.trim()).filter(Boolean))
  const targetNames = [
    'aarch64-apple-ios',
    'aarch64-apple-ios-sim',
    'aarch64-linux-android',
    'x86_64-linux-android',
    'aarch64-unknown-linux-ohos',
  ]
  const targets = targetNames.map((target) => ({
    target,
    installed: rustupTargets.has(target)
      || Boolean(sysroot && fs.existsSync(path.join(sysroot, 'lib/rustlib', target))),
  }))
  return { sysroot, targets }
}

const probes = [
  probe('rustc', ['--version']),
  probe('cargo', ['--version']),
  probe('node', ['--version']),
  probe('git', ['--version']),
]
const home = os.homedir()
const optional = [
  {
    name: 'android-sdk',
    env: 'ANDROID_HOME',
    candidates: [process.env.ANDROID_SDK_ROOT, path.join(home, 'Library/Android/sdk')],
    command: path.join(process.env.ANDROID_HOME || path.join(home, 'Library/Android/sdk'), 'platform-tools/adb'),
    args: ['version'],
    requiredFiles: ['platform-tools/adb', 'platforms'],
  },
  {
    name: 'xcode',
    env: 'DEVELOPER_DIR',
    candidates: [process.env.DEVELOPER_DIR, '/Applications/Xcode.app/Contents/Developer'],
    command: 'xcodebuild',
    args: ['-version'],
    requiredFiles: ['Platforms/iPhoneSimulator.platform/Developer/SDKs'],
  },
  {
    name: 'harmony-sdk',
    env: 'HARMONY_HOME',
    candidates: [
      process.env.HARMONY_HOME,
      path.join(home, 'Library/Huawei/Sdk'),
      '/Applications/DevEco-Studio.app/Contents/sdk/default',
    ],
    command: process.env.HDC || 'hdc',
    args: ['version'],
    requiredFiles: ['openharmony/native', 'openharmony/toolchains'],
  },
]
const sdk = optional.map(sdkProbe)
const report = { strict, required: probes, rustTargets: rustTargetProbe(), optional: sdk }

if (json) {
  const output = `${JSON.stringify(report, null, 2)}\n`
  process.stdout.write(output)
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
    fs.writeFileSync(outPath, output, 'utf8')
  }
} else {
  for (const item of probes) process.stdout.write(`${item.available ? 'ok' : 'missing'} ${item.command}${item.version ? ` (${item.version})` : ''}\n`)
  for (const item of sdk) {
    const state = item.complete ? 'ready' : item.detected ? 'detected' : 'missing'
    process.stdout.write(`${state} ${item.name} [${item.env}]${item.path ? ` (${item.path})` : ''}\n`)
  }
}

const requiredMissing = probes.filter((item) => !item.available)
const strictMissing = sdk.filter((item) => !item.complete)
if (requiredMissing.length || (strict && strictMissing.length)) process.exitCode = 1
