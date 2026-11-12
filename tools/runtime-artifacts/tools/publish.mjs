#!/usr/bin/env node
// Explicit publication of freshly packaged full distributions. Never copies legacy releases.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectArtifact } from '../../../sdk/contract/tools/runtime-artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const policy = JSON.parse(await readFile(new URL('../policy.json', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function checkedFile(directory, name) {
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  const path = join(directory, name), stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Release inputs must be independent regular files');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return { name, size: stat.size, sha256: digest.digest('hex') };
}
async function json(directory, name) {
  assert.ok((await lstat(join(directory, name))).size <= 16 * 1024 ** 2, 'Metadata exceeds size bound');
  return JSON.parse(await readFile(join(directory, name), 'utf8'));
}

export async function verifyRelease(directory) {
  const manifest = await json(directory, 'manifest.json'), provenance = await json(directory, 'provenance.json');
  assert.equal(manifest.runtimeVersion, policy.runtimeVersion);
  assert.equal(manifest.abiVersion, policy.abiVersion);
  assert.equal(manifest.source.repository, policy.repository, 'New publication must target the core repository');
  assert.equal(manifest.source.releaseTag, `runtime-v${policy.runtimeVersion}`);
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.runtimeVersion, manifest.runtimeVersion);
  assert.equal(provenance.abiVersion, manifest.abiVersion);
  assert.match(provenance.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(provenance.sourceDirty, false);
  assert.equal(provenance.headerSha256, policy.headerSha256);
  assert.equal(provenance.runtimeLicenseSha256, hash(await readFile(new URL('../RUNTIME-LICENSE', import.meta.url))));
  assert.equal(provenance.artifacts.length, manifest.artifacts.length);
  const files = [];
  for (const artifact of manifest.artifacts) {
    selectArtifact(manifest, { version: manifest.runtimeVersion, abiVersion: manifest.abiVersion, ...artifact });
    const file = await checkedFile(directory, artifact.fileName);
    assert.equal(file.size, artifact.size);
    assert.equal(file.sha256, artifact.sha256);
    const origins = provenance.artifacts.filter(item => item.fileName === file.name);
    assert.equal(origins.length, 1);
    assert.equal(origins[0].sha256, file.sha256);
    assert.equal(origins[0].sourceCommit, provenance.sourceCommit);
    assert.equal(origins[0].sourceDirty, false);
    assert.equal(origins[0].headerSha256, policy.headerSha256);
    files.push(file);
  }
  for (const name of ['manifest.json', 'provenance.json']) files.push(await checkedFile(directory, name));
  // Packager uses Python's ASCII ordering, independent of the host locale.
  const asciiSums = files.slice().sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(file => `${file.sha256}  ${file.name}\n`).join('');
  assert.equal(await readFile(join(directory, 'SHA256SUMS'), 'utf8'), asciiSums);
  files.push(await checkedFile(directory, 'SHA256SUMS'));
  return { repository: policy.repository, tag: manifest.source.releaseTag, sourceCommit: provenance.sourceCommit, files };
}

const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] });
function absent(path, invoke) {
  try { invoke('gh', ['api', path]); }
  catch (error) {
    if (/\(HTTP 404\)/.test(String(error.stderr))) return;
    throw Error('Cannot confirm release/tag absence; verify GitHub access');
  }
  throw Error('Immutable publication refuses an existing release or tag');
}
export function publishVerifiedRelease(plan, directory, notesFile, invoke = run) {
  const repo = plan.repository;
  assert.equal(repo, policy.repository);
  assert.equal(plan.tag, `runtime-v${policy.runtimeVersion}`);
  assert.equal(invoke('git', ['rev-parse', 'HEAD']).trim(), plan.sourceCommit, 'Publication checkout must match producer source');
  assert.equal(invoke('git', ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']).trim(), '', 'Publication requires clean committed source');
  const pages = JSON.parse(invoke('gh', ['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]));
  assert.ok(Array.isArray(pages) && pages.every(Array.isArray), 'Cannot inspect existing releases and drafts');
  assert.ok(!pages.flat().some(release => release.tag_name === plan.tag), 'Immutable publication refuses an existing release or draft');
  absent(`repos/${repo}/git/ref/tags/${plan.tag}`, invoke);
  const created = JSON.parse(invoke('gh', ['api', `repos/${repo}/releases`, '--method', 'POST',
    '-f', `tag_name=${plan.tag}`, '-f', `target_commitish=${plan.sourceCommit}`,
    '-F', 'draft=true', '-F', 'prerelease=true', '-f', `name=${plan.tag}`, '-F', `body=@${notesFile}`]));
  assert.ok(Number.isSafeInteger(created.id) && created.id > 0, 'Draft creation returned no release ID');
  const endpoint = `repos/${repo}/releases/${created.id}`;
  // No --clobber: interruption leaves a draft for explicit inspection, never silently overwrites it.
  for (const file of plan.files) invoke('gh', ['release', 'upload', plan.tag, join(directory, file.name), '--repo', repo]);
  // Unpublished drafts may be absent from the tag endpoint. Preserve the returned ID.
  const release = JSON.parse(invoke('gh', ['api', endpoint]));
  assert.equal(release.id, created.id);
  assert.equal(release.draft, true);
  assert.equal(release.prerelease, true);
  assert.equal(release.tag_name, plan.tag);
  assert.equal(release.target_commitish, plan.sourceCommit);
  assert.equal(release.assets.length, plan.files.length);
  for (const file of plan.files) {
    const matches = release.assets.filter(asset => asset.name === file.name);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].state, 'uploaded');
    assert.equal(matches[0].size, file.size);
    assert.equal(matches[0].digest, `sha256:${file.sha256}`, 'GitHub digest must match the reviewed local bytes');
  }
  invoke('gh', ['api', endpoint, '--method', 'PATCH', '-F', 'draft=false', '-F', 'prerelease=true', '-f', 'make_latest=false']);
  return { status: 'published', repository: repo, tag: plan.tag, sourceCommit: plan.sourceCommit };
}

async function main(args) {
  const options = {}; let execute = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--execute' && !execute) { execute = true; continue; }
    assert.ok(['--release-dir', '--notes-file'].includes(key) && !options[key] && args[i + 1] && !args[i + 1].startsWith('--'), 'Use --release-dir PATH --notes-file PATH [--execute]');
    options[key] = resolve(args[++i]);
  }
  assert.ok(options['--release-dir'] && options['--notes-file'], 'Both explicit input paths are required');
  const original = await verifyRelease(options['--release-dir']);
  const temporary = await mkdtemp(join(tmpdir(), 'wc-publish-'));
  try {
    // Freeze the exact verified bytes used by the offline check and upload.
    for (const file of original.files) await copyFile(join(options['--release-dir'], file.name), join(temporary, file.name));
    const notes = join(temporary, 'release-notes.md');
    assert.ok((await lstat(options['--notes-file'])).size <= 1024 ** 2, 'Release notes exceed bound');
    await copyFile(options['--notes-file'], notes);
    const plan = await verifyRelease(temporary);
    assert.deepEqual(plan, original, 'Inputs changed during publication snapshot');
    run(process.execPath, [join(root, 'tools/runtime-artifacts/tools/verify-offline.mjs'),
      '--contract-dir', join(root, 'sdk/contract'), '--release-dir', temporary, '--work-dir', temporary, '--report', join(temporary, 'offline.json')]);
    const report = await json(temporary, 'offline.json');
    assert.equal(report.status, 'passed'); assert.equal(report.networkRequests, 0);
    console.log(JSON.stringify(execute ? publishVerifiedRelease(plan, temporary, notes) : { status: 'verified', published: false, ...plan }, null, 2));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch { console.error('Runtime publication rejected. Inspect local validation or the retained GitHub draft; no existing asset was overwritten.'); process.exitCode = 1; }
}
