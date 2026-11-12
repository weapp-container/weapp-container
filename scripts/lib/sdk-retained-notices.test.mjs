import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { retainedNoticePath, restoreRetainedNotices } from './sdk-retained-notices.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'retained-notices-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = resolve(root, 'source'), input = resolve(root, 'original'), output = resolve(root, 'portable');
  mkdirSync(sourceRoot); mkdirSync(input);
  const collector = ['scripts/sdk-licenses.mjs', 'scripts/lib/sdk-notice.mjs', 'scripts/lib/showcase-native-font.mjs'].map(path => {
    const file = resolve(sourceRoot, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `// original ${path}\n`);
    return { path, sha256: sha(readFileSync(file)) };
  });
  const git = args => { const result = spawnSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git(['init', '--quiet']); git(['add', '.']); git(['-c', 'user.name=Notice fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'original collector']);
  const nativeReceipt = { sourceCommit: git(['rev-parse', 'HEAD']), target: 'x86_64-pc-windows-msvc', features: ['quickjs-native', 'restricted-showcase'] };
  const notice = resolve(input, 'skia-bindings-1/vendor/LICENSE'); mkdirSync(dirname(notice), { recursive: true }); writeFileSync(notice, 'Complete original upstream notice\n');
  const identity = { sourceCommit: nativeReceipt.sourceCommit, sourceDirty: false };
  const report = { schemaVersion: 1, package: 'container-sdk-ffi', target: nativeReceipt.target, features: nativeReceipt.features, source: identity, sourceAfter: identity,
    collector: { algorithm: 'sha256', sourceFiles: collector }, packages: [{ name: 'skia-bindings', files: [{ path: 'skia-bindings-1/vendor\\LICENSE', sha256: sha(readFileSync(notice)) }] }] };
  writeFileSync(resolve(input, 'README.txt'), 'Actual compiled dependency notices\n');
  writeFileSync(resolve(input, 'licenses.json'), JSON.stringify(report));
  return { root, input, output, sourceRoot, nativeReceipt, report, notice };
}
test('a portable migration retains exact original compiled notices, source and collector identities', t => {
  const f = fixture(t), original = readFileSync(resolve(f.input, 'licenses.json'));
  const migration = restoreRetainedNotices(f.input, f.output, f);
  assert.equal(migration.originalInventorySha256, sha(original)); assert.equal(migration.originalCollectorPreserved, true);
  assert.deepEqual(readFileSync(resolve(f.input, 'licenses.json')), original);
  assert.deepEqual(readFileSync(resolve(f.output, 'skia-bindings-1/vendor/LICENSE')), readFileSync(f.notice));
  const portable = JSON.parse(readFileSync(resolve(f.output, 'licenses.json')));
  assert.equal(portable.packages[0].files[0].path, 'skia-bindings-1/vendor/LICENSE');
  assert.deepEqual(portable.collector, f.report.collector); assert.deepEqual(portable.source, f.report.source);
});
test('a retained compiled notice must match the reviewed original inventory hash before any output', t => {
  const f = fixture(t); writeFileSync(f.notice, 'altered');
  assert.throws(() => restoreRetainedNotices(f.input, f.output, f)); assert.equal(existsSync(f.output), false);
  for (const path of ['../LICENSE', 'a/../LICENSE', 'C:\\LICENSE', '/LICENSE', 'a//LICENSE', 'a\\..\\LICENSE', 'a/COPYING.rs']) assert.throws(() => retainedNoticePath(path));
});
