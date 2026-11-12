import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifySubmodules } from './verify-submodule.mjs';

test('verifies every staged gitlink, detects missing SDK checkout and stale commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'container-submodule-'));
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(root, ['init', '-q']);
    const child = join(root, 'sdk');
    git(root, ['init', '-q', child]);
    const commit = () => {
      git(child, ['add', '.']);
      git(child, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
      return git(child, ['rev-parse', 'HEAD']);
    };
    writeFileSync(join(child, 'source'), 'one');
    const first = commit();
    writeFileSync(join(root, '.gitmodules'), '[submodule "sdk"]\n path = sdk\n url = https://github.com/example/sdk.git\n');
    git(root, ['add', '.gitmodules']);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${first},sdk`]);
    assert.equal(verifySubmodules(root).verified.length, 1);
    assert.deepEqual(verifySubmodules(root).findings, []);
    writeFileSync(join(child, 'source'), 'two');
    commit();
    assert.match(verifySubmodules(root).findings[0].reason, /commit mismatch/);
    git(root, ['config', '-f', '.gitmodules', 'submodule.sdk.url', 'git@github.com:example/sdk.git']);
    assert.match(verifySubmodules(root).findings[0].reason, /HTTPS/);
    rmSync(join(child, '.git'), { recursive: true, force: true });
    assert.ok(verifySubmodules(root).findings.some(row => /not initialized/.test(row.reason)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
