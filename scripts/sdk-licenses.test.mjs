import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicCrates = ['container-core', 'container-ir', 'container-bridge'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'sdk-licenses-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), text);
  };
  for (const file of ['sdk-licenses.mjs', 'lib/sdk-notice.mjs', 'lib/showcase-native-font.mjs']) {
    const destination = resolve(root, 'scripts', file);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolve(project, 'scripts', file), destination);
  }
  write('LICENSE', readFileSync(resolve(project, 'LICENSE'), 'utf8'));
  write('NOTICE', 'Fixture Apache runtime attribution.\n');
  const members = [...publicCrates, 'container-sdk-ffi', 'container-host-web', 'container-host-harmony', 'unused'];
  write('Cargo.toml', `[workspace]\nresolver = "2"\nmembers = ${JSON.stringify(members.map(name => `crates/${name}`))}\n`);
  for (const name of members) {
    const isPublic = publicCrates.includes(name);
    const dependencyNames = ['container-sdk-ffi', 'container-host-web', 'container-host-harmony'].includes(name) ? publicCrates : [];
    write(`crates/${name}/Cargo.toml`, `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`
      + (isPublic ? 'license = "MIT OR Apache-2.0"\n' : 'license = "Apache-2.0"\n')
      + '[features]\nfixture = []\n[dependencies]\n'
      + dependencyNames.map(dependency => `${dependency} = { path = "../${dependency}" }\n`).join(''));
    write(`crates/${name}/src/lib.rs`, '// Fixture metadata only; no compilation.\n');
    if (isPublic) for (const file of ['LICENSE-MIT', 'LICENSE-APACHE']) {
      cpSync(resolve(project, 'crates', name, file), resolve(root, 'crates', name, file));
    }
  }
  const lock = spawnSync('cargo', ['generate-lockfile', '--offline'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(lock.status, 0, lock.error?.message ?? lock.stderr);
  const output = resolve(root, 'notices');
  const run = () => spawnSync(process.execPath, ['scripts/sdk-licenses.mjs', '--target', 'aarch64-apple-darwin',
    '--features', 'fixture', '--out', output, '--offline'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  return { root, output, write, run };
}

test('collector preserves mixed local license grants and copies byte-bound notices from the actual Cargo graph', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const report = JSON.parse(readFileSync(resolve(f.output, 'licenses.json'), 'utf8'));
  assert.equal(report.packages.length, 4);
  assert.equal(report.packages.some(pkg => pkg.name === 'unused'), false);
  assert.deepEqual(report.features, ['fixture']);
  for (const name of publicCrates) {
    const pkg = report.packages.find(item => item.name === name);
    assert.equal(pkg.license, 'MIT OR Apache-2.0');
    assert.deepEqual(pkg.files.map(file => file.path).sort(),
      ['LICENSE-APACHE', 'LICENSE-MIT'].map(file => `${name}-0.1.0/${file}`));
    for (const file of pkg.files) {
      const bytes = readFileSync(resolve(f.output, file.path));
      assert.deepEqual(bytes, readFileSync(resolve(f.root, 'crates', name, file.path.split('/').pop())));
      assert.equal(file.sha256, sha256(bytes));
    }
  }
  const runtime = report.packages.find(pkg => pkg.name === 'container-sdk-ffi');
  assert.equal(runtime.license, 'Apache-2.0');
  assert.equal(runtime.files.length, 2);
  const terms = readFileSync(resolve(f.root, 'LICENSE'));
  assert.deepEqual(readFileSync(resolve(f.output, runtime.files[0].path)), terms);
  assert.equal(runtime.files[0].sha256, sha256(terms));
  for (const file of report.collector.sourceFiles) {
    assert.equal(file.sha256, sha256(readFileSync(resolve(f.root, file.path))));
  }
});

test('an external collector reads exact clean Web/Harmony source identities and keeps its own tool hashes', t => {
  const f = fixture(t);
  f.write('.gitignore', '/notices*/\n');
  for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Finite fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'finite license source']]) {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).stdout.trim();
  for (const packageName of ['container-host-web', 'container-host-harmony']) {
    const output = resolve(f.root, `notices-${packageName}`), result = spawnSync(process.execPath, [resolve(project, 'scripts/sdk-licenses.mjs'), '--source-root', f.root, '--package', packageName,
      '--target', packageName === 'container-host-web' ? 'wasm32-unknown-unknown' : 'aarch64-unknown-linux-ohos', '--features', 'fixture', '--out', output, '--offline'], { cwd: project, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(resolve(output, 'licenses.json')));
    assert.equal(report.package, packageName); assert.equal(report.packages.length, 4);
    assert.deepEqual(report.source, { sourceCommit, sourceDirty: false });
    for (const file of report.collector.sourceFiles) assert.equal(file.sha256, sha256(readFileSync(resolve(project, file.path))));
  }
  assert.equal(spawnSync('git', ['status', '--porcelain=v1'], { cwd: f.root, encoding: 'utf8' }).stdout, '');
});

test('missing permissive notices fail instead of substituting workspace terms or replacing an existing inventory', t => {
  const f = fixture(t);
  for (const file of ['LICENSE-MIT', 'LICENSE-APACHE']) rmSync(resolve(f.root, 'crates/container-core', file));
  f.write('notices/existing.txt', 'existing accepted inventory\n');
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing complete dependency notices: container-core/);
  assert.equal(readFileSync(resolve(f.output, 'existing.txt'), 'utf8'), 'existing accepted inventory\n');
  assert.deepEqual(readdirSync(f.output), ['existing.txt']);
  assert.equal(readdirSync(f.root).some(file => file.startsWith('notices.collect-')), false);
});

test('a local package without a license declaration does not inherit the runtime license', t => {
  const f = fixture(t);
  const manifest = resolve(f.root, 'crates/container-core/Cargo.toml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('license = "MIT OR Apache-2.0"\n', ''));
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing complete dependency notices: container-core/);
  assert.equal(existsSync(f.output), false);
});
