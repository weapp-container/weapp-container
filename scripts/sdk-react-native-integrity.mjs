import {readFileSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';

export const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Verify every shipped file; native build outputs outside this inventory are allowed. */
export function verifyInstalledPackage(consumer) {
  const root = resolve(consumer, 'node_modules/@weapp-container/react-native');
  const path = resolve(root, 'sdk-artifact.json');
  const manifest = JSON.parse(readFileSync(path));
  if (manifest.schema !== 1 || !manifest.files || !Object.keys(manifest.files).length) throw new Error('Missing SDK artifact inventory');
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const file = resolve(root, relative);
    if (!file.startsWith(`${root}${sep}`) || sha256(file) !== expected) throw new Error(`Installed SDK file differs from the npm artifact: ${relative}`);
  }
  return {sourceCommit: manifest.sourceCommit, sourceDirty: manifest.sourceDirty, manifestSha256: sha256(path), verifiedFiles: Object.keys(manifest.files).length};
}
