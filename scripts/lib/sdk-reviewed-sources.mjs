import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { SDK_RELEASE_VERSION } from './sdk-current-release.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function gitSource(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], { maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw Error('An accessible committed SDK source identity is required');
  return result.stdout;
}
// Review the exact producer commit, rather than a mutable checkout or a broad
// extension whitelist. Public wrappers may evolve without admitting core source.
export function reviewedSdkSource(platform, receipt, sdkSourceRoots) {
  const kind = ['android', 'ios'].includes(platform) ? platform : 'desktop';
  const directory = realpathSync(sdkSourceRoots[kind]);
  if (realpathSync(gitSource(directory, ['rev-parse', '--show-toplevel']).toString().trim()) !== directory) throw Error('SDK source provenance must come from its own repository');
  if (!/^[a-f0-9]{40}$/.test(receipt.sourceCommit ?? '') || !/^[a-f0-9]{64}$/.test(receipt.sourceInventorySha256 ?? '')) throw Error('Reviewed SDK source inventory identity is required');
  const bytes = gitSource(directory, ['show', `${receipt.sourceCommit}:SOURCE-INVENTORY.json`]);
  if (sha(bytes) !== receipt.sourceInventorySha256) throw Error('SDK producer source inventory hash mismatch');
  const value = JSON.parse(bytes);
  const validIdentity = value.schemaVersion === 1
    ? /^[a-f0-9]{40}$/.test(value.sourceBaseCommit ?? '')
    : value.schemaVersion === 2 && /^[a-f0-9]{64}$/.test(value.sourceFilesSha256 ?? '');
  if (!validIdentity || value.sdkVersion !== SDK_RELEASE_VERSION || !value.review || !Array.isArray(value.files)) throw Error('Invalid reviewed SDK source inventory');
  if (value.schemaVersion === 1) gitSource(directory, ['merge-base', '--is-ancestor', value.sourceBaseCommit, receipt.sourceCommit]);
  else if (value.sourceFilesSha256 !== sha(Buffer.from(JSON.stringify(value.files)))) throw Error('SDK reviewed source fingerprint mismatch');
  const tree = new Map(gitSource(directory, ['ls-tree', '-rz', '--full-tree', receipt.sourceCommit]).toString().split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(line);
    if (!match) throw Error('SDK reviewed source contains non-file Git objects');
    return [match[2], match[1]];
  }));
  const records = new Map();
  for (const record of value.files) {
    if (typeof record.path !== 'string' || record.path.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(record.path) || record.path.split('/').some(part => !part || part === '.' || part === '..') || records.has(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '') || !Number.isSafeInteger(record.size) || record.size < 0 || tree.get(record.path) !== record.mode) throw Error('Invalid or uncommitted reviewed SDK source entry');
    records.set(record.path, record);
  }
  if (tree.size !== records.size + 1 || !tree.has('SOURCE-INVENTORY.json') || [...tree.keys()].some(path => path !== 'SOURCE-INVENTORY.json' && !records.has(path))) throw Error('SDK committed source differs from its reviewed inventory');
  const origin = records.get('ORIGIN.json');
  if (value.historicalOrigin?.path !== 'ORIGIN.json' || value.historicalOrigin.sha256 !== origin?.sha256) throw Error('SDK historical ORIGIN identity mismatch');
  const wrappers = new Map([...records].filter(([path]) => kind === 'ios' ? path.startsWith('Sources/WeappContainer/') && path.endsWith('.swift') : kind === 'android' ? path.startsWith('library/src/main/java/com/sonofmagic/weapp/container/sdk/') && path.endsWith('.kt') : path.startsWith('include/weapp/') && /\.(?:h|hpp)$/.test(path)));
  if (!wrappers.size) throw Error('Reviewed public SDK wrappers are missing');
  // Independently bind each exported source to the committed blob as well as the
  // inventory. Producer hashes alone cannot authorize an unreviewed wrapper.
  function readSource(path) {
    const record = records.get(path);
    if (!record) throw Error('SDK source is outside the reviewed inventory');
    const source = gitSource(directory, ['show', `${receipt.sourceCommit}:${record.path}`]);
    if (source.length !== record.size || sha(source) !== record.sha256) throw Error('Committed SDK wrapper differs from its reviewed inventory');
    return source;
  }
  for (const path of wrappers.keys()) readSource(path);
  return { records, wrappers, readSource, inventory: { file: 'SDK-SOURCE-INVENTORY.json', content: bytes.toString(), size: bytes.length, sha256: sha(bytes), executable: false, provenance: 'reviewed-sdk-source-inventory' } };
}
