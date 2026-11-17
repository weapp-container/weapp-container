#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInputFile } from './showcase-ci-inputs.mjs';
import { verifyNativeProducerFiles } from './lib/sdk-current-release.mjs';
import { loadDistributionInput } from './lib/showcase-policy.mjs';
import { restoreRetainedNotices } from './lib/sdk-retained-notices.mjs';
import { hardenRetainedNative } from './sdk-native-harden-retained.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function reviewedNativeInput(value, key, platform, target) {
  assert.equal(value.schemaVersion, 1); assert.equal(value.repository, 'weapp-container/weapp-container');
  assert.match(key, /^[a-z0-9-]+$/);
  const input = Object.hasOwn(value.inputs, key) && value.inputs[key];
  assert.ok(input, 'Select an explicitly reviewed existing native input');
  assert.equal(input.platform, platform); assert.equal(input.target, target);
  assert.ok(['windows', 'linux'].includes(platform));
  assert.equal(input.nativeLayout, platform === 'linux' ? 'verified-runtime-archive' : 'complete-native-output');
  for (const number of [input.runId, input.artifactId, input.size]) assert.ok(Number.isSafeInteger(number) && number > 0);
  assert.ok(input.size <= 512 * 1024 ** 2);
  assert.equal(input.artifactName, `showcase-native-${platform}-${input.runId}-1`);
  assert.match(input.sha256, /^[a-f0-9]{64}$/); assert.match(input.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(input.distributionProfile, 'restricted-showcase'); assert.match(input.policySha256, /^[a-f0-9]{64}$/);
  assert.ok(typeof input.review === 'string' && input.review.length > 0);
  return input;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 ** 2, ...options });
  // Signed blob redirects and credentials must never enter CI diagnostics.
  if (result.error || result.status !== 0) throw Error(`Reviewed native input ${command} operation failed`);
  return result.stdout;
}
const unpack = String.raw`from pathlib import Path,PurePosixPath
import stat,sys,zipfile
archive,destination=Path(sys.argv[1]),Path(sys.argv[2])
with zipfile.ZipFile(archive) as z:
 entries=z.infolist()
 if len(entries)>20000 or sum(x.file_size for x in entries)>2*1024**3: raise ValueError('Oversized CI artifact')
 seen=set()
 for item in entries:
  name=item.filename;p=PurePosixPath(name)
  if not name or name.casefold() in seen or p.is_absolute() or '..' in p.parts or chr(92) in name or ':' in name or stat.S_ISLNK(item.external_attr>>16): raise ValueError('Unsafe CI artifact path')
  seen.add(name.casefold())
 destination.mkdir()
 z.extractall(destination)
`;
export async function restoreNativeInput({ key, platform, target, temporaryRoot = process.env.RUNNER_TEMP } = {}) {
  assert.ok(temporaryRoot, 'An explicit CI temporary directory is required');
  const lock = JSON.parse(readFileSync(resolve(root, 'scripts/fixtures/showcase-ci-native-inputs.lock.json')));
  const input = reviewedNativeInput(lock, key, platform, target);
  const expected = loadDistributionInput({ distributionProfile: 'restricted-showcase', showcasePolicy: resolve(root, 'artifacts/showcase/policy.json') });
  assert.equal(expected.policySha256, input.policySha256);
  const meta = JSON.parse(run('gh', ['api', `repos/${lock.repository}/actions/artifacts/${input.artifactId}`]));
  assert.equal(meta.id, input.artifactId); assert.equal(meta.name, input.artifactName); assert.equal(meta.expired, false);
  assert.equal(meta.size_in_bytes, input.size); assert.equal(meta.digest, `sha256:${input.sha256}`);
  assert.equal(meta.workflow_run.id, input.runId); assert.equal(meta.workflow_run.head_sha, input.sourceCommit);
  const retained = resolve(root, 'artifacts/showcase/retained-native-inputs', key);
  assert.ok(!existsSync(retained), 'Retained native input already exists'); mkdirSync(retained, { recursive: true });
  const zip = resolve(retained, 'original-actions-artifact.zip'), extracted = resolve(retained, 'original');
  writeFileSync(zip, run('gh', ['api', `repos/${lock.repository}/actions/artifacts/${input.artifactId}/zip`], { encoding: null, timeout: 180_000 }));
  verifyInputFile(zip, input);
  run(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', unpack, zip, extracted]);
  const metadataRoot = resolve(extracted, 'sdk/native', target), receiptBytes = readFileSync(resolve(metadataRoot, 'build.json'));
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.sourceCommit, input.sourceCommit);
  let original = metadataRoot, noticeRoot = resolve(extracted, 'sdk/licenses', target);
  if (input.nativeLayout === 'verified-runtime-archive') {
    const archiveDirectory = resolve(extracted, 'showcase/runtime-archives');
    original = resolve(retained, 'verified-original-runtime');
    const runtimeLock = JSON.parse(readFileSync(resolve(archiveDirectory, 'runtime-artifacts.lock.json')));
    const artifact = runtimeLock.artifacts.find(value => value.component === 'runtime' && value.platform === platform && value.arch === 'x86_64');
    assert.ok(artifact, 'Reviewed runtime archive lacks the exact Linux slice');
    const archive = resolve(archiveDirectory, artifact.fileName);
    assert.equal(lstatSync(archive).isFile(), true); assert.equal(lstatSync(archive).size, artifact.size); assert.equal(hash(readFileSync(archive)), artifact.sha256);
    const unpack = String.raw`from pathlib import Path
import sys,tarfile
archive,destination=Path(sys.argv[1]),Path(sys.argv[2])
with tarfile.open(archive,'r:gz') as tar:
 entries=tar.getmembers(); seen=set()
 for item in entries:
  name=item.name; path=Path(name)
  if not name or path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name or name.casefold() in seen or not (item.isfile() or item.isdir()): raise ValueError('Unsafe runtime archive')
  seen.add(name.casefold())
 destination.mkdir()
 tar.extractall(destination,filter='data')`;
    run(process.env.PYTHON || 'python3', ['-c', unpack, archive, original]);
    assert.equal(hash(readFileSync(resolve(original, 'build.json'))), hash(receiptBytes));
    noticeRoot = resolve(original, 'licenses');
  }
  verifyNativeProducerFiles(original, receipt, target, expected);
  const destination = resolve(root, 'artifacts/sdk/native', target);
  assert.ok(!existsSync(destination), 'Refusing to replace an existing native producer');
  const nativePostProcessing = platform === 'linux' ? hardenRetainedNative({ input: original, out: destination }) : null;
  if (!nativePostProcessing) {
    cpSync(original, destination, { recursive: true });
    assert.equal(hash(readFileSync(resolve(destination, 'build.json'))), hash(receiptBytes));
  }
  assert.equal(hash(readFileSync(resolve(original, 'build.json'))), hash(receiptBytes));
  const license = readFileSync(resolve(original, 'RUNTIME-LICENSE'));
  assert.equal(hash(license), hash(readFileSync(resolve(root, 'LICENSE'))));
  writeFileSync(resolve(destination, '../RUNTIME-LICENSE'), license, { flag: 'wx' });
  // The successful compile downloaded upstream Skia notices that metadata
  // alone cannot regenerate. Preserve that complete original inventory and
  // collector identity; only migrate its path separators after exact checks.
  const sourceRoot = resolve(temporaryRoot, `showcase-notices-${input.sourceCommit.slice(0, 12)}`);
  assert.ok(!existsSync(sourceRoot), 'Original notice source checkout already exists');
  run('git', ['worktree', 'add', '--detach', sourceRoot, input.sourceCommit]);
  const restored = { schemaVersion: 1, status: 'verified-prebuilt-native', key, ...input,
    originalProducerReceiptSha256: hash(receiptBytes), originalReceiptPreserved: true, sourceRoot, nativePostProcessing };
  writeFileSync(resolve(retained, 'restoration.json'), JSON.stringify(restored, null, 2) + '\n');
  restored.noticeMigration = restoreRetainedNotices(noticeRoot, resolve(root, 'artifacts/sdk/licenses', target), { sourceRoot, nativeReceipt: receipt });
  writeFileSync(resolve(retained, 'restoration.json'), JSON.stringify(restored, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sourceRoot=${sourceRoot}\n`);
  return restored;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [key, platform, target] = process.argv.slice(2);
  if (key === '--cleanup') {
    assert.ok(process.env.RUNNER_TEMP, 'An explicit CI temporary directory is required');
    const file = resolve(root, 'artifacts/showcase/retained-native-inputs', platform, 'restoration.json');
    if (existsSync(file)) {
      const restored = JSON.parse(readFileSync(file));
      const expectedRoot = resolve(process.env.RUNNER_TEMP, `showcase-notices-${restored.sourceCommit.slice(0, 12)}`);
      assert.equal(restored.sourceRoot, expectedRoot);
      run('git', ['worktree', 'remove', expectedRoot]);
    }
  } else console.log(JSON.stringify(await restoreNativeInput({ key, platform, target })));
}
