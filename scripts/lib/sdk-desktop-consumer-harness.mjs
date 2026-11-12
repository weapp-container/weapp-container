import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reviewedSdkSource } from './sdk-reviewed-sources.mjs';
import { SDK_RELEASE_VERSION } from './sdk-current-release.mjs';
import { downloadRuntimeArtifact } from '../../sdk/contract/tools/runtime-artifacts.mjs';

// These independently staged examples are deliberately excluded from runtime
// archives. New example sources require explicit review of this small list.
const exampleFiles = ['CMakeLists.txt', 'c_smoke.c', 'linux.cpp', 'macos.mm', 'showcase_smoke.hpp', 'smoke.hpp', 'wait.hpp', 'windows.cpp'];

export async function installDesktopConsumerArchive({ manifestPath, artifactDirectory, platform, workDirectory, installDirectory }) {
  if (!['macos', 'windows', 'linux'].includes(platform)) throw Error('Select an actual desktop archive platform');
  // Retain the exact manifest used by the installer, even if the caller later
  // edits its original lock. These bytes, the archive and relocation are distinct.
  const manifest = readFileSync(manifestPath), snapshot = resolve(workDirectory, 'runtime-artifacts.lock.json');
  writeFileSync(snapshot, manifest, { flag: 'wx' });
  const prepared = await downloadRuntimeArtifact({ manifestPath: snapshot, version: SDK_RELEASE_VERSION, component: 'desktop-sdk', platform,
    arch: platform === 'macos' ? 'universal' : 'x86_64', artifactDirectory, outDirectory: resolve(workDirectory, 'downloads'), installDirectory });
  if (prepared.installation.reused !== false) throw Error('Desktop archive consumer requires a new installation');
  return { kind: 'fresh-runtime-archive', manifestSha256: createHash('sha256').update(manifest).digest('hex'), archiveSha256: prepared.receipt.sha256,
    archive: prepared.receipt, installation: prepared.installation };
}

export function prepareDesktopConsumerHarness({ sourceRoot, receipt, destination }) {
  const reviewed = reviewedSdkSource('desktop', receipt, { desktop: sourceRoot });
  const actual = [...reviewed.records.keys()].filter(path => path.startsWith('consumer/')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(exampleFiles.map(path => `consumer/${path}`))) throw Error('Desktop consumer source differs from the explicit reviewed example list');
  const files = exampleFiles.map(file => {
    const path = `consumer/${file}`, source = reviewed.readSource(path), record = reviewed.records.get(path);
    return { file, source, sha256: record.sha256, size: source.length };
  });
  mkdirSync(destination);
  try {
    for (const file of files) writeFileSync(resolve(destination, file.file), file.source, { flag: 'wx' });
  } catch (error) {
    rmSync(destination, { recursive: true });
    throw error;
  }
  return { kind: 'external-reviewed-sdk-examples', sourceCommit: receipt.sourceCommit, sourceInventorySha256: reviewed.inventory.sha256,
    files: files.map(({ source, ...file }) => file) };
}
