#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadDistributionInput } from './lib/showcase-policy.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateInputs(value, { requireReviewed = true } = {}) {
  assert.equal(value.schemaVersion, 1); assert.equal(value.runtimeVersion, '0.1.0-preview.6.0');
  assert.equal(value.repository, 'weapp-container/weapp-container');
  if (requireReviewed) assert.equal(value.reviewStatus, 'reviewed-final-pack', 'Final pack review is required before native compilation');
  assert.ok(Array.isArray(value.sources) && value.sources.length === 2);
  assert.deepEqual(value.sources.map(source => source.path).sort(), ['sdk/contract', 'sdk/desktop']);
  assert.ok(value.font && value.font.license, 'Reviewed font and its license are required');
  assert.equal(value.font.path, 'fonts/NotoSansSC.ttf');
  assert.equal(value.font.license.path, 'fonts/OFL.txt');
  assert.equal(value.font.sha256, 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da');
  assert.equal(value.font.license.sha256, '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9');
  for (const item of [value.pack, ...value.sources]) {
    assert.match(item.releaseTag, /^showcase-v[0-9A-Za-z.-]+$/);
    assert.equal(basename(item.fileName), item.fileName); assert.match(item.fileName, /^[A-Za-z0-9._-]+$/);
  }
  for (const item of [value.pack, value.font, value.font.license, ...value.sources]) {
    assert.ok(Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 64 * 1024 ** 2);
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
  }
  for (const source of value.sources) {
    assert.equal(source.repository, `weapp-container/${source.path.replace('/', '-')}`);
    assert.match(source.sourceCommit, /^[a-f0-9]{40}$/); assert.ok(source.fileName.endsWith('.bundle'));
  }
  assert.match(value.pack.packRoot, /^[a-f0-9]{64}$/); assert.match(value.pack.policySha256, /^[a-f0-9]{64}$/);
  return value;
}
export function verifyInputFile(path, expected) {
  const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.size, expected.size, 'Private CI input size mismatch');
  assert.equal(hash(readFileSync(path)), expected.sha256, 'Private CI input SHA-256 mismatch');
  return path;
}
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout.trim();
}
export async function prepareInputs({ lockPath = resolve(root, 'scripts/fixtures/showcase-ci-inputs.lock.json'), offline } = {}) {
  const lockBytes = readFileSync(lockPath), lock = validateInputs(JSON.parse(lockBytes));
  const out = resolve(root, 'artifacts/showcase'), downloads = resolve(out, 'downloads'); mkdirSync(downloads, { recursive: true });
  const obtain = item => {
    const path = resolve(offline || downloads, item.fileName);
    if (!existsSync(path)) run('gh', ['release', 'download', item.releaseTag, '--repo', lock.repository,
      '--pattern', item.fileName, '--dir', downloads]);
    return verifyInputFile(path, item);
  };
  for (const source of lock.sources) {
    assert.equal(run('git', ['rev-parse', `HEAD:${source.path}`]), source.sourceCommit, 'CI source bundle differs from committed SDK gitlink');
    const bundle = obtain(source), destination = resolve(root, source.path);
    assert.ok(!existsSync(destination) || readdirSync(destination).length === 0, 'Refusing to replace a nonempty SDK source checkout');
    run('git', ['bundle', 'verify', bundle]);
    run('git', ['clone', '--no-checkout', bundle, destination]);
    run('git', ['checkout', '--detach', source.sourceCommit], destination);
    assert.equal(run('git', ['rev-parse', 'HEAD'], destination), source.sourceCommit);
  }
  const archive = obtain(lock.pack), input = resolve(out, 'input');
  run(process.env.PYTHON || 'python3', [resolve(root, 'sdk/contract/tools/unpack-runtime.py'), '--archive', archive,
    '--destination', input, '--sha256', lock.pack.sha256, '--identity-json', JSON.stringify({ packRoot: lock.pack.packRoot, policySha256: lock.pack.policySha256 })]);
  const fonts = resolve(out, 'fonts'); mkdirSync(fonts, { recursive: true });
  copyFileSync(verifyInputFile(resolve(input, lock.font.path), lock.font), resolve(fonts, 'NotoSansSC.ttf'));
  copyFileSync(verifyInputFile(resolve(input, lock.font.license.path), lock.font.license), resolve(fonts, 'OFL.txt'));
  // Linux native acceptance deliberately has no system font directories. The
  // shipped restricted runtime must draw using its compiled reviewed resource.
  writeFileSync(resolve(out, 'no-system-fonts.conf'), '<?xml version="1.0"?>\n<fontconfig></fontconfig>\n');
  const distribution = loadDistributionInput({ distributionProfile: 'restricted-showcase', showcasePolicy: resolve(input, 'policy.json') });
  assert.equal(distribution.policySha256, lock.pack.policySha256);
  assert.deepEqual(distribution.policy.allowedPackRoots, [lock.pack.packRoot]);
  const { copyPack } = await import('../sdk/desktop/tools/native-input.mjs');
  assert.equal(copyPack(resolve(input, 'pack'), resolve(out, 'verified-pack')), lock.pack.packRoot);
  writeFileSync(resolve(out, 'policy.json'), distribution.canonical);
  run(process.execPath, [resolve(root, 'sdk/contract/fixtures/make-acceptance-pack.mjs'), '--out', resolve(out, 'foreign-pack')]);
  const receipt = { schemaVersion: 1, status: 'verified-inputs', sourceCommit: run('git', ['rev-parse', 'HEAD']),
    inputsLockSha256: hash(lockBytes), packRoot: lock.pack.packRoot, policySha256: lock.pack.policySha256,
    font: { file: 'fonts/NotoSansSC.ttf', size: lock.font.size, sha256: lock.font.sha256,
      licenseFile: 'fonts/OFL.txt', licenseSha256: lock.font.license.sha256 },
    sources: lock.sources.map(({ path, sourceCommit, sha256 }) => ({ path, sourceCommit, bundleSha256: sha256 })) };
  writeFileSync(resolve(out, 'inputs-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await prepareInputs())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
