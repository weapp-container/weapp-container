import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SDK_RELEASE_VERSION } from './sdk-current-release.mjs';
import { reviewedSdkSource } from './sdk-reviewed-sources.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, { version = 2, unrelated = false, fingerprint = false, changedWrapper = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sdk-published-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function git(args) {
    const result = spawnSync('git', ['-c', 'user.name=SDK Source Test', '-c', 'user.email=sdk-source@example.invalid', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(['init', '--quiet']);
  const source = new Map([['ORIGIN.json', '{"origin":"retained"}\n'], ['include/weapp/desktop.hpp', '// public wrapper\n']]);
  for (const [path, content] of source) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Historical extraction']);
  const base = git(['rev-parse', 'HEAD']);
  const files = [...source].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, size: Buffer.byteLength(content), sha256: sha(content), mode: '100644' }));
  const inventory = { schemaVersion: version, sdkVersion: SDK_RELEASE_VERSION, review: 'Review public wrapper sources',
    ...(version === 1 ? { sourceBaseCommit: base } : { sourceFilesSha256: fingerprint ? '0'.repeat(64) : sha(JSON.stringify(files)) }),
    historicalOrigin: { path: 'ORIGIN.json', sha256: sha(source.get('ORIGIN.json')) }, files };
  const bytes = JSON.stringify(inventory);
  writeFileSync(join(root, 'SOURCE-INVENTORY.json'), bytes);
  if (changedWrapper) writeFileSync(join(root, 'include/weapp/desktop.hpp'), '// unreviewed wrapper\n');
  git(['add', '.']);
  const tree = git(['write-tree']);
  const commit = git(['commit-tree', tree, ...(version === 1 && !unrelated ? ['-p', base] : []), '-m', 'Published source']);
  git(['update-ref', 'HEAD', commit]);
  return { root, commit, receipt: { sourceCommit: commit, sourceInventorySha256: sha(bytes) }, source, git };
}
test('a published root commit retains complete SDK source verification', t => {
  const f = fixture(t);
  assert.equal(f.git(['rev-list', '--count', 'HEAD']), '1');
  const reviewed = reviewedSdkSource('linux', f.receipt, { desktop: f.root });
  assert.equal(reviewed.wrappers.size, 1);
  assert.equal(reviewed.readSource('include/weapp/desktop.hpp').toString(), f.source.get('include/weapp/desktop.hpp'));
});
test('a matching producer receipt cannot authorize a changed reviewed-file fingerprint', t => {
  const f = fixture(t, { fingerprint: true });
  assert.throws(() => reviewedSdkSource('linux', f.receipt, { desktop: f.root }), /fingerprint mismatch/);
});
test('a standalone source inventory still binds wrapper bytes to the committed tree', t => {
  const f = fixture(t, { changedWrapper: true });
  assert.throws(() => reviewedSdkSource('linux', f.receipt, { desktop: f.root }), /wrapper differs/);
});
test('legacy source inventory remains accepted only with its original ancestry', t => {
  const f = fixture(t, { version: 1 });
  assert.equal(reviewedSdkSource('linux', f.receipt, { desktop: f.root }).wrappers.size, 1);
  const unrelated = fixture(t, { version: 1, unrelated: true });
  assert.throws(() => reviewedSdkSource('linux', unrelated.receipt, { desktop: unrelated.root }), /committed SDK source identity/);
});
