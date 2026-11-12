import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { canonicalize, compareUtf8, sha256 } from '../src/json-integrity.mjs';

const execFileAsync = promisify(execFile);

test('legacy manifest entry point reexports the same integrity functions', async () => {
  const legacy = await import('../src/index.mjs');
  assert.equal(legacy.canonicalize, canonicalize);
  assert.equal(legacy.sha256, sha256);
});

test('canonicalization sorts nested keys while preserving array order', () => {
  const value = { z: 1, a: [{ z: false, a: null }, '中', true, 3] };
  assert.equal(canonicalize(value), '{"a":[{"a":null,"z":false},"中",true,3],"z":1}');
  assert.equal(canonicalize({ '2': 'two', '10': 'ten', '1': 'one' }), '{"1":"one","10":"ten","2":"two"}');
});

test('key ordering uses UTF-8 bytes rather than UTF-16 or locale order', () => {
  const value = { '\u{10000}': 1, '\ue000': 2, 'é': 3, 'e\u0301': 4, a: 5 };
  assert.equal(canonicalize(value), '{"a":5,"e\u0301":4,"é":3,"\ue000":2,"\u{10000}":1}');
  assert.ok(compareUtf8('\ue000', '\u{10000}') < 0);
  assert.ok(compareUtf8('é', 'e\u0301') > 0);
  assert.equal(compareUtf8('中', '中'), 0);
});

test('primitive JSON escaping and number formatting remain unchanged', () => {
  const text = '"\\\n\r\t\b\f\u0000中😀';
  assert.equal(canonicalize(text), JSON.stringify(text));
  assert.equal(canonicalize(-0), '0');
  assert.equal(canonicalize(1e+30), '1e+30');
  assert.equal(canonicalize(1e-7), '1e-7');
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(canonicalize(value), 'null');
});

test('unsupported values retain explicit rejection instead of JSON omission or coercion', () => {
  for (const value of [undefined, () => {}, Symbol('value'), 1n]) {
    assert.throws(() => canonicalize(value), {
      name: 'TypeError', message: `Cannot canonicalize ${typeof value}`,
    });
    assert.throws(() => canonicalize({ value }), TypeError);
    assert.throws(() => canonicalize([value]), TypeError);
  }
});

test('legacy own-enumerable property and sparse-array behavior is preserved', () => {
  const value = Object.create({ inherited: 'ignored' });
  value.b = 2;
  value.a = 1;
  Object.defineProperty(value, 'hidden', { value: 3 });
  value[Symbol('ignored')] = 4;
  assert.equal(canonicalize(value), '{"a":1,"b":2}');
  assert.equal(canonicalize(new Date('2024-01-01T00:00:00.000Z')), '{}');
  assert.equal(canonicalize([1, , 3]), '[1,,3]');
});

test('SHA-256 retains lowercase standard byte digests', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(Buffer.from('hello')), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(sha256('中😀'), sha256(Buffer.from('中😀', 'utf8')));
});

test('SHA-256 hashes only the provided byte-view span without coercion', () => {
  const bytes = new Uint8Array([0, 104, 101, 108, 108, 111, 255]);
  const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  assert.equal(sha256(bytes.subarray(1, 6)), expected);
  assert.equal(sha256(new DataView(bytes.buffer, 1, 5)), expected);
  assert.equal(sha256(Buffer.from(bytes).subarray(1, 6)), expected);
  assert.throws(() => sha256([104, 101, 108, 108, 111]), TypeError);
});

test('integrity helper loads from an isolated file with no compiler dependency closure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'container-json-integrity-'));
  try {
    const modulePath = path.join(directory, 'json-integrity.mjs');
    await copyFile(new URL('../src/json-integrity.mjs', import.meta.url), modulePath);
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      const { canonicalize, sha256 } = await import(process.argv[1]);
      assert.equal(canonicalize({ z: 1, a: 2 }), '{"a":2,"z":1}');
      assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      process.stdout.write('isolated-integrity-ok');
    `, pathToFileURL(modulePath).href], { cwd: directory, timeout: 10_000 });
    assert.equal(stdout, 'isolated-integrity-ok');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
