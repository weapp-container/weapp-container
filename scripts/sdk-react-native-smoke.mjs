import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as createSocketServer} from 'node:net';
import assert from 'node:assert/strict';
import {sha256, verifyInstalledPackage} from './sdk-react-native-integrity.mjs';
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const consumer = resolve(arg('--consumer', '/tmp/weapp-rn-consumer'));
const platform = arg('--platform');
const device = arg('--device');
const development = process.argv.includes('--development');
const refreshRounds = Number(arg('--refresh-rounds', '1'));
assert.ok(Number.isInteger(refreshRounds) && refreshRounds >= 1 && refreshRounds <= 20, 'Refresh rounds must be an integer from 1 to 20');
const configuration = development ? 'Debug' : 'Release';
const rotationMode = arg('--rotation', 'device');
assert.ok(['device', 'scene'].includes(rotationMode), '--rotation must be device or scene');
assert.ok(rotationMode !== 'scene' || (platform === 'ios' && !development), 'Scene rotation is an iOS Release consumer mode');
if (!device || !['ios', 'android'].includes(platform)) throw new Error('Supply --platform ios|android and --device EXISTING_DEVICE_ID');
const metadata = JSON.parse(readFileSync(resolve(consumer, 'consumer.json')));
const out = resolve(arg('--out', resolve(consumer, `validation-${platform}`)));
mkdirSync(out, {recursive: true});
const receipt = {schema: 1, platform, device, configuration, rotationMode, packageSha256: metadata.packageSha256, fixture: metadata.fixture, bundle: metadata.bundle, checks: [], cleanup: {}, passed: false};
async function run(command, args, {cwd = consumer, timeout = 600_000, allowFailure = false, log} = {}) {
  const chunks = [], errors = [];
  const child = spawn(command, args, {cwd, env: process.env});
  child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => errors.push(bytes));
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal})); }).finally(() => clearTimeout(timer));
  const stdout = Buffer.concat(chunks), stderr = Buffer.concat(errors);
  if (log) writeFileSync(resolve(out, log), Buffer.concat([stdout, stderr]));
  if (!allowFailure && status.code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${status.code}/${status.signal}): ${stderr.toString().slice(-7000)} ${stdout.toString().slice(-7000)}`);
  return {stdout, stderr, ...status};
}
const check = name => { receipt.checks.push(name); console.log(`passed: ${name}`); };
let owned = false;
let metro;
let refreshServer;
let reverseOwned = false;
let androidRotation;
let androidPid;
const sourcePath = resolve(consumer, 'App.tsx');
const originalSource = readFileSync(sourcePath, 'utf8');
const testPath = resolve(consumer, 'ios/ConsumerUITests.swift');
const originalTest = existsSync(testPath) ? readFileSync(testPath, 'utf8') : undefined;
const refresh = (marker = 'refreshed') => { writeFileSync(sourcePath, originalSource.replace("const refreshMarker = 'baseline'", `const refreshMarker = '${marker}'`)); };
try {
  receipt.installedArtifact = verifyInstalledPackage(consumer);
  if (sha256(metadata.package) !== metadata.packageSha256) throw new Error('The prepared npm archive has changed; prepare this consumer again');
  if (platform === 'ios') writeFileSync(testPath, originalTest.replaceAll('__RN_ROTATION_MODE__', rotationMode));
  if (development) {
    const probe = createSocketServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(8081, '127.0.0.1', resolve); });
    await new Promise(resolve => probe.close(resolve));
    const log = [];
    metro = spawn(process.execPath, ['node_modules/react-native/cli.js', 'start', '--host', '127.0.0.1', '--port', '8081', '--no-interactive', '--max-workers', '2'], {cwd: consumer, env: process.env});
    metro.stdout.on('data', bytes => log.push(bytes)); metro.stderr.on('data', bytes => log.push(bytes));
    metro.once('close', () => writeFileSync(resolve(out, 'metro.log'), Buffer.concat(log)));
    const deadline = Date.now() + 60_000;
    while (true) {
      if (metro.exitCode !== null) throw new Error('Owned Metro exited before becoming ready');
      try { const response = await fetch('http://127.0.0.1:8081/status'); if ((await response.text()).includes('packager-status:running')) break; } catch {}
      if (Date.now() > deadline) throw new Error('Metro did not become ready');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (platform === 'ios') {
      refreshServer = createServer((request, response) => { if (request.url !== '/refresh') { response.writeHead(404).end(); return; } refresh(); response.end('refreshed'); });
      await new Promise(resolve => refreshServer.listen(0, '127.0.0.1', resolve));
      writeFileSync(testPath, originalTest.replaceAll('__RN_ROTATION_MODE__', rotationMode).replace('__REFRESH_URL__', `http://127.0.0.1:${refreshServer.address().port}/refresh`));
    } else {
      const reverse = await run('adb', ['-s', device, 'reverse', '--list']);
      if (reverse.stdout.toString().includes('tcp:8081')) throw new Error('Existing adb reverse on 8081 belongs to another owner');
      await run('adb', ['-s', device, 'reverse', 'tcp:8081', 'tcp:8081']); reverseOwned = true;
    }
  }
  if (platform === 'ios') {
    const exists = await run('xcrun', ['simctl', 'get_app_container', device, metadata.bundle, 'app'], {allowFailure: true});
    if (exists.code === 0) throw new Error('Consumer already installed; inspect ownership before replacing it');
    const localPods = {'React-Core-prebuilt': process.env.RCT_TESTONLY_RNCORE_TARBALL_PATH, ReactNativeDependencies: process.env.RCT_USE_LOCAL_RN_DEP, 'hermes-engine': process.env.HERMES_ENGINE_TARBALL_PATH};
    const changedPods = Object.entries(localPods).filter(([name, archive]) => {
      const spec = resolve(consumer, `ios/Pods/Local Podspecs/${name}.podspec.json`);
      return archive && existsSync(spec) && JSON.parse(readFileSync(spec)).source?.http !== `file://${archive}`;
    }).map(([name]) => name);
    // CocoaPods retains evaluated podspec sources across installs. Switching
    // an official local Debug/Release cache needs a targeted source refresh.
    await run('pod', changedPods.length ? ['update', ...changedPods, '--no-repo-update'] : ['install'], {cwd: resolve(consumer, 'ios'), log: 'pod-install.log'});
    await run('xcodebuild', ['-workspace', 'ios/HelloWorld.xcworkspace', '-scheme', 'HelloWorld', '-configuration', configuration, '-sdk', 'iphonesimulator', '-destination', `id=${device}`, '-derivedDataPath', 'build/ios', 'build-for-testing', 'CODE_SIGNING_ALLOWED=NO'], {timeout: 1_200_000, log: 'build.log'});
    check('Independent npm consumer iOS Fabric/TurboModule compile and link');
    receipt.application = Object.fromEntries(['HelloWorld', 'HelloWorld.debug.dylib', 'main.jsbundle'].map(name => [name, resolve(consumer, `build/ios/Build/Products/${configuration}-iphonesimulator/HelloWorld.app`, name)]).filter(([, file]) => existsSync(file)).map(([name, file]) => [name, sha256(file)]));
    owned = true;
    const result = resolve(out, 'Consumer.xcresult');
    if (existsSync(result)) throw new Error('Use a fresh --out; xcresult must not be overwritten');
    await run('xcodebuild', ['-workspace', 'ios/HelloWorld.xcworkspace', '-scheme', 'HelloWorld', '-configuration', configuration, '-destination', `id=${device}`, '-derivedDataPath', 'build/ios', '-resultBundlePath', result, '-collect-test-diagnostics', 'never', '-enablePerformanceTestsDiagnostics', 'NO', `-only-testing:ConsumerUITests/ConsumerUITests/${development ? 'testDevelopmentReload' : 'testNativeSessions'}`, 'test-without-building', 'CODE_SIGNING_ALLOWED=NO'], {timeout: 600_000, log: 'test.log'});
    const summary = await run('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', result]);
    writeFileSync(resolve(out, 'tests.json'), summary.stdout);
    const counts = JSON.parse(summary.stdout);
    assert.equal(counts.passedTests, 1, 'The requested device test must execute and pass');
    assert.equal(counts.skippedTests, 0, 'Skipped tests do not validate native support');
    assert.equal(counts.failedTests, 0);
    await run('xcrun', ['xcresulttool', 'export', 'attachments', '--path', result, '--output-path', resolve(out, 'attachments')]);
    check(development ? 'Actual Metro Fast Refresh and full React instance reload with persistent storage, dual GPU surfaces and new host handlers' : `XCUITest: dual GPU sessions, tap/timer/scroll, async host calls/cancellation, rerender, navigation/back, detach/reattach, lifecycle/${rotationMode} rotation, durable close/reopen`);
  } else {
    const adb = (args, options) => run('adb', ['-s', device, ...args], options);
    const before = await adb(['shell', 'pm', 'path', metadata.bundle], {allowFailure: true});
    if (before.stdout.toString().includes('package:')) throw new Error('Consumer already installed; inspect ownership before replacing it');
    await run(process.env.GRADLE_BIN || './gradlew', [`:app:assemble${configuration}`, '-PreactNativeArchitectures=arm64-v8a,x86_64', '--no-daemon', '--console=plain'], {cwd: resolve(consumer, 'android'), timeout: 1_200_000, log: 'build.log'});
    check('Independent npm consumer Android Fabric/TurboModule compile and link');
    const apk = resolve(consumer, `android/app/build/outputs/apk/${configuration.toLowerCase()}/app-${configuration.toLowerCase()}.apk`);
    receipt.application = {apkSha256: sha256(apk)};
    await adb(['install', '-r', apk]); owned = true;
    const launch = () => adb(['shell', 'am', 'start', '-W', '-n', `${metadata.bundle}/com.helloworld.MainActivity`]);
    await launch();
    androidPid = (await adb(['shell', 'pidof', metadata.bundle])).stdout.toString().trim();
    assert.match(androidPid, /^\d+$/, 'The installed Android consumer must have one running app process');
    const xmlPath = `/sdcard/weapp-rn-${metadata.bundle.slice(-10)}.xml`;
    const decode = text => text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value.replace(/^x/i, ''), /^x/i.test(value) ? 16 : 10))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    async function nodes() {
      await adb(['shell', 'uiautomator', 'dump', xmlPath], {timeout: 20_000});
      const {stdout} = await adb(['shell', 'cat', xmlPath]);
      writeFileSync(resolve(out, 'ui.xml'), stdout);
      // UIAutomator uses single quotes around JSON accessibility labels, and
      // XML permits > inside quoted attributes. Preserve both forms intact.
      return [...stdout.toString().matchAll(/<node\b(?:"[^"]*"|'[^']*'|[^'">])*>/g)].map(match => Object.fromEntries([...match[0].matchAll(/([\w:-]+)=(["'])(.*?)\2/gs)].map(attr => [attr[1], decode(attr[3])])));
    }
    let latest = [];
    let data = {};
    const find = name => latest.find(item => item['resource-id'] === name || item['resource-id']?.endsWith(`/${name}`) || item['content-desc'] === name || item.text === name);
    async function wait(label, condition) {
      const deadline = Date.now() + 45_000;
      do {
        latest = await nodes();
        const value = find('receipt');
        if (value) { try { data = JSON.parse(value['content-desc'] || value.text); } catch {} }
        const status = find('status');
        if ((status?.['content-desc'] || status?.text || '').startsWith('failed:')) throw new Error(JSON.stringify({label, status, data}));
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
      throw new Error(`Timeout ${label}: ${JSON.stringify({data, latest})}`);
    }
    function bounds(item) { assert.ok(item, 'Missing UI element'); const [x1, y1, x2, y2] = item.bounds.match(/\d+/g).map(Number); return {x1, y1, x2, y2}; }
    async function action(name) { const box = bounds(find(name)); await adb(['shell', 'input', 'tap', String(Math.round((box.x1 + box.x2) / 2)), String(Math.round((box.y1 + box.y2) / 2))]); await wait(name, () => { const status = find('status'); return (status?.['content-desc'] || status?.text) === `passed:${name}`; }); }
    const message = key => data.messages?.[key] ?? {};
    await wait('ready', () => (find('status')?.['content-desc'] || find('status')?.text) === 'ready' && data.presented >= 2 && data.hostCalls >= 2 && data.cancelled >= 1);
    assert.equal(data.nativeError, undefined);
    assert.ok(JSON.stringify(data.firstGpuCapabilities).includes('skia-gpu-gles'));
    check('Two GPU sessions, asynchronous host call and native deadline cancellation');
    const area = bounds(find('container-main'));
    const ratio = message('first:initial').pixelRatio;
    assert.ok(ratio > 0);
    await adb(['shell', 'input', 'tap', String(Math.round(area.x1 + 40 * ratio)), String(Math.round(area.y1 + 80 * ratio))]);
    await wait('tap and timer', () => message('first:tap').count >= 1 && message('first:timer').count >= 1);
    const scroll = message('first:geometry').scroll;
    const x = Math.round(area.x1 + (scroll.left + 50) * ratio), y = Math.round(area.y1 + (scroll.top + 130) * ratio);
    await adb(['shell', 'input', 'swipe', String(x), String(y), String(x), String(Math.round(y - 100 * ratio)), '300']);
    await wait('scroll', () => message('first:scroll').scrollTop > 0);
    writeFileSync(resolve(out, 'two-native-surfaces.png'), (await adb(['exec-out', 'screencap', '-p'])).stdout);
    check('Real Android touch, timer and scroll input');
    let session = data.session;
    if (development) {
      const fastRefresh = [];
      let refreshed = session;
      for (let round = 1; round <= refreshRounds; round++) {
        const marker = round === 1 ? 'refreshed' : `refreshed-${round}`;
        const previous = refreshed;
        refresh(marker);
        await wait(`Actual Metro Fast Refresh ${round}`, () => (find('refresh-marker')?.['content-desc'] || find('refresh-marker')?.text) === marker && data.session !== previous && data.firstGpuCapabilities && data.secondGpuCapabilities && (find('status')?.['content-desc'] || find('status')?.text) === 'ready');
        assert.ok(message('first:initial').stored >= 1);
        refreshed = data.session;
        fastRefresh.push({round, session: refreshed, receipt: structuredClone(data)});
      }
      const reload = bounds(find('ReloadRuntime'));
      await adb(['shell', 'input', 'tap', String(Math.round((reload.x1 + reload.x2) / 2)), String(Math.round((reload.y1 + reload.y2) / 2))]);
      await wait('Full React runtime reload', () => data.session !== refreshed && data.firstGpuCapabilities && data.secondGpuCapabilities && data.hostCalls >= 2 && data.cancelled >= 1 && (find('status')?.['content-desc'] || find('status')?.text) === 'ready');
      assert.ok(message('first:initial').stored >= 1); assert.equal(data.nativeError, undefined);
      writeFileSync(resolve(out, 'react-native-reload.json'), JSON.stringify({original: session, fastRefresh: refreshed, refreshRounds: fastRefresh, fullReload: data.session, receipt: data}, null, 2));
      check('Actual Metro Fast Refresh and full React instance reload with stable storage and dual GPU surfaces');
    }
    session = data.session;
    await action('Rerender'); assert.equal(data.session, session);
    const beforeRemount = data.presented;
    await action('RapidRemount'); assert.equal(data.rapidRemountSession, session);
    await wait('Recycled Fabric surface presents', () => data.presented > beforeRemount);
    await action('Navigate'); assert.ok(JSON.stringify(data.state).includes('pages/detail/index'));
    await action('Back');
    await action('Detach'); await wait('hidden completion', () => message('first:hiddenDone').result != null);
    const beforeReattach = data.presented;
    await action('Reattach'); assert.equal(data.reattachedSession, session);
    await wait('Reattached Fabric surface presents', () => data.presented > beforeReattach);
    check('Rerender, navigation/back and detach/reattach retain the session');
    await action('Pause'); await adb(['shell', 'input', 'keyevent', '3']); await launch(); await wait('returned', () => Boolean(find('Resume'))); await action('Resume');
    await wait('foreground lifecycle', () => message('first:show').shows >= 2);
    check('Host pause and app background/foreground');
    androidRotation = Object.fromEntries(await Promise.all(['accelerometer_rotation', 'user_rotation'].map(async name => [name, (await adb(['shell', 'settings', 'get', 'system', name])).stdout.toString().trim()])));
    await adb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
    await adb(['shell', 'settings', 'put', 'system', 'user_rotation', '1']);
    await wait('landscape metrics', () => message('first:resize').deviceOrientation === 'landscape');
    assert.equal(data.session, session);
    writeFileSync(resolve(out, 'landscape-native-surfaces.png'), (await adb(['exec-out', 'screencap', '-p'])).stdout);
    await adb(['shell', 'settings', 'put', 'system', 'user_rotation', '0']);
    await wait('portrait metrics', () => message('first:resize').deviceOrientation === 'portrait');
    check('Android rotation updates native viewport metrics without replacing the session');
    await action('Close'); await action('Reopen'); await wait('durable reopen', () => message('reopened:initial').stored >= 1); assert.notEqual(data.reopened, session);
    await action('Finish'); assert.equal(data.allClosed, true); assert.equal(data.error, undefined);
    writeFileSync(resolve(out, 'consumer-result.json'), JSON.stringify(data, null, 2) + '\n');
    check('Durable flush, close and reopen');
    await adb(['shell', 'rm', '-f', xmlPath]);
  }
  receipt.passed = true;
} catch (error) { receipt.error = String(error); process.exitCode = 1; console.error(error); }
finally {
  if (platform === 'ios' && existsSync(resolve(out, 'Consumer.xcresult'))) {
    try {
      if (!existsSync(resolve(out, 'tests.json'))) writeFileSync(resolve(out, 'tests.json'), (await run('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', resolve(out, 'Consumer.xcresult')])).stdout);
      if (!existsSync(resolve(out, 'attachments'))) await run('xcrun', ['xcresulttool', 'export', 'attachments', '--path', resolve(out, 'Consumer.xcresult'), '--output-path', resolve(out, 'attachments')]);
    } catch (error) { receipt.diagnosticError = String(error); }
  }
  try {
    if (owned && platform === 'ios') {
      for (const id of [metadata.bundle, `${metadata.bundle}.tests.xctrunner`]) {
        await run('xcrun', ['simctl', 'terminate', device, id], {allowFailure: true});
        await run('xcrun', ['simctl', 'uninstall', device, id]);
        const check = await run('xcrun', ['simctl', 'get_app_container', device, id, 'app'], {allowFailure: true});
        if (check.code === 0) throw new Error(`Cleanup failed: ${id}`);
      }
      receipt.cleanup.appsRemoved = true;
    } else if (owned && platform === 'android') {
      if (androidPid) {
        try {
          const diagnostic = await run('adb', ['-s', device, 'logcat', '-d', `--pid=${androidPid}`]);
          writeFileSync(resolve(out, 'logcat.txt'), diagnostic.stdout);
          receipt.application.pid = Number(androidPid);
        } catch (error) { receipt.diagnosticExportError = String(error); }
      }
      await run('adb', ['-s', device, 'shell', 'am', 'force-stop', metadata.bundle], {allowFailure: true});
      await run('adb', ['-s', device, 'uninstall', metadata.bundle]);
      const check = await run('adb', ['-s', device, 'shell', 'pm', 'path', metadata.bundle], {allowFailure: true});
      if (check.stdout.toString().includes('package:')) throw new Error('Android consumer remains installed');
      await run('adb', ['-s', device, 'shell', 'rm', '-f', `/sdcard/weapp-rn-${metadata.bundle.slice(-10)}.xml`]);
      receipt.cleanup.appsRemoved = true;
    }
    receipt.cleanup.borrowedDevicePreserved = true;
  } catch (error) { receipt.cleanup.error = String(error); receipt.passed = false; process.exitCode = 1; }
  if (androidRotation) {
    try {
      for (const [name, value] of Object.entries(androidRotation)) {
        await run('adb', ['-s', device, 'shell', 'settings', value === 'null' ? 'delete' : 'put', 'system', name, ...(value === 'null' ? [] : [value])]);
        assert.equal((await run('adb', ['-s', device, 'shell', 'settings', 'get', 'system', name])).stdout.toString().trim(), value);
      }
      receipt.cleanup.deviceRotationRestored = true;
    } catch (error) { receipt.cleanup.rotationError = String(error); receipt.passed = false; process.exitCode = 1; }
  }
  try {
    if (platform === 'ios' && originalTest !== undefined) writeFileSync(testPath, originalTest);
    if (development) {
      writeFileSync(sourcePath, originalSource);
      if (reverseOwned) { await run('adb', ['-s', device, 'reverse', '--remove', 'tcp:8081']); receipt.cleanup.adbReverseRemoved = true; }
      if (refreshServer) await new Promise((resolve, reject) => refreshServer.close(error => error ? reject(error) : resolve()));
      if (metro && metro.exitCode === null) {
        const stopped = new Promise(resolve => metro.once('close', resolve));
        metro.kill('SIGTERM');
        const timer = setTimeout(() => metro.kill('SIGKILL'), 5000);
        await stopped; clearTimeout(timer);
      }
      receipt.cleanup.metroStopped = metro == null || metro.exitCode !== null || metro.signalCode !== null;
    }
  } catch (error) { receipt.cleanup.developmentError = String(error); receipt.passed = false; process.exitCode = 1; }
  writeFileSync(resolve(out, 'validation.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
}
