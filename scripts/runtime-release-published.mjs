#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY } from './lib/runtime-release.mjs';
import { verifyRelease } from '../tools/runtime-artifacts/tools/publish.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function downloadAnonymousAsset(asset, tag, directory, fetchImpl = fetch) {
  assert.match(asset.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  const url = `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/${asset.name}`;
  assert.equal(asset.browser_download_url, url);
  assert.equal(asset.state, 'uploaded');
  assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 8 * 1024 ** 3);
  assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
  // Deliberately no token or Authorization header, even when GH_TOKEN exists.
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15 * 60_000) });
  assert.equal(response.status, 200, 'Anonymous release download failed');
  const file = await open(join(directory, asset.name), 'wx');
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert.ok(bytes <= asset.size, 'Anonymous asset exceeds recorded size');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    assert.equal(bytes, asset.size);
    assert.equal(`sha256:${hash.digest('hex')}`, asset.digest, 'Anonymous asset digest differs');
  } finally { await file.close(); }
  return { name: asset.name, size: bytes, digest: asset.digest, anonymous: true };
}

async function main(tag) {
  const policy = JSON.parse(readFileSync(join(root, 'tools/runtime-artifacts/policy.json')));
  assert.equal(tag, `runtime-v${policy.runtimeVersion}`);
  const release = JSON.parse(execFileSync('gh', ['api', `repos/${RELEASE_REPOSITORY}/releases/tags/${tag}`], { encoding: 'utf8' }));
  assert.equal(release.tag_name, tag); assert.equal(release.draft, false); assert.equal(release.prerelease, true);
  assert.equal(release.assets.length, 17, 'Expected 14 archives and three metadata assets');
  const out = join(root, 'artifacts/published'), files = join(out, 'files');
  mkdirSync(files, { recursive: true });
  const verified = [];
  for (const asset of release.assets) verified.push(await downloadAnonymousAsset(asset, tag, files));
  const plan = await verifyRelease(files, { complete: true });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(plan.sourceCommit, sha, 'Published tag must identify the original core producer');
  execFileSync(process.execPath, [join(root, 'tools/runtime-artifacts/tools/verify-offline.mjs'), '--contract-dir', join(root, 'sdk/contract'),
    '--release-dir', files, '--work-dir', join(out, 'offline'), '--report', join(out, 'offline.json')], { stdio: 'inherit' });
  const lockName = `runtime-artifacts.${policy.runtimeVersion}.lock.json`;
  writeFileSync(join(out, lockName), readFileSync(join(files, 'manifest.json')));
  writeFileSync(join(out, 'verification-summary.json'), JSON.stringify({ status: 'passed', tag, sourceCommit: sha, assets: verified,
    nextStep: `Copy ${lockName} unchanged into all six SDK repositories through reviewed PRs, then advance publishedRuntimeVersion in the core policy.` }, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Anonymous publication verified\n\nAll 17 assets and 14 offline installations passed. Download the published-runtime-verification artifact for \`${lockName}\` and the summary. Update the six SDK locks through PRs, then advance \`publishedRuntimeVersion\`.\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
