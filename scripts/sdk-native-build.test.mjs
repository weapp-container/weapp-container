import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { portableNativeReceipt } from './lib/sdk-portable-native-receipt.mjs';

test('public native evidence preserves build identity without compiler locations', () => {
  const receipt = { sourceCommit: 'a'.repeat(40), sourceDirty: false,
    targetDir: '/runner/private/cache', toolchain: { rustc: 'rustc 1.99.1' },
    cppAbiValidation: { status: 'passed', binarySha256: 'b'.repeat(64), compileCommand: ['clang++', '/runner/private/source.cpp'] },
    artifacts: [{ file: 'runtime.a', bytes: 4, sha256: 'c'.repeat(64) }] };
  const portable = portableNativeReceipt(receipt, 'd'.repeat(64));
  assert.equal(JSON.stringify(portable).includes('/runner/'), false);
  assert.equal(portable.sourceCommit, receipt.sourceCommit);
  assert.deepEqual(portable.artifacts, receipt.artifacts);
  assert.deepEqual(portable.toolchain, receipt.toolchain);
  assert.equal(portable.cppAbiValidation.binarySha256, receipt.cppAbiValidation.binarySha256);
  assert.equal(portable.producerEvidenceSha256, 'd'.repeat(64));
  assert.equal(receipt.cppAbiValidation.compileCommand[1], '/runner/private/source.cpp');
});

function fixture() {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), 'native-build-preflight-')));
  const root = resolve(directory, 'source'), tools = resolve(directory, 'tools');
  mkdirSync(resolve(root, 'scripts/lib'), { recursive: true }); mkdirSync(tools);
  for (const name of ['sdk-native-build.mjs', 'lib/sdk-current-release.mjs', 'lib/sdk-skia-input.mjs', 'lib/sdk-native-features.mjs', 'lib/showcase-policy.mjs', 'lib/showcase-native-font.mjs', 'lib/sdk-native-hardening.mjs', 'lib/sdk-darwin-hardening.mjs', 'lib/sdk-portable-native-receipt.mjs']) cpSync(new URL(name, import.meta.url), resolve(root, 'scripts', name));
  writeFileSync(resolve(root, '.gitignore'), 'artifacts/\ntarget/\n');
  const git = args => { const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'source fixture']);
  const target = process.platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu';
  const stub = `#!${process.execPath}\nimport('node:fs').then(fs=>{const name=process.argv[1].split('/').pop();if(name==='rustup')process.stdout.write(process.env.TEST_NATIVE_TOOLS+'/'+process.argv[3]+'\\n');else if(name==='rustc'&&process.argv[2]==='-vV')process.stdout.write('host: '+process.env.TEST_NATIVE_TARGET+'\\n');else if(name==='cargo'&&process.argv[2]==='build'){fs.writeFileSync(process.env.TEST_NATIVE_CARGO_CALLED,JSON.stringify(process.argv.slice(2)));fs.writeFileSync(process.env.TEST_NATIVE_CARGO_CALLED+'.env',JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('CXXFLAGS_')||key==='MACOSX_DEPLOYMENT_TARGET'))));process.exitCode=99;}else process.stdout.write('inert toolchain fixture; no compilation\\n');});\n`;
  for (const name of ['rustup', 'cargo', 'rustc', 'rustdoc']) writeFileSync(resolve(tools, name), stub, { mode: 0o755 });
  const ndk = resolve(directory, 'ndk');
  const ndkHost = process.platform === 'darwin' ? 'darwin-aarch64' : 'linux-x86_64';
  const prebuilt = resolve(ndk, 'toolchains/llvm/prebuilt', ndkHost);
  for (const androidTarget of ['aarch64-linux-android', 'x86_64-linux-android']) {
    const bin = resolve(prebuilt, 'bin'), lib = resolve(prebuilt, 'sysroot/usr/lib', androidTarget);
    mkdirSync(bin, { recursive: true }); mkdirSync(lib, { recursive: true });
    for (const suffix of ['26-clang', '26-clang++']) writeFileSync(resolve(bin, androidTarget + suffix), 'inert NDK fixture');
    writeFileSync(resolve(lib, 'libc++_shared.so'), 'inert C++ fixture');
  }
  for (const notice of ['NOTICE', 'NOTICE.toolchain']) writeFileSync(resolve(ndk, notice), 'inert NDK notice');
  const out = resolve(root, 'artifacts/native'), cargoCalled = resolve(directory, 'cargo-called');
  const run = (args = [], selectedTarget = target, extraEnv = {}) => {
    const env = { ...process.env, PATH: `${tools}${delimiter}${process.env.PATH}`, TEST_NATIVE_TOOLS: tools, TEST_NATIVE_TARGET: target, TEST_NATIVE_CARGO_CALLED: cargoCalled, ANDROID_NDK_HOME: resolve(directory, 'ndk') };
    delete env.CARGO_TARGET_DIR;
    Object.assign(env, extraEnv);
    return spawnSync(process.execPath, [resolve(root, 'scripts/sdk-native-build.mjs'), '--target', selectedTarget, '--out', out, ...args], {
      cwd: root, encoding: 'utf8', timeout: 30_000, env,
    });
  };
  return { root, target, out, cargoCalled, run, remove() { rmSync(directory, { recursive: true, force: true }); } };
}

test('actual native entry rejects dirty production source with truthful failed receipt before Cargo', { skip: process.platform === 'win32' }, () => {
  const f = fixture(); try {
    writeFileSync(resolve(f.root, 'uncommitted-runtime.rs'), 'fn must_not_compile() {}\n');
    const result = f.run(); assert.equal(result.status, 1, result.stderr);
    const receipt = JSON.parse(readFileSync(resolve(f.out, f.target, 'build.json')));
    assert.equal(receipt.sdkVersion, SDK_RELEASE_VERSION); assert.equal(receipt.status, 'failed');
    assert.equal(receipt.sourceDirty, true); assert.equal(receipt.exitCode, 1);
    assert.match(receipt.error, /clean committed source/);
    assert.deepEqual(receipt.artifacts, []); assert.equal(existsSync(f.cargoCalled), false);
    assert.equal(readFileSync(resolve(f.out, f.target, 'cargo-build.jsonl'), 'utf8'), '');
  } finally { f.remove(); }
});

test('native generation upgrades refuse to overwrite the old preview producer or bytes', { skip: process.platform === 'win32' }, () => {
  for (const version of ['0.1.0-preview.5.1', '0.1.0-preview.5.2', '0.1.0-preview.5.3']) {
  const f = fixture(); try {
    const output = resolve(f.out, f.target); mkdirSync(output, { recursive: true });
    const receipt = `${JSON.stringify({schemaVersion:1,sdkVersion:version,status:'built',sourceCommit:'747d0b02131d7f67b3adbdd7127abcd5e21ffdbe'})}\n`;
    writeFileSync(resolve(output, 'build.json'), receipt); writeFileSync(resolve(output, 'libweapp_container_sdk.a'), 'historical binary fixture');
    const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /another version/);
    assert.equal(readFileSync(resolve(output, 'build.json'), 'utf8'), receipt);
    assert.equal(readFileSync(resolve(output, 'libweapp_container_sdk.a'), 'utf8'), 'historical binary fixture');
    assert.equal(existsSync(f.cargoCalled), false);
  } finally { f.remove(); }
  }
});

test('actual entry records complete default/off/cpu/atrace plan in failed preflight receipts without compilation', { skip: process.platform === 'win32' }, () => {
  for (const mode of [undefined, 'off', 'cpu', 'atrace']) {
    const f = fixture(); try {
      writeFileSync(resolve(f.root, 'dirty.rs'), 'fn do_not_compile() {}');
      const target = mode === 'atrace' ? 'aarch64-linux-android' : f.target;
      const result = f.run(mode === undefined ? [] : ['--view-diagnostics', mode], target);
      assert.equal(result.status, 1, result.stderr);
      const receipt = JSON.parse(readFileSync(resolve(f.out, target, 'build.json')));
      assert.equal(receipt.sdkVersion, SDK_RELEASE_VERSION);
      assert.equal(receipt.viewDiagnostics, mode ?? 'off');
      const base = target.endsWith('android') ? ['quickjs-native-android', 'skia-gpu-gles']
        : process.platform === 'darwin' ? ['quickjs-native', 'skia-gpu-metal'] : ['quickjs-native', 'skia-gpu-gles'];
      assert.deepEqual(receipt.features, [...base, ...(!mode || mode === 'off' ? [] : ['view-batch-diagnostics']), ...(mode === 'atrace' ? ['android-view-atrace'] : [])]);
      assert.equal(receipt.status, 'failed'); assert.equal(receipt.sourceDirty, true);
      assert.match(receipt.error, /clean committed source/);
      assert.equal(existsSync(f.cargoCalled), false);
    } finally { f.remove(); }
  }
});
test('actual entry rejects invalid, missing, duplicate diagnostics and non-Android atrace before a producer is written', { skip: process.platform === 'win32' }, () => {
  for (const args of [['--view-diagnostics'], ['--view-diagnostics', 'bad'], ['--view-diagnostics', 'cpu', '--view-diagnostics', 'off'], ['--view-diagnostics=cpu'], ['--unknown', 'value'], ['--view-diagnostics', 'atrace']]) {
    const f = fixture(); try {
      const result = f.run(args); assert.equal(result.status, 1);
      assert.equal(existsSync(resolve(f.out, f.target, 'build.json')), false);
      assert.equal(existsSync(f.cargoCalled), false);
    } finally { f.remove(); }
  }
});

test('actual dev entry passes the receipt feature plan to an inert failing Cargo stub', { skip: process.platform === 'win32' }, () => {
  for (const mode of ['off', 'cpu', 'atrace']) {
    const f = fixture(); try {
      const target = mode === 'atrace' ? 'aarch64-linux-android' : f.target;
      const result = f.run(['--profile', 'dev', '--view-diagnostics', mode], target);
      assert.equal(result.status, 99, result.stderr);
      const receipt = JSON.parse(readFileSync(resolve(f.out, target, 'build.json')));
      const argv = JSON.parse(readFileSync(f.cargoCalled));
      assert.deepEqual(argv[argv.indexOf('--features') + 1].split(','), receipt.features);
      assert.equal(receipt.viewDiagnostics, mode);
      assert.equal(receipt.profile, 'dev'); assert.equal(receipt.status, 'failed');
      const cppEnvironment = JSON.parse(readFileSync(f.cargoCalled + '.env'));
      if (target.endsWith('apple-darwin')) {
        assert.match(cppEnvironment['CXXFLAGS_' + target.replaceAll('-', '_')], /(?:^| )-fno-exceptions(?: |$)/);
        assert.equal(cppEnvironment.MACOSX_DEPLOYMENT_TARGET, '12.0');
        assert.equal(receipt.toolchain.cppExceptions, 'disabled-at-rust-ffi-boundary');
      }
      assert.deepEqual(receipt.artifacts, []);
    } finally { f.remove(); }
  }
});

test('native SDK shares the workspace target and honors explicit then environment cache paths', { skip: process.platform === 'win32' }, () => {
  for (const profile of ['dev', 'release']) {
    for (const selection of ['default', 'environment', 'explicit']) {
      const f = fixture(); try {
        const inherited = 'target/shared environment';
        const explicit = resolve(f.root, 'target/explicit cache');
        const env = selection === 'default' ? {} : { CARGO_TARGET_DIR: inherited };
        const args = ['--profile', profile, ...(selection === 'explicit' ? ['--target-dir', explicit] : [])];
        const result = f.run(args, f.target, env);
        assert.equal(result.status, 99, result.stderr);
        const argv = JSON.parse(readFileSync(f.cargoCalled));
        const expected = selection === 'explicit' ? explicit : resolve(f.root, selection === 'environment' ? inherited : 'target');
        assert.equal(argv[argv.indexOf('--target-dir') + 1], expected);
        const receipt = JSON.parse(readFileSync(resolve(f.out, f.target, 'build.json')));
        assert.equal(receipt.targetDir, expected);
        assert.equal(receipt.profile, profile);
        assert.deepEqual(receipt.artifacts, []);
        assert.equal(existsSync(expected), false, 'entry must not clean or populate the persistent cache itself');
      } finally { f.remove(); }
    }
  }
});
