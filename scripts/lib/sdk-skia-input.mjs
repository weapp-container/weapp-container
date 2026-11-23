import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (base, path) => {
  const name = relative(base, path);
  return !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`);
};

/** Explicit upstream offline linking, never a substitute Weapp runtime. */
export function verifySkiaInput(env, target, root) {
  if (!env.SKIA_SOURCE_DIR && !env.SKIA_LIBRARY_SEARCH_PATH) return null;
  if (!env.SKIA_SOURCE_DIR || !env.SKIA_LIBRARY_SEARCH_PATH || !env.SKIA_BUILD_DEFINES) {
    throw Error('Explicit Skia inputs require source, libraries and build definitions together');
  }
  const directory = realpathSync(env.SKIA_LIBRARY_SEARCH_PATH);
  const manifestBytes = readFileSync(resolve(directory, 'input.json'));
  const manifest = JSON.parse(manifestBytes);
  const lock = readFileSync(resolve(root, 'Cargo.lock'), 'utf8');
  const locked = lock.match(/name = "skia-bindings"\nversion = "([^"]+)"\nsource = "[^"]+"\nchecksum = "([a-f0-9]{64})"/);
  if (manifest.schemaVersion !== 1 || manifest.target !== target || !locked ||
      manifest.crateVersion !== locked[1] || manifest.crateChecksum !== locked[2] ||
      !Array.isArray(manifest.files) || !manifest.files.length) {
    throw Error('Skia input must match the locked crate and exact target');
  }
  const names = new Set();
  for (const file of manifest.files) {
    if (typeof file.file !== 'string' || !/^(?:lib[a-zA-Z0-9_-]+\.a|skia-defines\.txt)$/.test(file.file) || names.has(file.file)) {
      throw Error('Invalid or duplicate Skia dependency member');
    }
    names.add(file.file);
    const path = resolve(directory, file.file), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(directory, realpathSync(path))) throw Error('Skia input must be an ordinary contained file');
    const bytes = readFileSync(path);
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw Error('Skia dependency hash/size mismatch');
  }
  if (!names.has('libskia.a') || !names.has('skia-defines.txt') ||
      readFileSync(resolve(directory, 'skia-defines.txt'), 'utf8') !== env.SKIA_BUILD_DEFINES) {
    throw Error('Skia library and exact preprocessor definitions are required');
  }
  const source = realpathSync(env.SKIA_SOURCE_DIR);
  if (!Array.isArray(manifest.sourceFiles) || !manifest.sourceFiles.length) throw Error('Skia source identity is required');
  for (const file of manifest.sourceFiles) {
    const path = resolve(source, file.file);
    if (!inside(source, path) || !inside(source, realpathSync(path)) || lstatSync(path).isSymbolicLink()) throw Error('Skia source identity escapes its source directory');
    const bytes = readFileSync(path);
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw Error('Skia source identity mismatch');
  }
  return { kind: 'upstream-skia-offline-input', manifestSha256: sha(manifestBytes),
    crateVersion: manifest.crateVersion, crateChecksum: manifest.crateChecksum,
    target, files: manifest.files, sourceFiles: manifest.sourceFiles,
    scope: 'Explicit third-party static dependency; current Weapp runtime and Rust/C++ bindings are compiled by this build. Source identity covers the listed files.' };
}
