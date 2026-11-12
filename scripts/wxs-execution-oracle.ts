// Development-only observation runner. No official artifact enters the runtime.
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { normalizeDatatypeObservation } from './wxs-datatype-observations.mjs'

const baseline = { ide: '2.02.2608080', sdk: '3.17.3', renderer: 'webview' }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(root, 'conformance/fixtures/wxs-execution-oracle')
const officialSource = 'https://devtools.wxqcloud.qq.com.cn/WechatWebDev/nightly/versions/config.json'
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const errorText = (error: unknown) => error instanceof Error ? error.stack || error.message : String(error)

async function hashes(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    const name = prefix + entry.name
    if (entry.isDirectory()) Object.assign(result, await hashes(file, name + '/'))
    else if (entry.isFile()) result[name] = digest(await readFile(file))
    else throw new Error('Fixture/project contains an unsupported filesystem entry: ' + name)
  }
  return result
}

function options(args: string[]) {
  const result = { run: false, out: '', cli: process.env.WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH || '/Applications/wechatwebdevtools.app/Contents/MacOS/cli' }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--run') result.run = true
    else if (arg === '--help' || arg === '-h') result.run = false
    else if (arg === '--out' || arg === '--cli') {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(arg + ' requires a value')
      result[arg === '--out' ? 'out' : 'cli'] = value
    }
    else throw new Error('Unknown option: ' + arg)
  }
  return result
}

async function runOracle(config: ReturnType<typeof options>) {
  // Imports of launch/selection machinery are inside the explicit --run boundary.
  const { withMachineE2ELease } = await import('../vendor/weapp-vite/packages/devtools-runtime/src/lease/machine')
  const { launchAutomator } = await import('../vendor/weapp-vite/e2e/utils/automator')
  const { selectWechatE2EInstallation } = await import('../vendor/weapp-vite/e2e/utils/devtoolsCli')
  const { claimDevtoolsHost, inspectDevtoolsHost, quitClaimedDevtoolsHost } = await import('../vendor/weapp-vite/e2e/utils/devtoolsHostLifecycle')
  const { cleanupOwnedDevtoolsProcesses, createDevtoolsProjectJournal } = await import('../vendor/weapp-vite/e2e/utils/devtoolsProcessOwnership')
  const { MANAGED_PROJECT_JOURNAL_ENV, readManagedWechatProjectRecords } = await import('../vendor/weapp-vite/packages/weapp-ide-cli/src/devtoolsProjectOwnership')
  const out = path.resolve(config.out || path.join(root, 'artifacts/wxs-execution-oracle', new Date().toISOString().replaceAll(/[:.]/g, '-')))
  const project = path.join(out, 'project')
  await mkdir(path.dirname(out), { recursive: true })
  await mkdir(out) // Refuse to overwrite another run or reuse its resource evidence.
  const save = async (name: string, value: unknown) => writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n')
  const report: Record<string, any> = {
    schemaVersion: 1, scope: 'wxs-execution-observations', status: 'unknown', baseline,
    startedAt: new Date().toISOString(), observations: [], datatypes: { schemaVersion: 1, status: 'unknown', observations: [] }, console: [], exceptions: [], cleanup: { errors: [] },
    limits: [
      'No predeclared official WXS counter, scope, slot, caching, or evaluation-order expectations.',
      'Rendered history bindings may be cached; they are samples rather than a complete WXS call trace.',
      'The initial capture is the first available stable frame after onReady, not a pre-onLoad screenshot.',
      'Console/exception listeners start after automator launch; fixture App hooks retain early AppService errors.',
      'Configured renderer does not prove actual renderer; GPU/device/seven-host parity is not evaluated.',
      'Datatype values are observations, not predeclared expectations. Two reported errors do not prove equivalent errors.',
    ],
  }
  const previousEnvironment = new Map<string, string | undefined>()
  function setEnvironment(key: string, value: string) {
    if (!previousEnvironment.has(key)) previousEnvironment.set(key, process.env[key])
    process.env[key] = value
  }
  let machineLease: { released: boolean } | undefined
  let wxssOriginal: Buffer | undefined
  let wxssFile: string | undefined
  let baselineVerified = false
  let capturesComplete = true
  try {
    await withMachineE2ELease(async lease => {
      machineLease = lease
      report.machineLease = { borrowed: lease.borrowed }
      const response = await fetch(officialSource, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error('Official version query failed: HTTP ' + response.status)
      const versionBytes = await response.text()
      const versions = JSON.parse(versionBytes)
      const stable = versions.channels?.find((channel: any) => channel.id === 'stable')
      if (typeof stable?.version !== 'string') throw new Error('Official response did not identify the stable channel')
      await writeFile(path.join(out, 'official-versions.json'), versionBytes)
      report.officialSelection = {
        source: officialSource, queriedAt: new Date().toISOString(), responseSha256: digest(versionBytes),
        latestStable: stable.version, selectedVersion: baseline.ide,
        fixedVersionException: stable.version === baseline.ide ? null : 'User-selected semantic baseline is retained; latest stable is recorded only.',
      }
      for (const [key, value] of Object.entries({
        WEAPP_VITE_E2E_RUNTIME_PROVIDER: 'devtools', WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH: config.cli,
        WEAPP_VITE_E2E_DEVTOOLS_CHANNEL: 'stable', WEAPP_VITE_E2E_DEVTOOLS_VERSION: baseline.ide,
        WEAPP_VITE_E2E_ACCEPTED_DEVTOOLS_CHANNEL: 'stable', WEAPP_VITE_E2E_ACCEPTED_DEVTOOLS_VERSION: baseline.ide,
      })) setEnvironment(key, value)
      const installation = await selectWechatE2EInstallation()
      report.selectedInstallation = {
        version: installation.version, channel: installation.channel, installationId: installation.installationId,
        cliPath: installation.cliPath, appPath: installation.appPath,
      }
      if (installation.version !== baseline.ide || installation.channel !== 'stable') throw new Error('Selected IDE/channel differs from the fixed baseline')
      let host: Awaited<ReturnType<typeof claimDevtoolsHost>> | undefined
      let journal: string | undefined
      let miniProgram: any
      let bodyFailure: unknown
      try {
        // Cold-only claim refuses any manual, foreign or unknown host before launch.
        host = await claimDevtoolsHost(installation.cliPath)
        report.hostBefore = host.initial
        if (host.target.installationId !== installation.installationId || host.target.version !== baseline.ide || host.target.channel !== 'stable') {
          throw new Error('Claimed host differs from the selected installation')
        }
        journal = await createDevtoolsProjectJournal()
        setEnvironment(MANAGED_PROJECT_JOURNAL_ENV, journal)
        report.journalPath = journal
        report.fixtureSha256 = await hashes(fixture)
        report.fixtureRootSha256 = digest(JSON.stringify(report.fixtureSha256))
        await cp(path.join(fixture, 'raw'), project, { recursive: true, errorOnExist: true, force: false })
        const appidSource = path.join(root, 'vendor/weapp-vite/e2e-apps/github-issues/project.config.json')
        const upstream = JSON.parse(await readFile(appidSource, 'utf8'))
        const appid = process.env.WEAPP_CONTAINER_ORACLE_APPID || upstream.appid
        if (typeof appid !== 'string' || !appid.trim() || appid === 'touristappid') throw new Error('An existing real E2E AppID is required')
        report.appid = { source: process.env.WEAPP_CONTAINER_ORACLE_APPID ? 'WEAPP_CONTAINER_ORACLE_APPID' : path.relative(root, appidSource), sha256: digest(appid) }
        await writeFile(path.join(project, 'project.config.json'), JSON.stringify({
          appid, projectname: 'Weapp Container WXS execution oracle', compileType: 'miniprogram', miniprogramRoot: './',
          libVersion: baseline.sdk, setting: { urlCheck: false, es6: true, minified: false, enhance: true, compileHotReLoad: true },
        }, null, 2) + '\n')
        await writeFile(path.join(project, 'project.private.config.json'), JSON.stringify({
          projectname: 'Weapp Container WXS execution oracle',
          condition: { miniprogram: { list: [
            { id: 0, name: 'WXS oracle', pathName: 'pages/index/index', query: '', scene: null },
            { id: 1, name: 'WXS datatypes', pathName: 'pages/datatypes/index', query: 'caseId=constructors', scene: null },
          ] } },
        }, null, 2) + '\n')
        report.effectiveProjectBeforeSha256 = await hashes(project)
        await save('launch.json', report)
        miniProgram = await launchAutomator({
          projectPath: project, cliPath: installation.cliPath, timeout: 90_000, maxLaunchRetries: 1,
          bridgeProjectMode: 'direct', trustProject: true, projectConfig: { libVersion: baseline.sdk },
          warmupRoute: '/pages/index/index', warmupRootSelectors: ['#snapshot-ready'],
          onSessionMetadata: async metadata => { report.sessionMetadata = metadata; await save('session.json', metadata) },
        })
        report.consoleCaptureStartedAt = new Date().toISOString()
        miniProgram.on('console', (entry: unknown) => report.console.push({ capturedAt: new Date().toISOString(), entry }))
        miniProgram.on('exception', (entry: unknown) => report.exceptions.push({ capturedAt: new Date().toISOString(), entry }))
        const toolInfo = await miniProgram.toolInfo()
        report.actualRuntime = { toolInfo, installationId: installation.installationId, actualRenderer: toolInfo.renderer ?? null }
        if (toolInfo.version !== baseline.ide) throw new Error('Connected IDE differs from the fixed baseline')
        if (toolInfo.SDKVersion !== baseline.sdk) throw new Error('Connected Tool SDK differs from the fixed baseline')

        const selectors = [
          '#snapshot-ready', '#page-headline', '#inline-literal', '#style-value', '#branch-true', '#branch-false',
          '#row-a', '#row-b', '#row-c', '#import-headline', '#import-history', '#include-headline', '#include-history',
          '#nested-headline', '#nested-history', '#light-header', '#light-default', '#light-unused', '#light-header-only',
          '#light-without-slot', '#page-history',
        ]
        const shells = ['#shell-supplied', '#shell-fallback', '#shell-header-only', '#shell-no-slot']
        async function currentPage() {
          const page = await miniProgram.currentPage()
          if (!page || page.path !== 'pages/index/index') throw new Error('Oracle left its owned fixture route')
          await page.waitFor('#snapshot-ready')
          return page
        }
        async function capture(id: string, action: unknown) {
          const observation: Record<string, any> = { id, status: 'unknown', action, capturedAt: new Date().toISOString(), text: [], queryErrors: [] }
          report.observations.push(observation)
          try {
            const page = await currentPage()
            observation.snapshot = await page.callMethod('snapshot')
            if (observation.snapshot.environment.SDKVersion !== baseline.sdk) throw new Error('Fixture SDK differs from the fixed baseline')
            if (observation.snapshot.phase !== 'ready') throw new Error('Fixture onReady has not completed')
            if (observation.snapshot.lifecycle.some((item: any) => ['app.onError', 'app.onUnhandledRejection'].includes(item.entry?.hook))) {
              throw new Error('Fixture recorded an AppService runtime error')
            }
            for (const selector of [...selectors, ...shells.flatMap(shell => ['.component-headline', '.component-history', '.fallback-header', '.fallback-default'].map(child => shell + ' >>> ' + child))]) {
              try {
                const element = await page.$(selector)
                observation.text.push({ selector, present: Boolean(element), text: element ? await element.text() : null })
              }
              catch (error) { observation.queryErrors.push({ selector, error: errorText(error) }) }
            }
            const headline = observation.text.find((item: any) => item.selector === '#page-headline')
            if (!headline?.present) throw new Error('Essential fixture headline was not queryable')
            observation.layout = await page.callMethod('sampleLayout')
            observation.actualRenderer = observation.snapshot.environment.renderer ?? null
            observation.screenshot = id + '.png'
            await miniProgram.screenshot({ path: path.join(out, observation.screenshot) })
            observation.status = observation.queryErrors.length ? 'blocked' : 'observed'
          }
          catch (error) { observation.status = 'blocked'; observation.error = errorText(error) }
          if (observation.status !== 'observed') capturesComplete = false
          await save(id + '.json', observation)
          await writeFile(path.join(out, id + '.txt'), observation.text.map((item: any) => item.selector + '\t' + (item.present ? item.text : '[absent]')).join('\n') + '\n')
          return observation
        }
        const initial = await capture('initial-first-stable', { kind: 'capture' })
        if (initial.status !== 'observed') throw new Error('Initial fixture capture did not complete; preserve its diagnostics')
        baselineVerified = true
        report.baselineVerifiedAt = new Date().toISOString()
        const scenarios = JSON.parse(await readFile(path.join(fixture, 'scenarios.json'), 'utf8'))
        for (const step of scenarios.steps.filter((step: any) => step.kind === 'patch')) {
          try {
            const page = await currentPage()
            const result = await page.callMethod('applyStep', step.id)
            await capture(step.id, { kind: 'patch', result })
          }
          catch (error) {
            capturesComplete = false
            report.observations.push({ id: step.id, status: 'blocked', error: errorText(error) })
          }
        }
        await miniProgram.reLaunch('/pages/index/index')
        await capture('relaunch', { kind: 'relaunch' })
        wxssFile = path.join(project, 'pages/index/index.wxss')
        wxssOriginal = await readFile(wxssFile)
        const modified = wxssOriginal.toString('utf8').replace('border-left-width: 1px; /* oracle-wxss-border */', 'border-left-width: 7px; /* oracle-wxss-border */')
        if (modified === wxssOriginal.toString('utf8')) throw new Error('Controlled WXSS edit marker is missing')
        const beforeStyle = await (await currentPage()).callMethod('sampleLayout')
        report.wxssEdit = { beforeSha256: digest(wxssOriginal), afterSha256: digest(modified), beforeStyle, requestedBorderWidth: '7px', delivered: false }
        if (!beforeStyle || beforeStyle['border-left-width'] === '7px') throw new Error('Initial computed style cannot establish WXSS delivery')
        await writeFile(wxssFile, modified)
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          try {
            const layout = await (await currentPage()).callMethod('sampleLayout')
            report.wxssEdit.lastLayout = layout
            if (layout?.['border-left-width'] === '7px') { report.wxssEdit.delivered = true; break }
          }
          catch (error) { report.wxssEdit.lastPollError = errorText(error) }
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        const edited = await capture('wxss-file-edit', { kind: 'file-edit', ...report.wxssEdit })
        if (!report.wxssEdit.delivered) {
          capturesComplete = false
          edited.status = 'blocked'
          edited.error = 'The controlled WXSS edit was not confirmed in computed style; no compile fallback was used.'
          await save('wxss-file-edit.json', edited)
        }
        // Preserve the old execution/slot/counter suite's exception gate.
        // Datatype error-boundary probes run afterwards and retain their own
        // case-local diagnostics rather than pretending expected failures pass.
        if (report.exceptions.length) capturesComplete = false
        const datatypeCases = JSON.parse(await readFile(path.join(fixture, 'datatype-cases.json'), 'utf8'))
        report.datatypes.fixtureCases = datatypeCases
        for (const testCase of datatypeCases.cases) {
          const observation: Record<string, any> = { caseId: testCase.id, kind: testCase.kind,
            status: 'unknown', capturedAt: new Date().toISOString(), queryErrors: [] }
          report.datatypes.observations.push(observation)
          const exceptionOffset = report.exceptions.length
          const consoleOffset = report.console.length
          let lifecycleOffset = 0
          try {
            const previousPage = await miniProgram.currentPage()
            const previousSnapshot = await previousPage?.callMethod('snapshot')
            if (!Array.isArray(previousSnapshot?.lifecycle)) throw new Error('Cannot establish case-local App error boundary')
            lifecycleOffset = previousSnapshot.lifecycle.length
            // Each case gets a fresh page/View scope, including invalid regex
            // probes. Reuse the same automator and machine lease throughout.
            await miniProgram.reLaunch('/' + datatypeCases.route + '?caseId=' + encodeURIComponent(testCase.id))
            const page = await miniProgram.currentPage()
            if (!page || page.path !== datatypeCases.route) throw new Error('Datatype oracle left its owned fixture route')
            observation.snapshot = await page.callMethod('snapshot')
            if (observation.snapshot.environment.SDKVersion !== baseline.sdk) throw new Error('Datatype fixture SDK differs from baseline')
            if (observation.snapshot.phase !== 'ready' || observation.snapshot.caseId !== testCase.id) throw new Error('Datatype page is not ready for the requested case')
            const deadline = Date.now() + 5_000
            while (Date.now() < deadline) {
              try {
                observation.selector = await page.callMethod('sampleDatatype')
                if (observation.selector?.dataset?.case === testCase.id && typeof observation.selector.dataset.value === 'string') break
              }
              catch (error) { observation.queryErrors.push(errorText(error)); break }
              if (report.exceptions.length > exceptionOffset) break
              await new Promise(resolve => setTimeout(resolve, 100))
            }
            observation.snapshot = await page.callMethod('snapshot')
          }
          catch (error) { observation.transportError = errorText(error) }
          observation.exceptions = report.exceptions.slice(exceptionOffset)
          observation.console = report.console.slice(consoleOffset)
          observation.appErrors = (observation.snapshot?.lifecycle || []).slice(lifecycleOffset)
            .filter((item: any) => ['app.onError', 'app.onUnhandledRejection'].includes(item.entry?.hook))
          observation.normalized = normalizeDatatypeObservation(testCase.id, {
            dataset: observation.selector?.dataset,
            errors: [...observation.exceptions, ...observation.appErrors],
          })
          observation.status = !observation.transportError && observation.normalized.outcome !== 'unresolved' ? 'observed' : 'blocked'
          await save('datatype-' + testCase.id + '.json', observation)
        }
        report.datatypes.status = report.datatypes.observations.every((item: any) => item.status === 'observed') ? 'observed' : 'blocked'
        if (report.datatypes.status !== 'observed') capturesComplete = false
        report.status = baselineVerified && capturesComplete ? 'observed' : 'blocked'
      }
      catch (error) { bodyFailure = error; throw error }
      finally {
        // Every step after host claim shares this disposer, including copy/config failures.
        const cleanup = async (name: string, operation: () => Promise<unknown>) => {
          try { await operation(); report.cleanup[name] = true }
          catch (error) { report.cleanup.errors.push({ operation: name, error: errorText(error) }) }
        }
        if (wxssFile && wxssOriginal) await cleanup('wxssRestored', async () => {
          await writeFile(wxssFile!, wxssOriginal!)
          report.wxssRestoredSha256 = digest(await readFile(wxssFile!))
        })
        if (miniProgram) await cleanup('automatorDisconnected', () => miniProgram.disconnect())
        if (journal) await cleanup('ownedProjectsReleased', () => cleanupOwnedDevtoolsProcesses({ journalPath: journal }))
        if (host) {
          await cleanup('claimedHostExited', () => quitClaimedDevtoolsHost(host!))
          await cleanup('hostInspected', async () => {
            report.hostAfter = await inspectDevtoolsHost(host!.target)
            if (report.hostAfter.state !== 'cold') throw new Error('Claimed host is not cold after cleanup; resources remain recorded')
          })
        }
        if (journal) await cleanup('projectRecordsRead', async () => { report.projectRecords = await readManagedWechatProjectRecords(journal) })
        await cleanup('effectiveProjectHashed', async () => { if (wxssFile) report.effectiveProjectAfterSha256 = await hashes(project) })
        if (report.cleanup.errors.length) {
          report.status = 'cleanup-failed'
          throw new AggregateError([...(bodyFailure ? [bodyFailure] : []), ...report.cleanup.errors.map((item: any) => new Error(item.operation + ': ' + item.error))], 'Oracle cleanup incomplete; preserve ownership evidence')
        }
      }
    })
  }
  catch (error) {
    if (report.status !== 'cleanup-failed') report.status = 'blocked'
    report.error = errorText(error)
  }
  finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    report.cleanup.environmentRestored = true
    report.cleanup.machineLeaseReleased = machineLease?.released === true
    if (machineLease && !machineLease.released) report.status = 'cleanup-failed'
    report.finishedAt = new Date().toISOString()
    await save('report.json', report)
    process.stdout.write(JSON.stringify({ status: report.status, baselineVerified, report: path.join(out, 'report.json'), cleanup: report.cleanup }) + '\n')
  }
  if (report.status !== 'observed') process.exitCode = 1
}

try {
  const config = options(process.argv.slice(2))
  if (!config.run) {
    process.stdout.write(JSON.stringify({
      status: 'unknown', baseline, ranOfficialOracle: false,
      usage: 'node --import ./vendor/weapp-vite/node_modules/tsx/dist/loader.mjs scripts/wxs-execution-oracle.ts --run [--out NEW_DIRECTORY] [--cli CLI_PATH]',
      fixture, boundary: 'Without --run no tooling is queried, launched, connected, or closed. No official WXS behavior is asserted.',
    }) + '\n')
  }
  else await runOracle(config)
}
catch (error) {
  process.stderr.write(errorText(error) + '\n')
  process.exitCode = 1
}
