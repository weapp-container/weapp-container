#!/usr/bin/env node
// Coordinates reviewed source and existing producers; never publishes a release.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RELEASE_REPOSITORY, RELEASE_SDKS, assertCandidate, assertCompleteRelease, assertProductionRun, assertWrapperReceipt, checksReady, releaseNotes, workflowChecks } from './lib/runtime-release.mjs';
import { NATIVE_TARGETS } from './lib/sdk-native-features.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 });
const api = path => JSON.parse(run('gh', ['api', path]));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2) + '\n'); };
const candidatePath = resolve(root, 'artifacts/release/candidate.json');
const policy = json(resolve(root, 'tools/runtime-artifacts/policy.json'));
const pins = sha => Object.fromEntries(RELEASE_SDKS.map(sdk => {
  const entry = run('git', ['ls-tree', sha, `sdk/${sdk}`]);
  assert.match(entry, /^160000 commit [a-f0-9]{40}\t/);
  return [sdk, entry.split(/\s+/)[2]];
}));
const output = (name, value) => {
  assert.ok(!/[\r\n]/.test(String(value)));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
};
const summary = text => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n'); };
function requireAbsent(tag) {
  const pages = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${RELEASE_REPOSITORY}/releases?per_page=100`]));
  assert.ok(Array.isArray(pages) && pages.every(Array.isArray));
  assert.ok(!pages.flat().some(item => item.tag_name === tag), 'Release or visible draft already exists');
  try { run('gh', ['api', `repos/${RELEASE_REPOSITORY}/git/ref/tags/${tag}`]); }
  catch (error) { if (/\(HTTP 404\)/.test(String(error.stderr))) return; throw error; }
  throw Error('Release tag already exists');
}
function localCandidate() {
  const candidate = assertCandidate(json(candidatePath), policy, pins('HEAD'));
  assert.equal(run('git', ['rev-parse', 'HEAD']).trim(), candidate.sourceCommit);
  return candidate;
}
async function prepare() {
  assert.equal(process.env.GITHUB_REPOSITORY, RELEASE_REPOSITORY);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Prepare releases on main only');
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']).trim(), '', 'Candidate source must be clean');
  const sourceCommit = run('git', ['rev-parse', 'HEAD']).trim(), fixed = pins('HEAD');
  const { SDK_RELEASE_VERSION } = await import('./lib/sdk-current-release.mjs');
  assert.equal(SDK_RELEASE_VERSION, policy.runtimeVersion);
  const sdks = {};
  for (const sdk of RELEASE_SDKS) {
    const directory = resolve(root, 'sdk', sdk), pkg = json(join(directory, 'package.json'));
    assert.equal(run('git', ['rev-parse', 'HEAD'], directory).trim(), fixed[sdk]);
    if (sdk !== 'contract') {
      const { verifySourceInventory } = await import(pathToFileURL(join(directory, 'tools/source-inventory.mjs')));
      assert.equal(verifySourceInventory(directory).sdkVersion, policy.runtimeVersion);
      const { SDK_VERSION } = await import(pathToFileURL(join(directory, 'tools/native-input.mjs')));
      assert.equal(SDK_VERSION, policy.runtimeVersion);
    }
    sdks[sdk] = { repository: `weapp-container/sdk-${sdk}`, commit: fixed[sdk], version: pkg.version };
  }
  const candidate = assertCandidate({ schemaVersion: 1, repository: RELEASE_REPOSITORY, prepareRelease: true,
    runtimeVersion: policy.runtimeVersion, publishedRuntimeVersion: policy.publishedRuntimeVersion, abiVersion: policy.abiVersion,
    sourceCommit, runtimeRunId: process.env.GITHUB_RUN_ID, sdks }, policy, fixed);
  requireAbsent(`runtime-v${candidate.runtimeVersion}`);
  save(candidatePath, candidate);
  summary(`Candidate **${candidate.runtimeVersion}**, core \`${sourceCommit}\`. Final public publication is manual.`);
}
async function select(id, automatic) {
  assert.match(id ?? '', /^[1-9]\d*$/);
  const production = assertProductionRun(api(`repos/${RELEASE_REPOSITORY}/actions/runs/${id}`));
  const pages = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${RELEASE_REPOSITORY}/actions/runs/${id}/artifacts?per_page=100`]));
  const markers = pages.flatMap(page => page.artifacts).filter(item => item.name === 'release-candidate' && !item.expired);
  if (automatic && !markers.length) { output('enabled', 'false'); return; }
  assert.equal(markers.length, 1, 'Production needs one non-expired release-candidate artifact');
  run('gh', ['run', 'download', id, '--repo', RELEASE_REPOSITORY, '--name', 'release-candidate', '--dir', dirname(candidatePath)]);
  const candidate = json(candidatePath);
  assert.equal(candidate.sourceCommit, production.head_sha);
  assert.equal(candidate.runtimeRunId, id);
  run('git', ['fetch', '--no-tags', 'origin', production.head_sha]);
  const producerPolicy = JSON.parse(run('git', ['show', `${production.head_sha}:tools/runtime-artifacts/policy.json`]));
  assertCandidate(candidate, producerPolicy, pins(production.head_sha));
  requireAbsent(`runtime-v${candidate.runtimeVersion}`);
  const deadline = Date.now() + 90 * 60_000;
  while (true) {
    const pages = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${RELEASE_REPOSITORY}/actions/runs?head_sha=${production.head_sha}&per_page=100`]));
    const runs = pages.flatMap(page => page.workflow_runs);
    if (checksReady(runs, production.head_sha)) break;
    assert.ok(workflowChecks(runs, production.head_sha).every(item => !item || item.status !== 'completed' || item.conclusion === 'success'),
      'Source, documentation or security checks failed/cancelled at the production SHA; resolve and rerun before preparing the draft');
    assert.ok(Date.now() < deadline, 'Timed out waiting for successful source, documentation and security checks at the production SHA');
    console.log('Waiting for source, documentation and security checks at the exact production SHA');
    await new Promise(done => setTimeout(done, 30_000));
  }
  output('enabled', 'true'); output('source', candidate.sourceCommit); output('version', candidate.runtimeVersion);
}
function targetsFor(platform) {
  const targets = Object.keys(NATIVE_TARGETS).filter(target => platform === 'all' || NATIVE_TARGETS[target][0] === platform);
  assert.ok(targets.length, 'Unknown native platform');
  return targets;
}
function stage(platform) {
  const candidate = localCandidate();
  const production = assertProductionRun(api(`repos/${RELEASE_REPOSITORY}/actions/runs/${candidate.runtimeRunId}`));
  assert.equal(production.head_sha, candidate.sourceCommit);
  const targets = targetsFor(platform);
  for (const target of targets) for (const kind of ['native', 'licenses']) {
    const destination = resolve(root, 'artifacts/sdk', kind, target);
    run('gh', ['run', 'download', candidate.runtimeRunId, '--repo', RELEASE_REPOSITORY, '--name', `sdk-${kind}-${target}`, '--dir', destination]);
  }
  copyFileSync(resolve(root, 'artifacts/sdk/native', targets[0], 'RUNTIME-LICENSE'), resolve(root, 'artifacts/sdk/native/RUNTIME-LICENSE'));
}
async function assemble() {
  const candidate = localCandidate();
  const native = resolve(root, 'artifacts/sdk/native'), licenses = resolve(root, 'artifacts/sdk/licenses'), out = resolve(root, 'artifacts/release/files');
  run(process.execPath, ['scripts/public-runtime-inputs.mjs', native]);
  const pack = args => run(process.execPath, ['tools/runtime-artifacts/tools/package-artifacts.mjs', '--source-commit', candidate.sourceCommit,
    '--native-root', native, '--licenses-root', licenses, '--out-dir', out, ...args]);
  pack([]);
  for (const [sdk, platform, arch, installation] of [
    ['android', 'android', 'universal', 'android'], ['ios', 'ios', 'universal', 'ios'],
    ['desktop', 'macos', 'universal', 'macos'], ['desktop', 'linux', 'x86_64', 'linux'], ['desktop', 'windows', 'x86_64', 'windows'],
  ]) {
    const directory = resolve(root, 'artifacts/wrappers', installation);
    const receipt = json(join(directory, { android: 'distribution.json', ios: 'build.json', desktop: 'package.json' }[sdk]));
    assertWrapperReceipt(receipt, sdk, candidate, targetsFor(platform));
    const args = ['--component', `${sdk}-sdk`, '--platform', platform, '--arch', arch, '--install-dir', directory];
    if (arch === 'universal') args.push('--architectures', platform === 'android' ? 'arm64-v8a,x86_64' : platform === 'ios' ? 'arm64-device,arm64-simulator,x86_64-simulator' : 'arm64,x86_64');
    pack(args);
  }
  const manifest = json(join(out, 'manifest.json'));
  assertCompleteRelease(manifest);
  const { verifyRelease } = await import('../tools/runtime-artifacts/tools/publish.mjs');
  await verifyRelease(out, { complete: true });
  run(process.execPath, ['tools/runtime-artifacts/tools/verify-offline.mjs', '--contract-dir', resolve(root, 'sdk/contract'),
    '--release-dir', out, '--work-dir', resolve(root, 'artifacts/offline'), '--report', resolve(root, 'artifacts/offline/report.json')]);
}

async function notes() {
  const candidate = localCandidate();
  const generated = JSON.parse(run('gh', ['api', `repos/${RELEASE_REPOSITORY}/releases/generate-notes`, '--method', 'POST',
    '-f', `tag_name=runtime-v${candidate.runtimeVersion}`, '-f', `target_commitish=${candidate.sourceCommit}`,
    '-f', `previous_tag_name=runtime-v${candidate.publishedRuntimeVersion}`]));
  writeFileSync(resolve(root, 'artifacts/release/notes.md'), releaseNotes(candidate, generated.body));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare' && !args.length) return prepare();
  if (command === 'select' && (args.length === 1 || args.length === 2 && args[1] === '--automatic')) return select(args[0], args[1] === '--automatic');
  if (command === 'stage' && args.length === 1) return stage(args[0]);
  if (command === 'assemble' && !args.length) return assemble();
  if (command === 'notes' && !args.length) return notes();
  throw Error('Use prepare | select RUN_ID [--automatic] | stage PLATFORM | assemble | notes');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
