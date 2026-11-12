import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSourceTree, sourceFinding } from './check-open-source.mjs';

test('rejects private state, signing material, raw archives and oversized files', () => {
  for (const path of ['x/.gradle/cache', '.env.production', 'signing/distribution.p12', 'docs/host-services/evidence/raw.json']) assert.ok(sourceFinding(path, Buffer.from('x')), path);
  assert.ok(sourceFinding('large.bin', Buffer.alloc(10 * 1024 * 1024 + 1)));
  assert.ok(sourceFinding('key.txt', Buffer.from(['-----BEGIN', 'PRIVATE KEY-----'].join(' '))));
});

test('preserves reviewed dependencies, example settings and small regression fixtures', () => {
  for (const path of ['.env.example', 'conformance/recipes/template-format-dependencies/htmlparser2/node_modules/a/LICENSE', 'scripts/fixtures/input.json']) assert.equal(sourceFinding(path, Buffer.from('source')), null, path);
});

test('rejects broken and escaping links in the tracked public tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'container-public-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    for (const name of ['LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md']) writeFileSync(join(root, name), 'policy');
    symlinkSync('missing', join(root, 'broken'));
    symlinkSync(tmpdir(), join(root, 'outside'));
    const report = auditSourceTree(root);
    assert.ok(report.findings.some(row => row.path === 'broken' && row.reason === 'broken symlink'));
    assert.ok(report.findings.some(row => row.path === 'outside' && /escapes/.test(row.reason)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
