#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = { 'aarch64-apple-darwin': 'darwin-arm64', 'x86_64-unknown-linux-gnu': 'linux-x64' };
const args = process.argv.slice(2);
const index = args.indexOf('--target');
const target = index < 0 ? ({ 'darwin-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu' })[`${process.platform}-${process.arch}`] : args[index + 1];
if (!targets[target]) throw new Error('Supported targets: aarch64-apple-darwin, x86_64-unknown-linux-gnu');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} exited ${result.status}`);
}
run('cargo', ['build', '--locked', '--release', '--target', target, '--no-default-features', '-p', 'container-sdk', '--features', 'testing', '--bin', 'weapp-test-host']);
const destination = join(root, 'packages/runtime', targets[target]);
await mkdir(join(destination, 'bin'), { recursive: true });
const binary = join(destination, 'bin/weapp-test-host');
await copyFile(join(root, 'target', target, 'release/weapp-test-host'), binary);
await chmod(binary, 0o755);
await copyFile(join(root, 'LICENSE'), join(destination, 'RUNTIME-LICENSE'));
run(process.execPath, ['scripts/sdk-licenses.mjs', '--package', 'container-sdk', '--target', target, '--features', 'testing', '--out', join(destination, 'THIRD_PARTY_NOTICES')]);
const bytes = await readFile(binary);
const pkg = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
await writeFile(join(destination, 'runtime.json'), JSON.stringify({ schemaVersion: 1, version: pkg.version, target, protocolVersion: 1, engine: 'quickjs', testing: true, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2) + '\n');
console.log(`Prepared ${pkg.name} (${bytes.length} bytes)`);
