#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { compatibilityMetadata, inspectProject } from './devtools-compatibility.mjs'
import { checkForUpdate } from './lib/devtools-update.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runFile = promisify(execFile)
const limitLogLines = 120

export function simulatorArguments(project, surface) {
  if (!['web', 'desktop'].includes(surface)) throw new Error('请选择 Web Player 或 Desktop Player')
  return ['dev', '--project', project, '--surface', surface]
}

async function chooseProjectDirectory(platform = process.platform) {
  if (platform === 'darwin') {
    const { stdout } = await runFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择小程序项目目录")'])
    return stdout.trim()
  }
  if (platform === 'win32') {
    const command = 'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($d.SelectedPath) }'
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-STA', '-Command', command], { windowsHide: true })
    return stdout.trim()
  }
  const { stdout } = await runFile('zenity', ['--file-selection', '--directory', '--title=选择小程序项目目录'])
  return stdout.trim()
}

export async function validateProject(value, options = {}) {
  return (await inspectProject(value, options)).project
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

async function readJson(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 16 * 1024) throw new Error('请求内容超出限制')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function nativePickerError(error) {
  return error.code === 1 || error.code === 255 || /User canceled|(-128)/i.test(error.message)
}

export async function createLauncher({
  installRoot = root,
  openBrowser = url => {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', () => {})
    child.unref()
  },
  chooseProject = chooseProjectDirectory,
  spawnProcess = spawn,
} = {}) {
  let metadata = compatibilityMetadata()
  try {
    const packagedMetadata = JSON.parse(await readFile(join(installRoot, 'weapp-devtools.json'), 'utf8'))
    if (!packagedMetadata || packagedMetadata.schemaVersion !== 1
      || packagedMetadata.name !== 'weapp-container-devtools'
      || typeof packagedMetadata.version !== 'string'
      || typeof packagedMetadata.target !== 'string'
      || typeof packagedMetadata.weappViteCommit !== 'string') {
      throw new Error('DevTools 安装元数据无效，请重新安装发行包')
    }
    metadata = { ...metadata, ...packagedMetadata }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const token = randomBytes(32).toString('hex')
  const logs = []
  let child
  let surface
  let project
  let previewUrl
  let exitCode
  let stopping = false
  let preflight
  const addLog = line => {
    const value = String(line).slice(0, 2048)
    logs.push(value)
    if (logs.length > limitLogLines) logs.splice(0, logs.length - limitLogLines)
    const match = value.match(/weapp-simulator: web surface (http:\/\/127\.0\.0\.1:\d+)/)
    if (match) previewUrl = match[1]
  }
  const server = createServer(async (request, response) => {
    try {
      const address = server.address()
      const expectedHost = `127.0.0.1:${address.port}`
      if (request.headers.host !== expectedHost) return sendJson(response, 403, { error: 'Host rejected' })
      const url = new URL(request.url ?? '/', `http://${expectedHost}`)
      if (url.pathname === '/' && request.method === 'GET') {
        const html = await readFile(join(installRoot, 'scripts/devtools-launcher.html'))
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': html.length,
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        })
        return response.end(html)
      }
      const supplied = Buffer.from(String(request.headers.authorization ?? '').replace(/^Bearer /, ''))
      const expected = Buffer.from(token)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return sendJson(response, 403, { error: 'Session expired' })
      }
      const origin = request.headers.origin
      if (origin && origin !== `http://${expectedHost}`) return sendJson(response, 403, { error: 'Origin rejected' })
      if (url.pathname === '/api/status' && request.method === 'GET') {
        const running = child && child.exitCode === null && child.signalCode === null
        return sendJson(response, 200, {
          running: Boolean(running), stopping, project, surface, previewUrl,
          exitCode, logs: [...logs], preflight, metadata,
        })
      }
      if (url.pathname === '/api/browse' && request.method === 'POST') {
        try {
          const selected = await chooseProject()
          return sendJson(response, 200, { project: selected || null })
        } catch (error) {
          if (nativePickerError(error)) return sendJson(response, 200, { project: null })
          return sendJson(response, 500, { error: `目录选择器启动失败：${error.message}` })
        }
      }
      if (url.pathname === '/api/preflight' && request.method === 'POST') {
        const input = await readJson(request)
        preflight = await inspectProject(input.project, { metadata })
        return sendJson(response, 200, preflight)
      }
      if (url.pathname === '/api/update/check' && request.method === 'GET') {
        try {
          return sendJson(response, 200, await checkForUpdate({ metadata }))
        } catch (error) {
          return sendJson(response, 200, { status: 'unavailable', error: error.message })
        }
      }
      if (url.pathname === '/api/start' && request.method === 'POST') {
        if (child && child.exitCode === null && child.signalCode === null) return sendJson(response, 409, { error: 'Player 已在运行' })
        const input = await readJson(request)
        preflight = await inspectProject(input.project, { metadata, requireDependencies: true })
        project = preflight.project
        surface = input.surface
        const args = simulatorArguments(project, surface)
        previewUrl = undefined
        exitCode = undefined
        stopping = false
        const executable = join(installRoot, 'bin', process.platform === 'win32' ? 'weapp-simulator.exe' : 'weapp-simulator')
        await access(executable, constants.X_OK).catch(async error => {
          if (process.platform !== 'win32') throw error
          await access(executable, constants.R_OK)
        })
        const nodeBin = process.platform === 'win32' ? join(installRoot, 'node') : join(installRoot, 'node', 'bin')
        const env = {
          ...process.env,
          PATH: `${join(installRoot, 'bin')}${delimiter}${nodeBin}${delimiter}${process.env.PATH ?? ''}`,
          COREPACK_ENABLE_AUTO_PIN: '0',
          COREPACK_HOME: join(process.env.LOCALAPPDATA || join(homedir(), '.cache'), 'weapp-devtools', 'corepack'),
        }
        child = spawnProcess(executable, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: surface === 'web' })
        for (const stream of [child.stdout, child.stderr]) {
          let buffered = ''
          stream.setEncoding('utf8')
          stream.on('data', data => {
            buffered += data
            const lines = buffered.split(/\r?\n/)
            buffered = lines.pop() ?? ''
            for (const line of lines) if (line) addLog(line)
            if (buffered.length > 2048) {
              addLog(buffered)
              buffered = ''
            }
          })
          stream.on('end', () => { if (buffered) addLog(buffered) })
        }
        child.once('error', error => addLog(`启动失败：${error.message}`))
        child.once('exit', (code, signal) => {
          exitCode = code ?? signal
          stopping = false
          if (child?.exitCode !== null || child?.signalCode !== null) child = undefined
        })
        return sendJson(response, 202, { running: true, project, surface })
      }
      if (url.pathname === '/api/stop' && request.method === 'POST') {
        if (!child || child.exitCode !== null || child.signalCode !== null) return sendJson(response, 200, { running: false })
        stopping = true
        const owned = child
        await stopChild(owned)
        return sendJson(response, 200, { running: false })
      }
      sendJson(response, 404, { error: 'Not found' })
    } catch (error) {
      sendJson(response, 400, { error: error.message })
    }
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const { port } = server.address()
  const page = `http://127.0.0.1:${port}/#session=${token}`
  openBrowser(page)
  return {
    page,
    async close() {
      if (child && child.exitCode === null && child.signalCode === null) {
        stopping = true
        await stopChild(child)
      }
      await new Promise(resolveClose => server.close(resolveClose))
    },
  }
}

function stopChild(owned) {
  if (owned.exitCode !== null || owned.signalCode !== null) return Promise.resolve()
  return new Promise(resolveExit => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      owned.off('exit', finish)
      resolveExit()
    }
    const timer = setTimeout(() => {
      if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL')
      finish()
    }, 12_000)
    timer.unref()
    owned.once('exit', finish)
    owned.kill('SIGINT')
  })
}

async function runDirect(arguments_) {
  const executable = join(root, 'bin', process.platform === 'win32' ? 'weapp-simulator.exe' : 'weapp-simulator')
  const nodeBin = process.platform === 'win32' ? join(root, 'node') : join(root, 'node', 'bin')
  const child = spawn(executable, arguments_, {
    stdio: 'inherit',
    env: { ...process.env, PATH: `${join(root, 'bin')}${delimiter}${nodeBin}${delimiter}${process.env.PATH ?? ''}` },
  })
  const forward = signal => child.kill(signal)
  process.once('SIGINT', forward)
  process.once('SIGTERM', forward)
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (status, signal) => resolveExit(status ?? (signal ? 1 : 0)))
  })
  process.off('SIGINT', forward)
  process.off('SIGTERM', forward)
  process.exitCode = code
}

async function main(arguments_) {
  const command = arguments_[0]
  if (command === '--version' || command === '-v') {
    const metadata = JSON.parse(await readFile(join(root, 'weapp-devtools.json'), 'utf8'))
    process.stdout.write(`${metadata.version}\n`)
    return
  }
  if (command === '--help' || command === '-h') {
    process.stdout.write('Weapp Container DevTools\n\nUsage: weapp-devtools [gui | dev --project <dir> --surface web|desktop]\n')
    return
  }
  if (command === 'dev') return runDirect(arguments_.slice(1))
  if (command && command !== 'gui') throw new Error(`Unknown command: ${command}`)
  const launcher = await createLauncher()
  process.stdout.write(`Weapp Container DevTools: ${launcher.page}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`weapp-devtools: ${error.message}\n`)
    process.exitCode = 1
  })
}
