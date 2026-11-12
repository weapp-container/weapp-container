import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifySkiaInput } from './sdk-skia-input.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sdk-skia-input-'));
  const directory = join(root, 'libraries'), source = join(root, 'source');
  mkdirSync(directory); mkdirSync(source);
  writeFileSync(join(root, 'Cargo.lock'), `name = "skia-bindings"\nversion = "0.153.3"\nsource = "registry+fixture"\nchecksum = "${'a'.repeat(64)}"\n`);
  const identity = (file, bytes) => ({ file, bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') });
  const members = [['libskia.a', 'inert third-party archive fixture'], ['skia-defines.txt', '-DSK_GL\n']];
  for (const [file, bytes] of members) writeFileSync(join(directory, file), bytes);
  writeFileSync(join(source, 'DEPS'), 'inert source identity');
  const manifest = { schemaVersion: 1, crateVersion: '0.153.3', crateChecksum: 'a'.repeat(64), target: 'exact-target',
    files: members.map(([name, bytes]) => identity(name, bytes)), sourceFiles: [identity('DEPS', 'inert source identity')] };
  const save = () => writeFileSync(join(directory, 'input.json'), JSON.stringify(manifest)); save();
  return { root, directory, source, manifest, save, env: { SKIA_SOURCE_DIR: source, SKIA_LIBRARY_SEARCH_PATH: directory, SKIA_BUILD_DEFINES: '-DSK_GL\n' }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('explicit offline Skia inputs bind exact target, crate, static libraries and source identity', () => {
  const f = fixture(); try {
    const receipt = verifySkiaInput(f.env, 'exact-target', f.root);
    assert.equal(receipt.target, 'exact-target'); assert.equal(receipt.files.length, 2);
    assert.equal(verifySkiaInput({}, 'anything', f.root), null);
    assert.throws(() => verifySkiaInput({ SKIA_SOURCE_DIR: f.source }, 'exact-target', f.root), /together/);
  } finally { f.cleanup(); }
});
test('wrong target, dependency bytes or source headers fail before native compilation', () => {
  const f = fixture(); try {
    assert.throws(() => verifySkiaInput(f.env, 'foreign-target', f.root), /exact target/);
    writeFileSync(join(f.directory, 'libskia.a'), 'changed');
    assert.throws(() => verifySkiaInput(f.env, 'exact-target', f.root), /hash\/size/);
    writeFileSync(join(f.directory, 'libskia.a'), 'inert third-party archive fixture');
    writeFileSync(join(f.source, 'DEPS'), 'changed');
    assert.throws(() => verifySkiaInput(f.env, 'exact-target', f.root), /source identity mismatch/);
  } finally { f.cleanup(); }
});
test('wrong definitions, duplicate members and symlinked libraries cannot impersonate a checked dependency', () => {
  const f = fixture(); try {
    assert.throws(() => verifySkiaInput({ ...f.env, SKIA_BUILD_DEFINES: '-DSK_METAL' }, 'exact-target', f.root), /definitions/);
    f.manifest.files.push(f.manifest.files[0]); f.save();
    assert.throws(() => verifySkiaInput(f.env, 'exact-target', f.root), /duplicate/);
    f.manifest.files.pop(); f.save();
    const path = join(f.directory, 'libskia.a'), bytes = readFileSync(path);
    rmSync(path); writeFileSync(join(f.root, 'foreign.a'), bytes); symlinkSync(join(f.root, 'foreign.a'), path);
    assert.throws(() => verifySkiaInput(f.env, 'exact-target', f.root), /ordinary contained/);
  } finally { f.cleanup(); }
});
