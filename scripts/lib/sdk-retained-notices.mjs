import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNoticeFileName } from './sdk-notice.mjs';
import { captureNativeSource } from './sdk-current-release.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function retainedNoticePath(value) {
  assert.ok(typeof value === 'string' && value && !/^[\\/]/.test(value) && !/[:\x00-\x1f\x7f]/.test(value), 'Invalid original notice identity');
  const parts = value.split(/[\\/]/);
  assert.ok(parts.every(part => part && part !== '.' && part !== '..'), 'Invalid original notice component');
  assert.ok(isNoticeFileName(parts.at(-1)), 'Original inventory may contain notices only');
  return parts.join('/');
}
function regular(base, file) {
  let current = base;
  assert.ok(!lstatSync(current).isSymbolicLink());
  for (const part of file.split('/')) {
    current = resolve(current, part);
    assert.ok(!lstatSync(current).isSymbolicLink(), 'Original notice symlinks are forbidden');
  }
  assert.ok(lstatSync(current).isFile());
  return current;
}
export function restoreRetainedNotices(source, destination, { sourceRoot, nativeReceipt } = {}) {
  assert.equal(existsSync(destination), false, 'Refusing to replace a notice inventory');
  assert.deepEqual(captureNativeSource(sourceRoot), { sourceCommit: nativeReceipt.sourceCommit, sourceDirty: false });
  const originalBytes = readFileSync(regular(source, 'licenses.json')), report = JSON.parse(originalBytes);
  assert.equal(report.schemaVersion, 1); assert.equal(report.package, 'container-sdk-ffi'); assert.equal(report.target, nativeReceipt.target);
  for (const identity of [report.source, report.sourceAfter]) assert.deepEqual(identity, { sourceCommit: nativeReceipt.sourceCommit, sourceDirty: false });
  assert.deepEqual([...report.features].sort(), [...nativeReceipt.features].sort());
  const collectorFiles = ['scripts/sdk-licenses.mjs', 'scripts/lib/sdk-notice.mjs', 'scripts/lib/showcase-native-font.mjs'];
  assert.deepEqual(report.collector.sourceFiles.map(file => file.path).sort(), collectorFiles.sort());
  for (const file of report.collector.sourceFiles) assert.equal(file.sha256, sha(readFileSync(regular(sourceRoot, file.path))));
  assert.ok(Array.isArray(report.packages) && report.packages.length > 0);
  const accepted = new Map(), copies = [];
  for (const pkg of report.packages) {
    assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'Complete original dependency notices required');
    for (const file of pkg.files) {
      const path = retainedNoticePath(file.path), key = path.toLowerCase();
      assert.equal(accepted.has(key), false, 'Duplicate portable original notice'); accepted.set(key, path);
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      const input = regular(source, path); assert.equal(sha(readFileSync(input)), file.sha256);
      copies.push({ input, path }); file.path = path;
    }
  }
  const inventoryFiles = new Set(['licenses.json', 'README.txt', ...accepted.values()]);
  function inspect(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) inspect(resolve(directory, entry.name), path + '/');
      else assert.ok(entry.isFile() && inventoryFiles.has(path), 'Unlisted file in original dependency notices');
    }
  }
  inspect(source);
  mkdirSync(destination, { recursive: true });
  for (const file of copies) { const output = resolve(destination, file.path); mkdirSync(dirname(output), { recursive: true }); copyFileSync(file.input, output); }
  copyFileSync(regular(source, 'README.txt'), resolve(destination, 'README.txt'));
  report.portablePathMigration = { schemaVersion: 1, algorithm: 'original-notice-paths-to-posix-v1',
    originalInventorySha256: sha(originalBytes), originalCollectorPreserved: true,
    transformerSha256: sha(readFileSync(fileURLToPath(import.meta.url))), noticeFiles: copies.length };
  writeFileSync(resolve(destination, 'licenses.json'), JSON.stringify(report, null, 2) + '\n');
  return report.portablePathMigration;
}
