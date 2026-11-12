// Development-only oracle. Official tooling and fixture bytes never enter the runtime.
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { withMachineE2ELease } from '../vendor/weapp-vite/packages/devtools-runtime/src/lease/machine'
import { launchAutomator } from '../vendor/weapp-vite/e2e/utils/automator'
import { selectWechatE2EInstallation } from '../vendor/weapp-vite/e2e/utils/devtoolsCli'
import { claimDevtoolsHost, inspectDevtoolsHost, quitClaimedDevtoolsHost } from '../vendor/weapp-vite/e2e/utils/devtoolsHostLifecycle'
import { cleanupOwnedDevtoolsProcesses, createDevtoolsProjectJournal } from '../vendor/weapp-vite/e2e/utils/devtoolsProcessOwnership'
import { MANAGED_PROJECT_JOURNAL_ENV, readManagedWechatProjectRecords } from '../vendor/weapp-vite/packages/weapp-ide-cli/src/devtoolsProjectOwnership'

const root = path.resolve(import.meta.dirname, '..')
const out = path.resolve(process.argv[2] || path.join(root, 'artifacts/component-selection-oracle', new Date().toISOString().replaceAll(/[:.]/g, '-')))
const fixture = path.join(root, 'conformance/fixtures/component-selection')
const project = path.join(out, 'project')
const cliPath = process.env.WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH || '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const report: Record<string, any> = {
  schemaVersion: 1, scope: 'native-component-selection-probe', status: 'unknown',
  startedAt: new Date().toISOString(), baseline: { ide: '2.02.2608080', sdk: '3.17.3', renderer: 'webview' },
  observations: {}, cleanup: {},
  boundary: 'Observations for this fixture only; no promotion of unrelated official cases, GPU, devices or seven-host gates.',
}

async function hashes(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(result, await hashes(file, name + '/'))
    else result[name] = createHash('sha256').update(await readFile(file)).digest('hex')
  }
  return result
}

await mkdir(out, { recursive: true })
let machineLease: { released: boolean } | undefined
try {
  await withMachineE2ELease(async (lease) => {
    machineLease = lease
    report.machineLease = { borrowed: lease.borrowed }
    const officialSource = 'https://devtools.wxqcloud.qq.com.cn/WechatWebDev/nightly/versions/config.json'
    const versions = await (await fetch(officialSource, { signal: AbortSignal.timeout(20_000) })).json() as any
    const stable = versions.channels.find((channel: any) => channel.id === 'stable')
    report.officialSelection = { queriedAt: new Date().toISOString(), source: officialSource, latestStable: stable?.version, explicitlyFixedVersion: '2.02.2608080' }
    Object.assign(process.env, {
      WEAPP_VITE_E2E_RUNTIME_PROVIDER: 'devtools', WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH: cliPath,
      WEAPP_VITE_E2E_DEVTOOLS_CHANNEL: 'stable', WEAPP_VITE_E2E_DEVTOOLS_VERSION: '2.02.2608080',
      WEAPP_VITE_E2E_ACCEPTED_DEVTOOLS_CHANNEL: 'stable', WEAPP_VITE_E2E_ACCEPTED_DEVTOOLS_VERSION: '2.02.2608080',
    })
    // Resolve the E2E version policy before taking host ownership. A CLI path
    // alone does not apply WEAPP_VITE_E2E_* version/channel constraints.
    const installation = await selectWechatE2EInstallation()
    report.actualInstallation = {
      version: installation.version, channel: installation.channel,
      installationId: installation.installationId, cliPath: installation.cliPath,
      appPath: installation.appPath,
    }
    if (installation.version !== '2.02.2608080' || installation.channel !== 'stable') {
      throw new Error('Selected installation differs from the fixed IDE/channel baseline')
    }
    // A cold-host claim is required before this probe may launch or quit the IDE.
    // Existing manual, foreign and unknown hosts are preserved by this helper.
    const host = await claimDevtoolsHost(installation.cliPath)
    if (host.target.installationId !== installation.installationId
      || host.target.version !== '2.02.2608080' || host.target.channel !== 'stable') {
      throw new Error('Claimed host installation differs from the selected fixed baseline')
    }
    report.hostBefore = host.initial
    const journal = await createDevtoolsProjectJournal()
    process.env[MANAGED_PROJECT_JOURNAL_ENV] = journal
    report.journalPath = journal
    report.fixtureSha256 = await hashes(fixture)
    await cp(fixture, project, { recursive: true, errorOnExist: true, force: false })
    const configured = JSON.parse(await readFile(path.join(root, 'vendor/weapp-vite/e2e-apps/github-issues/project.config.json'), 'utf8'))
    const appid = process.env.WEAPP_CONTAINER_ORACLE_APPID || configured.appid
    if (!appid || appid === 'touristappid') throw new Error('A configured real test AppID is required')
    await writeFile(path.join(project, 'project.config.json'), JSON.stringify({
      appid, projectname: 'Weapp Container component selection oracle', compileType: 'miniprogram',
      miniprogramRoot: './', libVersion: '3.17.3',
      setting: { urlCheck: false, es6: true, minified: false, enhance: true },
    }, null, 2) + '\n')
    let miniProgram: any
    const cleanupErrors: string[] = []
    try {
      await writeFile(path.join(out, 'launch.json'), JSON.stringify(report, null, 2) + '\n')
      miniProgram = await launchAutomator({
        projectPath: project, cliPath: installation.cliPath, timeout: 90_000, maxLaunchRetries: 1,
        bridgeProjectMode: 'direct', trustProject: true, projectConfig: { libVersion: '3.17.3' },
        warmupRoute: '/pages/index/index', warmupRootSelectors: ['#snapshot-ready'],
      })
      const toolInfo = await miniProgram.toolInfo()
      report.actualRuntime = {
        version: toolInfo.version ?? null, SDKVersion: toolInfo.SDKVersion ?? null,
        installationId: installation.installationId,
      }
      if (toolInfo.version !== '2.02.2608080') throw new Error('Connected IDE differs from the fixed baseline')
      if (toolInfo.SDKVersion !== '3.17.3') throw new Error('Connected Tool SDK differs from the fixed baseline')
      const page = await miniProgram.currentPage()
      if (!page || page.path !== 'pages/index/index') throw new Error('Oracle did not reach its owned fixture route')
      report.route = page.path
      await page.waitFor('#snapshot-ready')
      report.observations.initial = await page.callMethod('snapshot')
      if (report.observations.initial.phase !== 'ready') throw new Error('Oracle page onReady has not completed')
      if (report.observations.initial.environment.SDKVersion !== '3.17.3') throw new Error('Connected SDK differs from the fixed baseline')
      report.status = 'observed'
    }
    catch (error) {
      report.status = 'blocked'
      report.error = error instanceof Error ? error.stack : String(error)
      throw error
    }
    finally {
      if (miniProgram) {
        try { await miniProgram.disconnect(); report.cleanup.automatorDisconnected = true }
        catch (error) { cleanupErrors.push(String(error)) }
      }
      try { await cleanupOwnedDevtoolsProcesses({ journalPath: journal }); report.cleanup.ownedProjectsReleased = true }
      catch (error) { cleanupErrors.push(String(error)) }
      try { await quitClaimedDevtoolsHost(host); report.cleanup.claimedHostExited = true }
      catch (error) { cleanupErrors.push(String(error)) }
      report.hostAfter = await inspectDevtoolsHost(host.target)
      report.projectRecords = await readManagedWechatProjectRecords(journal)
      report.cleanup.errors = cleanupErrors
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Oracle cleanup failed; preserve resource evidence')
    }
  })
}
catch (error) {
  report.status = report.status === 'observed' ? 'cleanup-failed' : 'blocked'
  report.error ??= error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
}
finally {
  report.finishedAt = new Date().toISOString()
  report.cleanup.machineLeaseReleased = machineLease?.released === true
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ status: report.status, report: path.join(out, 'report.json'), observations: report.observations, cleanup: report.cleanup }) + '\n')
}
