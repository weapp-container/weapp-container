import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RELEASE_REPOSITORY, RELEASE_SDKS, RELEASE_ARTIFACTS, REQUIRED_WORKFLOWS, assertCandidate, assertCoreVersions, assertCompleteRelease,
  assertProductionRun, assertWrapperReceipt, checksReady, releaseNotes } from './lib/runtime-release.mjs';
import { downloadAnonymousAsset } from './runtime-release-published.mjs';
import { createHash } from 'node:crypto';

const sha = 'a'.repeat(40), sdkSha = 'b'.repeat(40);
const policy = { runtimeVersion: '0.1.0-preview.7.1', publishedRuntimeVersion: '0.1.0-preview.7.0', contractVersion: '0.1.0-preview.7.0', abiVersion: 1 };
const candidate = () => ({ schemaVersion: 1, repository: RELEASE_REPOSITORY, prepareRelease: true, ...policy,
  sourceCommit: sha, runtimeRunId: '123', sdks: Object.fromEntries(RELEASE_SDKS.map(sdk => [sdk,
    { repository: `weapp-container/sdk-${sdk}`, commit: sdkSha, version: sdk === 'contract' ? policy.contractVersion : policy.runtimeVersion }])) });
const production = () => ({ repository: { full_name: RELEASE_REPOSITORY }, head_repository: { full_name: RELEASE_REPOSITORY },
  head_branch: 'main', event: 'workflow_dispatch', path: '.github/workflows/public-native.yml', status: 'completed', conclusion: 'success', head_sha: sha, id: 123 });
test('Rust package and lock versions agree before compiling a new C ABI candidate', async () => {
  const crates = ['container-sdk', 'container-sdk-ffi'];
  const manifests = Object.fromEntries(await Promise.all(crates.map(async crate => [crate,
    await readFile(new URL(`../crates/${crate}/Cargo.toml`, import.meta.url), 'utf8')])));
  const lock = await readFile(new URL('../Cargo.lock', import.meta.url), 'utf8');
  assertCoreVersions(manifests, lock, policy.runtimeVersion);
  for (const crate of crates) {
    assert.throws(() => assertCoreVersions({ ...manifests, [crate]: manifests[crate].replace(policy.runtimeVersion, policy.publishedRuntimeVersion) }, lock, policy.runtimeVersion), /candidate version/);
    assert.throws(() => assertCoreVersions(manifests, lock.replace(`name = "${crate}"\nversion = "${policy.runtimeVersion}"`, `name = "${crate}"\nversion = "${policy.publishedRuntimeVersion}"`), policy.runtimeVersion), /Cargo.lock version/);
  }
});
function manifest() {
  return { artifacts: RELEASE_ARTIFACTS.map(([component, platform, arch], i) => ({ component, platform, arch, fileName: `archive-${i}.tar.gz`,
    ...(arch === 'universal' ? { architectures: platform === 'ios' ? ['arm64-device', 'arm64-simulator', 'x86_64-simulator'] : platform === 'android' ? ['arm64-v8a', 'x86_64'] : ['arm64', 'x86_64'] } : {}) })) };
}
test('candidate version can advance without changing the published contract or locks', () => {
  const value = candidate();
  assert.equal(assertCandidate(value, policy), value);
  assert.notEqual(value.runtimeVersion, value.publishedRuntimeVersion);
  for (const change of [v => v.sdks.ios.version = policy.publishedRuntimeVersion, v => v.sdks.desktop.commit = 'main',
    v => v.prepareRelease = false, v => v.runtimeVersion = '1.0.0', v => v.sdks.contract.repository = 'other/repo']) {
    const invalid = candidate(); change(invalid); assert.throws(() => assertCandidate(invalid, policy));
  }
  assert.throws(() => assertCandidate(value, policy, Object.fromEntries(RELEASE_SDKS.map(sdk => [sdk, sha]))), /gitlink/);
});
test('only successful manually requested main production from this repository is accepted', () => {
  assertProductionRun(production());
  for (const patch of [{ repository: { full_name: 'fork/core' } }, { head_repository: { full_name: 'fork/core' } },
    { head_branch: 'feature' }, { event: 'pull_request' }, { path: '.github/workflows/ci.yml' }, { conclusion: 'failure' },
    { conclusion: 'cancelled' }, { status: 'in_progress' }, { head_sha: 'main' }]) assert.throws(() => assertProductionRun({ ...production(), ...patch }));
});
test('source, documentation and security must all succeed on the exact production SHA', () => {
  const runs = REQUIRED_WORKFLOWS.map((file, i) => ({ ...production(), id: i + 1, path: `.github/workflows/${file}`, event: 'push' }));
  assert.equal(checksReady(runs, sha), true);
  assert.equal(checksReady(runs.slice(1), sha), false);
  assert.equal(checksReady(runs, sdkSha), false);
  for (const patch of [{ conclusion: 'failure' }, { status: 'in_progress' }, { event: 'pull_request' },
    { head_repository: { full_name: 'fork/core' } }]) assert.equal(checksReady([{ ...runs[0], ...patch }, ...runs.slice(1)], sha), false);
  assert.equal(checksReady([...runs, { ...runs[0], id: 100, conclusion: 'cancelled' }], sha), false);
});
test('release rejects missing, duplicate, substituted and incomplete universal archives', () => {
  assertCompleteRelease(manifest());
  for (const change of [v => v.artifacts.pop(), v => v.artifacts[13] = v.artifacts[12],
    v => v.artifacts[0].arch = 'other', v => v.artifacts[9].architectures.pop(), v => v.artifacts[0].fileName = v.artifacts[1].fileName]) {
    const invalid = manifest(); change(invalid); assert.throws(() => assertCompleteRelease(invalid));
  }
});
test('wrapper consumers are bound to both pinned SDK and original runtime source', () => {
  const wrapper = () => ({ schemaVersion: 1, sdkVersion: policy.runtimeVersion, sourceCommit: sdkSha, sourceDirty: false,
    status: 'verified', checks: [{ exitCode: 0 }], native: [{ target: 'linux', sdkVersion: policy.runtimeVersion, sourceCommit: sha, sourceDirty: false, distributionProfile: 'full' }] });
  assertWrapperReceipt(wrapper(), 'desktop', candidate(), ['linux']);
  for (const change of [v => v.sourceCommit = sha, v => v.sourceDirty = true, v => v.status = 'packaged',
    v => v.checks[0].exitCode = 1, v => v.native[0].sourceCommit = sdkSha, v => v.native[0].distributionProfile = 'restricted-showcase']) {
    const invalid = wrapper(); change(invalid); assert.throws(() => assertWrapperReceipt(invalid, 'desktop', candidate(), ['linux']));
  }
});
test('notes describe checks and limits using fixed sources', () => {
  const text = releaseNotes(candidate(), 'Reviewed changes');
  for (const expected of [sha, sdkSha, 'Reviewed changes', '14 archives', 'physical-device', 'Maven Central']) assert.ok(text.includes(expected));
});
test('published assets download anonymously with bounded size and independent digest verification', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-public-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('authored release fixture');
  const asset = { name: 'manifest.json', state: 'uploaded', size: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    browser_download_url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/runtime-vtest/manifest.json` };
  let calls = 0;
  const fetchImpl = async (url, options) => { calls++; assert.equal(url, asset.browser_download_url); assert.equal(options.headers, undefined); return new Response(bytes); };
  const result = await downloadAnonymousAsset(asset, 'runtime-vtest', directory, fetchImpl);
  assert.equal(result.anonymous, true); assert.equal(calls, 1); assert.deepEqual(await readFile(join(directory, asset.name)), bytes);
  for (const patch of [{ name: '../escape' }, { browser_download_url: 'https://other.invalid/manifest.json' }, { size: -1 }, { state: 'new' }]) {
    await assert.rejects(downloadAnonymousAsset({ ...asset, ...patch }, 'runtime-vtest', directory, fetchImpl));
  }
  await rm(join(directory, asset.name));
  await assert.rejects(downloadAnonymousAsset({ ...asset, digest: `sha256:${'0'.repeat(64)}` }, 'runtime-vtest', directory, fetchImpl), /digest differs/);
});
