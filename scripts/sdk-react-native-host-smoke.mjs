import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {sha256, verifyInstalledPackage} from './sdk-react-native-integrity.mjs';
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const consumer = resolve(arg('--consumer', '/tmp/weapp-rn-host-consumer'));
const platform = arg('--platform');
const device = arg('--device');
const selectedTest = arg('--test');
assert.ok(['ios', 'android'].includes(platform) && device, 'Supply a platform and an existing borrowed device');
const metadata = JSON.parse(readFileSync(resolve(consumer, 'consumer.json')));
assert.ok(metadata.harness, 'Prepare the independent host harness first');
const out = resolve(arg('--out', resolve(consumer, `host-validation-${platform}`)));
assert.ok(!existsSync(out), 'Use a fresh evidence directory');
mkdirSync(out, {recursive: true});
const receipt = {schema: 1, platform, device, configuration: 'Release', packageSha256: metadata.packageSha256, fixture: metadata.fixture, bundle: metadata.bundle, harness: metadata.harness, checks: [], passed: false, cleanup: {}};
let installed = false, androidPid;
async function run(command, args, {cwd = consumer, timeout = 600_000, allowFailure = false, log} = {}) {
  const stdout = [], stderr = [];
  const child = spawn(command, args, {cwd, env: process.env});
  child.stdout.on('data', value => stdout.push(value)); child.stderr.on('data', value => stderr.push(value));
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  const result = {stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code};
  if (log) writeFileSync(resolve(out, log), Buffer.concat([result.stdout, result.stderr]));
  if (!allowFailure && code !== 0) throw new Error(`${command} failed (${code}): ${result.stderr.toString().slice(-5000)} ${result.stdout.toString().slice(-5000)}`);
  return result;
}
const check = value => { receipt.checks.push(value); console.log(`passed: ${value}`); };
try {
  receipt.installedArtifact = verifyInstalledPackage(consumer);
  assert.equal(sha256(metadata.package), metadata.packageSha256);
  if (platform === 'ios') {
    const existing = await run('xcrun', ['simctl', 'get_app_container', device, metadata.bundle, 'app'], {allowFailure: true});
    assert.notEqual(existing.code, 0, 'Host harness is already installed; inspect ownership before replacing it');
    const localPods = {'React-Core-prebuilt': process.env.RCT_TESTONLY_RNCORE_TARBALL_PATH, ReactNativeDependencies: process.env.RCT_USE_LOCAL_RN_DEP, 'hermes-engine': process.env.HERMES_ENGINE_TARBALL_PATH};
    const changed = Object.entries(localPods).filter(([name, archive]) => { const path = resolve(consumer, `ios/Pods/Local Podspecs/${name}.podspec.json`); return archive && existsSync(path) && JSON.parse(readFileSync(path)).source?.http !== `file://${archive}`; }).map(([name]) => name);
    await run('pod', changed.length ? ['update', ...changed, '--no-repo-update'] : ['install'], {cwd: resolve(consumer, 'ios'), log: 'pod-install.log'});
    await run('xcodebuild', ['-workspace', 'ios/HelloWorld.xcworkspace', '-scheme', 'HelloWorld', '-configuration', 'Release', '-sdk', 'iphonesimulator', '-destination', `id=${device}`, '-derivedDataPath', 'build/ios', 'build-for-testing', 'CODE_SIGNING_ALLOWED=NO'], {timeout: 1_200_000, log: 'build.log'});
    check('Independent native-stack and ScrollView host harness compiles and links');
    receipt.application = Object.fromEntries(['HelloWorld', 'main.jsbundle'].map(name => [name, sha256(resolve(consumer, 'build/ios/Build/Products/Release-iphonesimulator/HelloWorld.app', name))]));
    installed = true;
    const resultPath = resolve(out, 'Host.xcresult');
    const test = await run('xcodebuild', ['-workspace', 'ios/HelloWorld.xcworkspace', '-scheme', 'HelloWorld', '-configuration', 'Release', '-destination', `id=${device}`, '-derivedDataPath', 'build/ios', '-resultBundlePath', resultPath, '-collect-test-diagnostics', 'never', '-enablePerformanceTestsDiagnostics', 'NO', `-only-testing:ConsumerUITests/ConsumerUITests${selectedTest ? `/${selectedTest}` : ''}`, 'test-without-building', 'CODE_SIGNING_ALLOWED=NO'], {timeout: 600_000, log: 'test.log', allowFailure: true});
    const summary = await run('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', resultPath]);
    writeFileSync(resolve(out, 'tests.json'), summary.stdout);
    receipt.tests = JSON.parse(summary.stdout);
    assert.equal(test.code, 0, 'Native host XCTest failed; see test.log, tests.json and attachments');
    assert.equal(receipt.tests.passedTests, selectedTest ? 1 : 3);
    assert.equal(receipt.tests.failedTests, 0); assert.equal(receipt.tests.skippedTests, 0);
    check(selectedTest || 'Real native host push/pop, parent/embedded scrolling, touch cancellation and recovery');
  } else {
    const adb = (args, options) => run('adb', ['-s', device, ...args], options);
    assert.ok(!(await adb(['shell', 'pm', 'path', metadata.bundle], {allowFailure: true})).stdout.toString().includes('package:'), 'Host harness already installed');
    await run(process.env.GRADLE_BIN || './gradlew', [':app:assembleRelease', '-PreactNativeArchitectures=arm64-v8a,x86_64', '--no-daemon', '--console=plain'], {cwd: resolve(consumer, 'android'), timeout: 1_200_000, log: 'build.log'});
    check('Independent native-stack and ScrollView host harness compiles and links');
    const apk = resolve(consumer, 'android/app/build/outputs/apk/release/app-release.apk'); receipt.application = {apkSha256: sha256(apk)};
    await adb(['install', apk]); installed = true;
    await adb(['shell', 'am', 'start', '-W', '-n', `${metadata.bundle}/com.helloworld.MainActivity`]);
    androidPid = (await adb(['shell', 'pidof', metadata.bundle])).stdout.toString().trim(); assert.match(androidPid, /^\d+$/);
    const xmlPath = `/sdcard/weapp-rn-host-${metadata.bundle.split('.').at(-2)}.xml`;
    const decode = value => value.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n.replace(/^x/i, ''), /^x/i.test(n) ? 16 : 10))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    let nodes = [], data = {};
    const find = name => nodes.find(n => n['resource-id'] === name || n['resource-id']?.endsWith(`/${name}`) || n['content-desc'] === name || n.text === name);
    async function wait(name, condition) {
      const deadline = Date.now() + 30_000;
      do {
        await adb(['shell', 'uiautomator', 'dump', xmlPath], {timeout: 20_000});
        const xml = (await adb(['shell', 'cat', xmlPath])).stdout;
        writeFileSync(resolve(out, 'ui.xml'), xml);
        nodes = [...xml.toString().matchAll(/<node\b(?:"[^"]*"|'[^']*'|[^'">])*>/g)].map(m => Object.fromEntries([...m[0].matchAll(/([\w:-]+)=(["'])(.*?)\2/gs)].map(a => [a[1], decode(a[3])])));
        const value = find('host-receipt'); if (value) { try { data = JSON.parse(value['content-desc'] || value.text); } catch {} }
        writeFileSync(resolve(out, 'host-receipt.json'), JSON.stringify(data, null, 2));
        assert.ok(!(find('host-status')?.['content-desc'] || '').startsWith('failed:'), JSON.stringify(data));
        if (condition()) return;
      } while (Date.now() < deadline);
      throw new Error(`Timeout ${name}: ${JSON.stringify(data)}`);
    }
    const bounds = name => { const node = find(name); assert.ok(node, `Missing ${name}`); const [x1, y1, x2, y2] = node.bounds.match(/\d+/g).map(Number); return {x1, y1, x2, y2}; };
    const tap = (x, y) => adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
    async function action(name) { const b = bounds(name); await tap((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2); await wait(name, () => (find('host-status')?.['content-desc'] || find('host-status')?.text) === `passed:${name}`); }
    const message = name => data.messages?.[name] ?? {};
    const touchEvents = type => (data.touchEvents ?? []).filter(event => event.type === type).length;
    const drag = (x, y, endY, duration = 300) => adb(['shell', 'input', 'swipe', String(Math.round(x)), String(Math.round(y)), String(Math.round(x)), String(Math.round(endY)), String(duration)]);
    await wait('ready', () => data.session && data.gpu && message('geometry').scroll && (find('host-status')?.['content-desc'] || find('host-status')?.text) === 'ready');
    assert.ok(JSON.stringify(data.gpu).includes('skia-gpu-gles'));
    const session = data.session, stored = message('initial').stored;
    const nativePoint = (x, y) => { const b = bounds('host-container'), ratio = message('initial').pixelRatio; return {x: b.x1 + x * ratio, y: b.y1 + y * ratio}; };
    const before = nativePoint(40, 80); await tap(before.x, before.y);
    await wait('touch before route', () => message('tap').count === stored + 1);
    await action('MiniDetail'); assert.ok(JSON.stringify(data.state).includes('pages/detail/index'));
    await action('PushHost'); await wait('host push', () => data.hostRoute === 'Other');
    await action('PopHost'); await wait('host pop', () => data.hostRoute === 'Embedded' && find('host-container'));
    await action('Inspect'); assert.equal(data.session, session); assert.ok(JSON.stringify(data.state).includes('pages/detail/index'));
    const after = nativePoint(40, 80); await tap(after.x, after.y); await wait('state retained', () => message('tap').count === stored + 2);
    check('Native host route push/pop retains the native session and mini-program page state');
    const parent = bounds('parent-drag-area'); await drag((parent.x1 + parent.x2) / 2, parent.y2 - 15, parent.y1 + 10);
    await wait('parent area scrolls', () => data.parentOffset > 30); await action('ResetParent'); await wait('parent reset', () => Math.abs(data.parentOffset) < 1);
    const geometry = message('geometry').scroll, start = nativePoint(geometry.left + 50, geometry.top + 130), end = nativePoint(geometry.left + 50, geometry.top + 30);
    await drag(start.x, start.y, end.y); await wait('embedded scroll', () => message('scroll').scrollTop > 30);
    assert.ok(Math.abs(data.parentOffset) < 1, 'Parent stole the embedded drag'); assert.ok(touchEvents('touchstart') > 0 && touchEvents('touchend') > 0);
    check('Parent scroll area and embedded mini-program each own their gestures');
    const cancelled = touchEvents('touchcancel'), count = message('tap').count;
    // The harness pushes only after its next real native touchstart, so device
    // automation readiness does not race a guessed timer interval.
    await action('ArmPush');
    const hold = nativePoint(40, 80); await drag(hold.x, hold.y, hold.y, 1300);
    await wait('push cancels active touch', () => data.hostRoute === 'Other' && touchEvents('touchcancel') > cancelled); assert.equal(message('tap').count, count);
    await action('PopHost'); await wait('return after cancellation', () => data.hostRoute === 'Embedded' && find('host-container'));
    const again = nativePoint(40, 80); await tap(again.x, again.y); await wait('new touch works', () => message('tap').count === count + 1);
    check('Host route cancellation does not leak a tap and the next touch works');
    assert.equal(data.nativeError, undefined);
    writeFileSync(resolve(out, 'host-routing-and-scroll.png'), (await adb(['exec-out', 'screencap', '-p'])).stdout);
    await action('Finish'); assert.equal(data.closed, true);
    await adb(['shell', 'rm', '-f', xmlPath]);
  }
  receipt.passed = true;
} catch (error) { receipt.error = String(error); process.exitCode = 1; console.error(error); }
finally {
  if (platform === 'ios' && existsSync(resolve(out, 'Host.xcresult'))) {
    try { await run('xcrun', ['xcresulttool', 'export', 'attachments', '--path', resolve(out, 'Host.xcresult'), '--output-path', resolve(out, 'attachments')]); }
    catch (error) { receipt.diagnosticError = String(error); }
  }
  try {
    if (installed && platform === 'ios') {
      for (const id of [metadata.bundle, `${metadata.bundle}.tests.xctrunner`]) {
        await run('xcrun', ['simctl', 'terminate', device, id], {allowFailure: true}); await run('xcrun', ['simctl', 'uninstall', device, id]);
        assert.notEqual((await run('xcrun', ['simctl', 'get_app_container', device, id, 'app'], {allowFailure: true})).code, 0);
      }
    } else if (installed) {
      if (androidPid) {
        try { writeFileSync(resolve(out, 'logcat.txt'), (await run('adb', ['-s', device, 'logcat', '-d', `--pid=${androidPid}`])).stdout); }
        catch (error) { receipt.diagnosticError = String(error); }
      }
      await run('adb', ['-s', device, 'shell', 'am', 'force-stop', metadata.bundle], {allowFailure: true}); await run('adb', ['-s', device, 'uninstall', metadata.bundle]);
      assert.ok(!(await run('adb', ['-s', device, 'shell', 'pm', 'path', metadata.bundle], {allowFailure: true})).stdout.toString().includes('package:'));
      await run('adb', ['-s', device, 'shell', 'rm', '-f', `/sdcard/weapp-rn-host-${metadata.bundle.split('.').at(-2)}.xml`]);
    }
    receipt.cleanup = {appsRemoved: installed, borrowedDevicePreserved: true};
  } catch (error) { receipt.cleanup.error = String(error); receipt.passed = false; process.exitCode = 1; }
  writeFileSync(resolve(out, 'validation.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
}
