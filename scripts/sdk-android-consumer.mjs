#!/usr/bin/env node
// Compile a consumer from a newly installed, pinned SDK archive. Never build
// the Android wrapper, JNI bridge, Maven publication or Rust runtime here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeFixture } from '../sdk/contract/fixtures/make-acceptance-pack.mjs';
import { SDK_RELEASE_VERSION, captureNativeSource } from './lib/sdk-current-release.mjs';
import { installAndroidConsumerArchive, inspectAndroidConsumerPackage, ordinaryFile, prepareAndroidConsumerHarness, sha256, treeRecords, verifyAndroidConsumerDependencies, verifyInstalledAndroidArchive } from './lib/sdk-android-consumer-harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function parse(args) {
  const options = {}, names = { '--manifest': 'manifestPath', '--manifest-sha256': 'manifestSha256', '--artifact-dir': 'artifactDirectory', '--consumer-source': 'sourceRoot', '--out': 'out', '--gradle': 'gradle', '--android-sdk': 'androidSdk' };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--offline') { assert.equal(options.offline, undefined, 'Duplicate --offline'); options.offline = true; continue; }
    assert.ok(names[name] && options[names[name]] === undefined && args[index + 1] && !args[index + 1].startsWith('--'), 'Unknown, duplicate or missing Android consumer option');
    options[names[name]] = args[++index];
  }
  assert.ok(options.manifestPath && options.out, 'Explicit --manifest and never-existing --out directories are required');
  return options;
}
function findGradle() {
  if (process.env.GRADLE) return process.env.GRADLE;
  const directory = resolve(homedir(), '.gradle/wrapper/dists/gradle-8.9-bin');
  if (existsSync(directory)) for (const name of readdirSync(directory).sort()) {
    const bin = resolve(directory, name, 'gradle-8.9/bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle');
    if (existsSync(bin)) return bin;
  }
  return 'gradle';
}
function apkIn(directory) {
  const paths = readdirSync(directory).filter(path => path.endsWith('.apk'));
  assert.equal(paths.length, 1, `Expected one release APK in ${directory}`);
  return resolve(directory, paths[0]);
}

export async function buildAndroidArchiveConsumer(options) {
  const out = resolve(options.out), sourceRoot = resolve(options.sourceRoot ?? resolve(root, 'sdk/android'));
  mkdirSync(dirname(out), { recursive: true }); assert.equal(realpathSync(dirname(out)), dirname(out), 'Use a canonical output parent');
  mkdirSync(out); // Exclusive ownership; never copy or reuse SDK ignored builds.
  const installed = resolve(out, 'installed-sdk'), consumer = resolve(out, 'consumer');
  const sdk = resolve(options.androidSdk ?? process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? resolve(homedir(), 'Library/Android/sdk'));
  const gradle = options.gradle ?? findGradle(), environment = { ...process.env, ANDROID_HOME: sdk };
  const report = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, status: 'building', startedAt: new Date().toISOString(),
    scope: 'New archive installation and independent R8 consumer compilation only; device, host-service and physical hardware acceptance are separate',
    deviceExecution: 'not-run', environment: { platform: process.platform, architecture: process.arch, osRelease: release(), node: process.version, androidSdk: sdk },
    checks: [], consumer, installedSdk: installed, cleanup: { processes: 'not-started', output: 'retained-for-audit' } };
  const save = () => writeFileSync(resolve(out, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  async function run(label, command, args, cwd = out, timeoutMs = 5 * 60_000) {
    const record = { label, command, args, cwd, startedAt: new Date().toISOString(), log: `${report.checks.length + 1}-${label}.log` };
    report.checks.push(record); report.cleanup.processes = 'running'; save();
    console.log(`Android archive consumer: ${label}`);
    const log = openSync(resolve(out, record.log), 'wx');
    try {
      await new Promise((accept, reject) => {
        const child = spawn(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
        let timedOut = false, settled = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
        const finish = (error, exitCode, signal) => {
          if (settled) return; settled = true; clearTimeout(timer);
          Object.assign(record, { exitCode, signal, completedAt: new Date().toISOString(), ...(error ? { error: error.message } : {}), timedOut });
          report.cleanup.processes = 'command-exited'; save();
          error || exitCode !== 0 || timedOut ? reject(Error(`${label} failed; see ${resolve(out, record.log)}`)) : accept();
        };
        child.stdout.on('data', bytes => writeSync(log, bytes)); child.stderr.on('data', bytes => writeSync(log, bytes));
        child.once('error', error => finish(error, null, null)); child.once('close', (code, signal) => finish(null, code, signal));
      });
    } finally { closeSync(log); }
  }
  save();
  try {
    const toolFiles = ['scripts/sdk-android-consumer.mjs', 'scripts/lib/sdk-android-consumer-harness.mjs', 'scripts/lib/sdk-reviewed-sources.mjs', 'scripts/lib/sdk-current-release.mjs', 'scripts/lib/sdk-native-features.mjs', 'scripts/lib/android-archive-consumer.init.gradle', 'scripts/lib/inspect-android-consumer.py', 'sdk/contract/tools/runtime-artifacts.mjs', 'sdk/contract/tools/unpack-runtime.py', 'sdk/contract/fixtures/make-acceptance-pack.mjs'];
    report.tool = { ...captureNativeSource(root), files: toolFiles.map(path => ({ path, sha256: sha256(readFileSync(resolve(root, path))) })) };
    report.input = await installAndroidConsumerArchive({ manifestPath: resolve(options.manifestPath), expectedManifestSha256: options.manifestSha256,
      artifactDirectory: options.artifactDirectory, workDirectory: out, installDirectory: installed }); save();
    const original = verifyInstalledAndroidArchive(installed), distribution = original.distribution;
    Object.assign(report, { sourceCommit: distribution.sourceCommit, sourceInventorySha256: distribution.sourceInventorySha256, sourceDirty: false, sourceKind: 'exact-committed-consumer-sources',
      native: distribution.native, distributionSha256: original.distributionSha256, maven: original.maven, aar: original.aar, originalAar: original.aarRecord });
    report.consumerSource = prepareAndroidConsumerHarness({ sourceRoot, receipt: distribution, destination: consumer });
    const fixture = resolve(consumer, 'src/main/assets/portable-pack');
    report.fixtureIntegrity = makeFixture(undefined, fixture);
    report.fixture = { kind: 'public-contract-authored-acceptance-pack', files: treeRecords(fixture) };
    const aar = inspectAndroidConsumerPackage({ archive: original.aar, kind: 'aar', binaries: original.binaries, workDirectory: out });
    assert.equal(aar.sha256, original.aarRecord.sha256);
    const notices = aar.files.filter(file => file.path.startsWith('assets/weapp-container/'));
    assert.ok(notices.some(file => file.path.endsWith('/LICENSE')) && notices.some(file => file.path.includes('licenses.json')), 'Original AAR must contain complete notices');
    report.originalAar = { ...aar, path: original.aar };
    const init = resolve(out, 'archive-consumer.init.gradle'), initBytes = readFileSync(resolve(root, 'scripts/lib/android-archive-consumer.init.gradle'));
    writeFileSync(init, initBytes, { flag: 'wx' }); report.buildHarness = { file: init, sha256: sha256(initBytes), purpose: 'Exclusive installed Maven and byte-preserving JNI packaging; consumer sources are unchanged' };
    const dependencyPath = resolve(out, 'dependencies.json');
    const common = ['--no-daemon', '--console=plain', '--no-build-cache', ...(options.offline ? ['--offline'] : [])];
    await run('gradle-version', gradle, ['--version'], consumer);
    assert.match(readFileSync(resolve(out, report.checks.at(-1).log), 'utf8'), /Gradle 8\.9(?:\s|$)/, 'Pinned Gradle 8.9 is required');
    await run('build-without-Rust-or-wrapper', gradle, [...common, '-I', init, 'weappArchiveDependencyReceipt', 'assembleRelease', 'assembleReleaseAndroidTest',
      `-PweappSdkMavenDir=${original.maven}`, `-PweappArchiveAar=${original.aar}`, `-PweappArchiveAarSha256=${aar.sha256}`, `-PweappArchiveDependencyReceipt=${dependencyPath}`], consumer);
    report.dependencies = verifyAndroidConsumerDependencies({ receiptPath: dependencyPath, maven: original.maven, aarSha256: aar.sha256 });
    report.releaseApk = apkIn(resolve(consumer, 'build/outputs/apk/release'));
    report.testApk = apkIn(resolve(consumer, 'build/outputs/apk/androidTest/release'));
    const mapping = ordinaryFile(consumer, 'build/outputs/mapping/release/mapping.txt');
    assert.match(mapping.toString(), /# compiler: R8|# compiler: r8/i, 'Actual release R8 mapping is required');
    report.r8 = { path: 'build/outputs/mapping/release/mapping.txt', size: mapping.length, sha256: sha256(mapping) };
    const zipalign = resolve(sdk, 'build-tools/36.0.0', process.platform === 'win32' ? 'zipalign.exe' : 'zipalign');
    await run('16KB-APK-ZIP-alignment', zipalign, ['-c', '-P', '16', '4', report.releaseApk], out, 60_000);
    const fixtureFiles = report.fixture.files.map(record => ({ ...record, path: `assets/portable-pack/${record.path}` }));
    report.releasePackage = inspectAndroidConsumerPackage({ archive: report.releaseApk, kind: 'apk', binaries: aar.binaries, files: [...notices, ...fixtureFiles], workDirectory: out });
    report.testPackage = inspectAndroidConsumerPackage({ archive: report.testApk, kind: 'test-apk', workDirectory: out });
    report.binaries = report.releasePackage.binaries;
    report.pinnedRuntimeBytes = report.releasePackage.binaries.map(({ abi, library, bytes, sha256 }) => ({ abi, library, bytes, sha256 }));
    for (const file of report.consumerSource.files) assert.equal(sha256(ordinaryFile(consumer, file.path)), file.sha256, 'Gradle changed reviewed consumer source');
    verifyInstalledAndroidArchive(installed);
    assert.equal(sha256(readFileSync(original.aar)), aar.sha256, 'Consumer build replaced original AAR');
    report.acceptance = { freshArchiveInstallation: 'passed', independentConsumerBuild: 'passed', r8: 'passed', originalAarAndAllNativeBytes: 'passed', noticesAndFixtureBytes: 'passed', device: 'pending', hostServiceApis: 'pending', physicalHardware: 'pending' };
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.stack ?? error.message; }
  report.finishedAt = new Date().toISOString(); save();
  return { report, reportPath: resolve(out, 'validation.json') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildAndroidArchiveConsumer(parse(process.argv.slice(2)));
    console.log(JSON.stringify({ status: result.report.status, report: result.reportPath, error: result.report.error }, null, 2));
    if (result.report.status !== 'passed') process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
