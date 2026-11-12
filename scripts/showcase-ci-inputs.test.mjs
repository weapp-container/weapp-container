import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateInputs, verifyInputFile } from './showcase-ci-inputs.mjs';
import { readFileSync } from 'node:fs';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/showcase-ci-inputs.lock.json', import.meta.url)));
test('private CI input selection blocks stale pack approval and cross-repository or unsafe assets', () => {
  const value = fixture(); value.reviewStatus = 'reviewed-final-pack'; validateInputs(value);
  value.reviewStatus = 'awaiting-final-pack'; assert.throws(() => validateInputs(value), /Final pack review/);
  value.reviewStatus = 'reviewed-final-pack'; value.repository = 'other/repo'; assert.throws(() => validateInputs(value));
  const traversal = fixture(); traversal.reviewStatus = 'reviewed-final-pack'; traversal.pack.fileName = '../pack.tar.gz'; assert.throws(() => validateInputs(traversal));
  const unpinned = fixture(); unpinned.reviewStatus = 'reviewed-final-pack'; unpinned.sources[0].sourceCommit = 'main'; assert.throws(() => validateInputs(unpinned));
  const font = fixture(); font.reviewStatus = 'reviewed-final-pack'; font.font.sha256 = '0'.repeat(64); assert.throws(() => validateInputs(font));
  const fontPath = fixture(); fontPath.reviewStatus = 'reviewed-final-pack'; fontPath.font.path = '../font.ttf'; assert.throws(() => validateInputs(fontPath));
  const license = fixture(); license.reviewStatus = 'reviewed-final-pack'; delete license.font.license; assert.throws(() => validateInputs(license), /font and its license/);
});
test('a private release asset remains bound to exact regular bytes after download', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'showcase-ci-input-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = resolve(root, 'input.bundle'), bytes = Buffer.from('inert immutable input'); writeFileSync(file, bytes);
  const pin = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  assert.equal(verifyInputFile(file, pin), file);
  writeFileSync(file, Buffer.alloc(bytes.length)); assert.throws(() => verifyInputFile(file, pin), /SHA-256/);
  const link = resolve(root, 'linked.bundle'); symlinkSync(file, link); assert.throws(() => verifyInputFile(link, pin));
});
