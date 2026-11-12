#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNoticeFileName, portableNoticePath } from './lib/sdk-notice.mjs';
import { loadShowcaseNativeFont, verifyShowcaseNativeFont } from './lib/showcase-native-font.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--') || args.lastIndexOf(name) !== index) throw new Error(`${name} needs one value`);
  return args[index + 1];
}
const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(option('--source-root', toolRoot));
const packageName = option('--package', 'container-sdk-ffi');
if (!['container-sdk-ffi', 'container-host-web', 'container-host-harmony'].includes(packageName)) throw new Error('Select a supported runtime package');
const target = option('--target', process.platform === 'darwin' ? 'aarch64-apple-darwin' : undefined);
if (!target) throw new Error('--target is required');
const features = option('--features', 'quickjs-native,skia-backend');
const embeddedNativeFont = features.split(',').includes('restricted-showcase') && packageName !== 'container-host-web' && !target.startsWith('wasm32-');
const nativeFont = loadShowcaseNativeFont({ distributionProfile: embeddedNativeFont ? 'restricted-showcase' : 'full',
  font: option('--showcase-font'), license: option('--showcase-font-license') });
const destination = resolve(option('--out', `artifacts/sdk/licenses/${target}`));
function sourceIdentity() {
  const query = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const top = query(['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || relative(realpathSync.native(top.stdout.trim()), realpathSync.native(root)) !== '') return { sourceCommit: null, sourceDirty: null };
  const revision = query(['rev-parse', 'HEAD']), dirty = query(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']);
  return { sourceCommit: revision.status === 0 ? revision.stdout.trim() : null, sourceDirty: dirty.status === 0 ? Boolean(dirty.stdout.trim()) : null };
}
const sourceBefore = sourceIdentity();
const command = ['metadata', '--manifest-path', `crates/${packageName}/Cargo.toml`, '--format-version=1',
  '--locked', '--filter-platform', target, '--no-default-features', '--features', features];
if (args.includes('--offline')) command.push('--offline');
const run = spawnSync('cargo', command, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (run.error || run.status !== 0) throw new Error(run.error?.message || run.stderr);
const metadata = JSON.parse(run.stdout);
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
const packages = new Map(metadata.packages.map(pkg => [pkg.id, pkg]));
const sdk = metadata.packages.find(pkg => pkg.name === packageName);
if (!sdk) throw new Error('SDK package not resolved');
const included = new Set();
function visit(id) {
  if (included.has(id)) return;
  included.add(id);
  for (const dependency of nodes.get(id)?.deps || []) visit(dependency.pkg);
}
visit(sdk.id);
function files(directory, depth = 0) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isFile() && isNoticeFileName(entry.name)) result.push(path);
    if (entry.isDirectory() && depth < 12 && !['target', 'node_modules', '.git', 'out'].includes(entry.name)) result.push(...files(path, depth + 1));
  }
  return result;
}
const entries = [...included].map(id => packages.get(id)).sort((a, b) => `${a.name}-${a.version}`.localeCompare(`${b.name}-${b.version}`));
const report = { schemaVersion: 1, package: packageName, target, features: features.split(','), source: sourceBefore, collector: {
  algorithm: 'sha256', sourceFiles: ['scripts/sdk-licenses.mjs', 'scripts/lib/sdk-notice.mjs', 'scripts/lib/showcase-native-font.mjs'].map(path => ({
    path, sha256: createHash('sha256').update(readFileSync(resolve(toolRoot, path))).digest('hex'),
  })),
}, packages: [] };
mkdirSync(dirname(destination), { recursive: true });
const staging = mkdtempSync(`${destination}.collect-`);
const previous = `${destination}.previous-${randomUUID()}`;
let movedPrevious = false;
try {
for (const pkg of entries) {
  const source = dirname(pkg.manifest_path);
  const local = pkg.source === null;
  const candidates = local && !pkg.license ? [] : files(source);
  // Workspace members inherit their declared Apache grant and the root notices.
  // An undeclared or externally supplied local dependency never inherits it.
  const workspaceMember = metadata.workspace_members.includes(pkg.id);
  if (workspaceMember && pkg.license === 'Apache-2.0') {
    for (const name of ['LICENSE', 'NOTICE']) {
      const notice = resolve(root, name);
      if (existsSync(notice)) candidates.push(notice);
    }
  }
  const notices = resolve(root, 'sdk/licenses', `${pkg.name}-${pkg.version}`);
  if (!candidates.length && existsSync(notices)) candidates.push(...files(notices));
  if (pkg.license_file && existsSync(resolve(source, pkg.license_file))) {
    if (!isNoticeFileName(basename(pkg.license_file))) throw new Error(`Declared license file is not a portable notice: ${pkg.name}`);
    candidates.push(resolve(source, pkg.license_file));
  }
  const record = { name: pkg.name, version: pkg.version, license: pkg.license ?? null, repository: pkg.repository, files: [] };
  for (const file of new Set(candidates)) {
    const path = `${pkg.name}-${pkg.version}/${local ? basename(file) : portableNoticePath(file.startsWith(notices) ? notices : source, file)}`;
    const output = resolve(staging, path);
    if (!output.startsWith(`${staging}/`) && !output.startsWith(`${staging}\\`)) throw new Error('Unsafe license destination');
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(file, output);
    record.files.push({ path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  }
  // skia-bindings can compile an explicitly supplied source tree instead of
  // its registry copy. Include notices from the tree that produced the binary.
  if (pkg.name === 'skia-bindings' && process.env.SKIA_SOURCE_DIR) {
    const nativeSource = resolve(process.env.SKIA_SOURCE_DIR);
    if (!existsSync(resolve(nativeSource, 'LICENSE'))) throw new Error('SKIA_SOURCE_DIR must contain the upstream Skia LICENSE');
    const nativeNotices = files(nativeSource);
    for (const file of nativeNotices) {
      const path = `${pkg.name}-${pkg.version}/external-source/${portableNoticePath(nativeSource, file)}`;
      const output = resolve(staging, path);
      mkdirSync(dirname(output), { recursive: true });
      copyFileSync(file, output);
      record.files.push({ path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
    }
    record.nativeSource = { selection: 'SKIA_SOURCE_DIR', noticeCount: nativeNotices.length };
  }
  if (existsSync(resolve(notices, 'source.json'))) record.noticeSource = JSON.parse(readFileSync(resolve(notices, 'source.json'), 'utf8'));
  report.packages.push(record);
}
const missingLicenseFiles = report.packages.filter(pkg => !pkg.files.length).map(pkg => pkg.name);
if (missingLicenseFiles.length) throw new Error(`Missing complete dependency notices: ${missingLicenseFiles.join(', ')}`);
if (nativeFont) {
  verifyShowcaseNativeFont(nativeFont);
  const path = 'noto-sans-sc/LICENSE.OFL.txt', bytes = readFileSync(nativeFont.licensePath);
  mkdirSync(resolve(staging, 'noto-sans-sc'), { recursive: true }); writeFileSync(resolve(staging, path), bytes);
  report.nativeFont = { fontSha256: nativeFont.fontSha256, fontBytes: nativeFont.fontBytes, licenseSha256: nativeFont.licenseSha256, licenseBytes: nativeFont.licenseBytes };
  report.packages.push({ name: 'NotoSansSC', version: nativeFont.fontSha256, license: 'OFL-1.1', repository: 'https://github.com/notofonts/noto-cjk',
    kind: 'embedded-native-font', files: [{ path, sha256: nativeFont.licenseSha256 }] });
}
report.sourceAfter = sourceIdentity();
if (sourceBefore.sourceCommit && (report.sourceAfter.sourceCommit !== sourceBefore.sourceCommit
  || sourceBefore.sourceDirty === false && report.sourceAfter.sourceDirty !== false)) throw new Error('Dependency notice source changed during collection; existing inventory preserved');
writeFileSync(resolve(staging, 'licenses.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(resolve(staging, 'README.txt'), 'Dependency notices for the selected runtime feature graph. Includes conservative notices for vendored native sources such as QuickJS and Skia. Platform runtime/framework notices accompany their respective packages.\n');
if (existsSync(destination)) { renameSync(destination, previous); movedPrevious = true; }
try { renameSync(staging, destination); }
catch (error) { if (movedPrevious) { renameSync(previous, destination); movedPrevious = false; } throw error; }
if (movedPrevious) { rmSync(previous, { recursive: true }); movedPrevious = false; }
console.log(JSON.stringify({ target, packages: entries.length, destination, missingLicenseFiles: report.packages.filter(pkg => !pkg.files.length).map(pkg => pkg.name) }, null, 2));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
