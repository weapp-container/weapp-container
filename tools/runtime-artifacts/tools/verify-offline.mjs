#!/usr/bin/env node
// Verify already-packaged bytes through the independently maintained contract.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const options = {};
const allowed = new Set(['contract-dir', 'release-dir', 'work-dir', 'report']);
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.slice(2);
  if (!process.argv[i]?.startsWith('--') || !allowed.has(key) || options[key] || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) {
    throw new Error('Required options: --contract-dir PATH --release-dir PATH --work-dir PATH --report PATH');
  }
  options[key] = resolve(process.argv[i + 1]);
}
if ([...allowed].some(key => !options[key])) throw new Error('All four explicit path options are required.');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const release = options['release-dir'];
const manifestBytes = await readFile(join(release, 'manifest.json'));
const provenanceBytes = await readFile(join(release, 'provenance.json'));
const manifest = JSON.parse(manifestBytes);
const provenance = JSON.parse(provenanceBytes);
const downloaderPath = join(options['contract-dir'], 'tools/runtime-artifacts.mjs');
const unpackerPath = join(options['contract-dir'], 'tools/unpack-runtime.py');
const { downloadRuntimeArtifact, selectArtifact } = await import(pathToFileURL(downloaderPath));
assert.ok(manifest.artifacts?.length > 0, 'A nonempty release manifest is required.');
const report = {
  schemaVersion: 1, status: 'running', scope: 'offline-byte-integrity-and-installation',
  runtimeVersion: manifest.runtimeVersion, abiVersion: manifest.abiVersion,
  sourceCommit: provenance.sourceCommit,
  startedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  inputs: {
    manifestSha256: sha256(manifestBytes), provenanceSha256: sha256(provenanceBytes),
    downloaderSha256: sha256(await readFile(downloaderPath)),
    unpackerSha256: sha256(await readFile(unpackerPath)),
  },
  deviceExecution: false, gpuExecution: false, networkRequests: 0, artifacts: [],
};
await mkdir(options['work-dir'], { recursive: true });
const root = await mkdtemp(join(options['work-dir'], '.offline-verification-'));
try {
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const expected = {
      version: manifest.runtimeVersion, abiVersion: manifest.abiVersion,
      component: artifact.component, platform: artifact.platform, arch: artifact.arch,
    };
    selectArtifact(manifest, expected);
    const row = { ...artifact, status: 'running', checks: {} };
    report.artifacts.push(row);
    const directory = join(root, String(index));
    await mkdir(directory);
    try {
      const installationOptions = {
        ...expected, manifestPath: join(release, 'manifest.json'),
        outDirectory: join(directory, 'cache'), installDirectory: join(directory, 'installed'),
        artifactDirectory: release, token: '',
        fetchImpl() { report.networkRequests++; throw new Error('Network is forbidden in offline verification.'); },
      };
      const first = await downloadRuntimeArtifact(installationOptions);
      assert.equal(first.receipt.source, 'offline');
      assert.equal(first.receipt.sha256, artifact.sha256);
      assert.equal(first.installation.archiveSha256, artifact.sha256);
      assert.equal(first.installation.reused, false);
      row.checks.freshInstall = 'passed';
      row.installedFiles = first.installation.files;
      row.installedBytes = first.installation.bytes;
      const reused = await downloadRuntimeArtifact(installationOptions);
      assert.equal(reused.receipt.source, 'verified-cache');
      assert.equal(reused.installation.reused, true);
      row.checks.independentArchiveRevalidation = 'passed';
      const corruptedPin = structuredClone(manifest);
      const selected = corruptedPin.artifacts.find(value => value.component === artifact.component && value.platform === artifact.platform && value.arch === artifact.arch);
      selected.sha256 = (artifact.sha256[0] === '0' ? '1' : '0') + artifact.sha256.slice(1);
      const wrongManifest = join(directory, 'wrong-hash.json');
      await writeFile(wrongManifest, JSON.stringify(corruptedPin));
      const wrongCache = join(directory, 'wrong-cache');
      await assert.rejects(downloadRuntimeArtifact({
        ...installationOptions, manifestPath: wrongManifest,
        outDirectory: wrongCache, installDirectory: join(directory, 'must-not-install'),
      }), { code: 'ERR_RUNTIME_INTEGRITY' });
      assert.deepEqual(await readdir(wrongCache), []);
      assert.ok(!(await readdir(directory)).includes('must-not-install'));
      row.checks.wrongHashRejectedWithoutInstall = 'passed';
      row.status = 'passed';
      process.stdout.write(`${artifact.component}/${artifact.platform}/${artifact.arch}: passed\n`);
    } catch (error) {
      row.status = 'failed'; row.errorCode = error.code ?? 'ERR_OFFLINE_VERIFICATION';
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  assert.equal(report.networkRequests, 0);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errorCode = error.code ?? 'ERR_OFFLINE_VERIFICATION';
  throw error;
} finally {
  await rm(root, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  const temporaryReport = `${options.report}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryReport, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    await rename(temporaryReport, options.report);
  } finally { await rm(temporaryReport, { force: true }); }
}
