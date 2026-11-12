import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs';
import { prepareDesktopConsumerHarness } from './lib/sdk-desktop-consumer-harness.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['CMakeLists.txt', 'c_smoke.c', 'linux.cpp', 'macos.mm', 'showcase_smoke.hpp', 'smoke.hpp', 'wait.hpp', 'windows.cpp'];
function fixture(mutation) {
  const directory = mkdtempSync(resolve(tmpdir(), 'desktop-consumer-sources-')), sourceRoot = resolve(directory, 'source');
  mkdirSync(sourceRoot);
  const sources = new Map([['ORIGIN.json', '{}\n'], ['include/weapp/desktop.h', '// reviewed public wrapper\n'], ...names.map(name => [`consumer/${name}`, `// reviewed example ${name}\n`])]);
  if (mutation === 'missing') sources.delete('consumer/wait.hpp');
  if (mutation === 'foreign') sources.set('consumer/private.cpp', '// unreviewed example dependency\n');
  for (const [path, source] of sources) { mkdirSync(dirname(resolve(sourceRoot, path)), { recursive: true }); writeFileSync(resolve(sourceRoot, path), source); }
  function git(args) {
    const result = spawnSync('git', ['-C', sourceRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  }
  git(['init', '--quiet']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Reviewed finite fixture sources']);
  const sourceBaseCommit = git(['rev-parse', 'HEAD']);
  const files = [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([path, source]) => ({ path, sha256: mutation === 'bytes' && path === 'consumer/smoke.hpp' ? '0'.repeat(64) : sha(source), size: Buffer.byteLength(source), mode: '100644' }));
  const inventory = JSON.stringify({ schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, sourceBaseCommit, review: 'Explicit fixture for external consumer source closure', historicalOrigin: { path: 'ORIGIN.json', sha256: sha(sources.get('ORIGIN.json')) }, files });
  writeFileSync(resolve(sourceRoot, 'SOURCE-INVENTORY.json'), inventory);
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Record finite source inventory']);
  const receipt = { sourceCommit: git(['rev-parse', 'HEAD']), sourceInventorySha256: sha(inventory) };
  return { directory, sourceRoot, sources, receipt, remove() { rmSync(directory, { recursive: true, force: true }); } };
}

test('the independent desktop harness stages only exact committed examples and preserves its source identity', () => {
  const f = fixture(); try {
    writeFileSync(resolve(f.sourceRoot, 'consumer/smoke.hpp'), '// mutable checkout must not supply acceptance source');
    const destination = resolve(f.directory, 'harness');
    const result = prepareDesktopConsumerHarness({ sourceRoot: f.sourceRoot, receipt: f.receipt, destination });
    assert.equal(result.kind, 'external-reviewed-sdk-examples');
    assert.equal(result.sourceCommit, f.receipt.sourceCommit);
    assert.equal(result.sourceInventorySha256, f.receipt.sourceInventorySha256);
    assert.deepEqual(readdirSync(destination).sort(), names);
    for (const file of result.files) {
      assert.equal(readFileSync(resolve(destination, file.file), 'utf8'), f.sources.get(`consumer/${file.file}`));
      assert.equal(sha(readFileSync(resolve(destination, file.file))), file.sha256);
    }
    assert.throws(() => prepareDesktopConsumerHarness({ sourceRoot: f.sourceRoot, receipt: f.receipt, destination }), /EEXIST/);
    assert.equal(readFileSync(resolve(destination, 'smoke.hpp'), 'utf8'), f.sources.get('consumer/smoke.hpp'));
  } finally { f.remove(); }
});

test('missing, additional and incorrectly inventoried example sources cannot become an acceptance harness', () => {
  for (const mutation of ['missing', 'foreign', 'bytes', 'inventory']) {
    const f = fixture(mutation); try {
      if (mutation === 'inventory') f.receipt.sourceInventorySha256 = '0'.repeat(64);
      const destination = resolve(f.directory, 'must-not-stage');
      assert.throws(() => prepareDesktopConsumerHarness({ sourceRoot: f.sourceRoot, receipt: f.receipt, destination }), /explicit reviewed example list|differs from its reviewed inventory|inventory hash mismatch/);
      assert.equal(existsSync(destination), false);
    } finally { f.remove(); }
  }
});
