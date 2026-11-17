import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SHOWCASE_NATIVE_FONT, loadShowcaseNativeFont, verifyShowcaseNativeFontArtifact, readShowcaseNativeFontLicense, showcaseNativeFontEnvironment } from './showcase-native-font.mjs';

test('historical native font keeps its immutable reviewed identity without accepting an ambient or substituted file', t => {
  const input = JSON.parse(readFileSync(new URL('../fixtures/showcase-ci-inputs.lock.json', import.meta.url)));
  const reviewed = { font: input.font, fontLicense: input.font.license };
  assert.deepEqual(SHOWCASE_NATIVE_FONT, { fontSha256: reviewed.font.sha256, fontBytes: reviewed.font.size,
    licenseSha256: reviewed.fontLicense.sha256, licenseBytes: reviewed.fontLicense.size });
  assert.equal(loadShowcaseNativeFont(), null);
  assert.deepEqual(showcaseNativeFontEnvironment(null), { WEAPP_SHOWCASE_FONT: undefined, WEAPP_SHOWCASE_FONT_LICENSE: undefined });
  assert.throws(() => loadShowcaseNativeFont({ font: '/ambient/font.ttf' }), /require restricted/);
  assert.throws(() => loadShowcaseNativeFont({ distributionProfile: 'restricted-showcase' }), /requires/);
  const root = mkdtempSync(resolve(tmpdir(), 'native-font-input-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const font = resolve(root, 'font.ttf'), license = resolve(root, 'OFL.txt');
  writeFileSync(font, Buffer.alloc(SHOWCASE_NATIVE_FONT.fontBytes));
  writeFileSync(license, readFileSync(new URL('../../sdk/licenses/noto-sans-sc/LICENSE.OFL.txt', import.meta.url)));
  assert.equal(readShowcaseNativeFontLicense(license).length, SHOWCASE_NATIVE_FONT.licenseBytes);
  assert.throws(() => loadShowcaseNativeFont({ distributionProfile: 'restricted-showcase', font, license }), /font SHA-256 mismatch/);
  const tampered = Buffer.from(readFileSync(license)); tampered[0] ^= 1; writeFileSync(license, tampered);
  assert.throws(() => readShowcaseNativeFontLicense(license), /license SHA-256 mismatch/);
});
test('native font artifact requires the exact independent font and license marker', () => {
  const marker = Buffer.from(`weapp-container-native-font:${SHOWCASE_NATIVE_FONT.fontSha256}:${SHOWCASE_NATIVE_FONT.licenseSha256}\0`);
  assert.deepEqual(verifyShowcaseNativeFontArtifact(marker, SHOWCASE_NATIVE_FONT), { ...SHOWCASE_NATIVE_FONT, markerVerified: true });
  for (const bytes of [Buffer.from('binary without font'), marker.subarray(0, marker.length - 1), Buffer.from(marker.toString().replace(SHOWCASE_NATIVE_FONT.licenseSha256, 'a'.repeat(64)))]) {
    assert.throws(() => verifyShowcaseNativeFontArtifact(bytes, SHOWCASE_NATIVE_FONT), /missing/);
  }
});
