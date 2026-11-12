import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = path.join(root, 'dist');
await mkdir(dist, { recursive: true });
// Keep a stable root-package entry point while the implementation remains
// plain ESM. This is intentionally a copy, not a generated JS bundle.
await copyFile(path.join(root, 'bin', 'container-pack.mjs'), path.join(dist, 'cli.mjs'));
console.log(`container-manifest entrypoint ready: ${path.relative(process.cwd(), path.join(dist, 'cli.mjs'))}`);
