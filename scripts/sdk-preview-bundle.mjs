#!/usr/bin/env node
// Versioned local delivery: pinned SDK repositories plus verified installations.
// Legacy v1 source-directory assembly remains available in Git history only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: node scripts/sdk-preview-bundle.mjs --inventory <schema-v2 inventory>
  [--out <new destination>] [--artifact-dir <authorized offline archives>]
Inventory: { schemaVersion:2, sdkVersion, sdkCommits:{contract,android,ios,desktop,flutter,"react-native"},
  runtimeManifest:"relative release lock", components:[
    {id,kind:"runtime-artifact",component:"runtime"|"android-sdk"|"ios-sdk"|"desktop-sdk",platform,arch,status},
    {id,kind:"wrapper-package",sdk:"flutter"|"react-native",status,
     artifact:{path,size,sha256},receipt:{path,sha256}}
  ] }
Every component may include evidence:[{path,sha256,result,description}] and validatedScope.
status is built|verified|blocked; verified requires passing evidence and scope; blocked requires reason.
All paths resolve against the inventory. Every SDK commit must match its clean, committed submodule.
Native assets use sdk/contract's exact version/component/architecture/hash installer; no v1 output or source tree is copied.
Default destination: artifacts/sdk/preview/<version>. Nothing is published.`);
  process.exit(0);
}
const values = new Map();
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if (!['--inventory', '--out', '--artifact-dir'].includes(name)) throw new Error(`Unknown option ${name}; use --help`);
  if (values.has(name)) throw new Error(`Duplicate option ${name}`);
  const value = args[++index];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  values.set(name, value);
}
if (!values.has('--inventory')) throw new Error('--inventory <schema-v2 inventory> is required');
const inventoryFile = resolve(values.get('--inventory'));
const inventory = JSON.parse(readFileSync(inventoryFile, 'utf8'));
if (inventory.schemaVersion !== 2) throw new Error('Legacy preview inventory/output schema v1 is not accepted; create a v2 inventory with SDK commit pins and artifact installations');
const contract = resolve(root, 'sdk/contract');
const version = JSON.parse(readFileSync(resolve(contract, 'platforms.json'), 'utf8')).version;
if (inventory.sdkVersion !== version || !Array.isArray(inventory.components) || !inventory.components.length) throw new Error('Inventory SDK version or components are invalid');
const repositories = ['contract', 'android', 'ios', 'desktop', 'flutter', 'react-native'];
function query(argv, cwd = root) {
  const result = spawnSync('git', argv, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
if (query(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Commit reviewed core and submodule pointers before assembling a preview');
const sourceCommit = query(['rev-parse', 'HEAD']);
const sdkCommits = {};
for (const name of repositories) {
  const pin = inventory.sdkCommits?.[name], sdk = resolve(root, 'sdk', name);
  if (!/^[a-f0-9]{40}$/.test(pin ?? '')) throw new Error(`Missing exact SDK commit pin: ${name}`);
  if (resolve(query(['rev-parse', '--show-toplevel'], sdk)) !== sdk || query(['rev-parse', 'HEAD'], sdk) !== pin || query(['status', '--porcelain', '--untracked-files=normal'], sdk)) throw new Error(`SDK ${name} must be its own clean checkout at ${pin}`);
  const tracked = query(['ls-tree', 'HEAD', '--', `sdk/${name}`]);
  if (!tracked.startsWith(`160000 commit ${pin}\t`)) throw new Error(`Core gitlink does not pin SDK ${name} at ${pin}`);
  sdkCommits[name] = pin;
}
const { SDK_VERSION, downloadRuntimeArtifact } = await import(pathToFileURL(resolve(contract, 'tools/runtime-artifacts.mjs')).href);
if (SDK_VERSION !== version) throw new Error('Contract downloader and SDK versions differ');
if (typeof inventory.runtimeManifest !== 'string' || !inventory.runtimeManifest) throw new Error('runtimeManifest must name the reviewed exact release lock');
const runtimeManifest = resolve(dirname(inventoryFile), inventory.runtimeManifest);
const runtimeManifestBytes = readFileSync(runtimeManifest);
const release = JSON.parse(runtimeManifestBytes);
if (release.schemaVersion !== 1 || release.runtimeVersion !== version || release.abiVersion !== 1) throw new Error('Runtime lock version or ABI differs from the delivery');
const destination = resolve(values.get('--out') ?? resolve(root, 'artifacts/sdk/preview', version));
if (existsSync(destination)) throw new Error(`Delivery destination already exists: ${destination}; use a new version/destination`);
mkdirSync(dirname(destination), { recursive: true });
const staging = mkdtempSync(resolve(dirname(destination), '.preview-staging-'));
const stagedRuntimeManifest = resolve(staging, 'runtime-artifacts.lock.json');
const sha256 = path => {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(path, 'r');
  try { let size; while ((size = readSync(fd, buffer)) !== 0) hash.update(buffer.subarray(0, size)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
};
const inside = (parent, child) => { const rel = relative(parent, child); return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
function reviewedFile(record, label) {
  if (!record || typeof record.path !== 'string' || !record.path || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '')) throw new Error(`${label} requires path and SHA-256`);
  const path = resolve(dirname(inventoryFile), record.path);
  if (path === destination || inside(destination, path)) throw new Error(`Recursive ${label} input`);
  let cursor = path;
  while (true) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlink ${label} input is forbidden`);
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 8 * 1024 ** 3 || sha256(path) !== record.sha256) throw new Error(`${label} bytes differ from the reviewed pin`);
  if (record.size !== undefined && (!Number.isSafeInteger(record.size) || record.size <= 0 || stat.size !== record.size)) throw new Error(`${label} size differs from the reviewed pin`);
  return path;
}
function copyFile(source, target, expected) {
  mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
  if (expected && sha256(target) !== expected) throw new Error('Copied file changed after pin verification');
}
const ids = new Set();
try {
  writeFileSync(stagedRuntimeManifest, runtimeManifestBytes, { flag: 'wx' });
  const manifest = { schemaVersion: 2, sdkVersion: version, abiVersion: 1, sourceCommit, sdkCommits,
    runtimeManifestSha256: sha256(stagedRuntimeManifest), createdAt: new Date().toISOString(), publication: 'local-only', components: [], files: [] };
  for (const item of inventory.components) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.id ?? '') || ids.has(item.id)) throw new Error(`Invalid/duplicate component id ${item.id}`);
    ids.add(item.id);
    if (!['built', 'verified', 'blocked'].includes(item.status)) throw new Error(`Invalid status for ${item.id}`);
    if (!['runtime-artifact', 'wrapper-package'].includes(item.kind)) throw new Error(`Invalid component kind for ${item.id}`);
    if (item.status === 'blocked' && (typeof item.reason !== 'string' || !item.reason.trim())) throw new Error(`Blocked component ${item.id} requires a reason`);
    const component = { id: item.id, kind: item.kind, status: item.status, reason: item.reason,
      component: item.component, platform: item.platform, arch: item.arch, sdk: item.sdk,
      validatedScope: item.validatedScope, limitations: item.limitations ?? [], evidence: [] };
    if (item.status !== 'blocked') {
      if (item.kind === 'runtime-artifact') {
        if (!['runtime', 'android-sdk', 'ios-sdk', 'desktop-sdk'].includes(item.component)) throw new Error(`Invalid runtime component ${item.component}`);
        const installed = await downloadRuntimeArtifact({ manifestPath: stagedRuntimeManifest, version, abiVersion: 1,
          component: item.component, platform: item.platform, arch: item.arch,
          outDirectory: resolve(staging, 'archives'), installDirectory: resolve(staging, 'components', item.id),
          artifactDirectory: values.has('--artifact-dir') ? resolve(values.get('--artifact-dir')) : process.env.WEAPP_CONTAINER_RUNTIME_ARTIFACT_DIR });
        const installation = JSON.parse(readFileSync(resolve(installed.installDirectory, '.runtime-install.json'), 'utf8'));
        Object.assign(component, { identity: installation.identity, archiveSha256: installed.receipt.sha256,
          installation: `components/${item.id}`, archive: `archives/${basename(installed.path)}` });
      } else {
        if (!['flutter', 'react-native'].includes(item.sdk)) throw new Error('Wrapper packages must identify the flutter or react-native SDK');
        if (!Number.isSafeInteger(item.artifact?.size) || item.artifact.size <= 0) throw new Error('Wrapper package requires its exact byte size');
        const source = reviewedFile(item.artifact, `${item.id} artifact`), receiptPath = reviewedFile(item.receipt, `${item.id} receipt`);
        if (!/\.(?:tgz|tar\.gz)$/.test(source)) throw new Error('Wrapper artifact must be a reviewed .tgz or .tar.gz package');
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        if ((receipt.sdkVersion ?? receipt.version) !== version || receipt.sourceCommit !== sdkCommits[item.sdk] || receipt.sourceDirty !== false) throw new Error(`Wrapper ${item.id} receipt does not match its clean SDK commit/version`);
        const target = `components/${item.id}/${basename(source)}`;
        copyFile(source, resolve(staging, target), item.artifact.sha256);
        copyFile(receiptPath, resolve(staging, 'components', item.id, 'build-receipt.json'), item.receipt.sha256);
        Object.assign(component, { sdk: item.sdk, sdkCommit: sdkCommits[item.sdk], artifact: target, artifactSha256: item.artifact.sha256 });
      }
    }
    for (const [index, evidence] of (item.evidence ?? []).entries()) {
      if (!['passed', 'failed', 'blocked'].includes(evidence.result)) throw new Error(`Invalid evidence result for ${item.id}`);
      const path = reviewedFile(evidence, `${item.id} evidence`), target = `validation/${item.id}/${index}-${basename(path)}`;
      copyFile(path, resolve(staging, target), evidence.sha256);
      component.evidence.push({ path: target, sha256: evidence.sha256, result: evidence.result, description: evidence.description });
    }
    if (item.status === 'verified' && (!item.validatedScope || !component.evidence.some(e => e.result === 'passed') || component.evidence.some(e => e.result === 'failed'))) throw new Error(`Verified component ${item.id} requires passing evidence, an explicit scope, and no failed evidence`);
    manifest.components.push(component);
  }
  for (const name of ['LICENSE', 'CONTRACT.md', 'platforms.json']) copyFile(resolve(contract, name), resolve(staging, 'contract', name));
  copyFile(resolve(contract, 'types/weapp-container.d.ts'), resolve(staging, 'contract/types/weapp-container.d.ts'));
  copyFile(resolve(contract, 'include/weapp_container_sdk.h'), resolve(staging, 'contract/include/weapp_container_sdk.h'));
  function inventoryFiles(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) inventoryFiles(path);
      else if (entry.isFile()) manifest.files.push({ path: relative(staging, path).split(sep).join('/'), bytes: lstatSync(path).size, sha256: sha256(path) });
      else throw new Error('Delivery contains a link or special file');
    }
  }
  inventoryFiles(staging);
  writeFileSync(resolve(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(staging, 'SHA256SUMS'), [...manifest.files.map(file => `${file.sha256}  ${file.path}`), `${sha256(resolve(staging, 'manifest.json'))}  manifest.json`].join('\n') + '\n');
  if (query(['rev-parse', 'HEAD']) !== sourceCommit || query(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Core or SDK source changed while assembling the preview');
  renameSync(staging, destination);
  console.log(JSON.stringify({ schemaVersion: 2, destination, sdkVersion: version, sourceCommit, sdkCommits,
    components: manifest.components.map(({ id, status, validatedScope }) => ({ id, status, validatedScope })), files: manifest.files.length, published: false }, null, 2));
} catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
