import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SHOWCASE_NATIVE_FONT = Object.freeze({
  fontSha256: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da', fontBytes: 17772300,
  licenseSha256: '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9', licenseBytes: 4388,
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValue = (value, message) => { if (!value) throw Error(message); };
function read(path, kind) {
  const stat = lstatSync(path), size = SHOWCASE_NATIVE_FONT[`${kind}Bytes`];
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size === size, `Showcase native ${kind} must be the reviewed ordinary file`);
  const bytes = readFileSync(path);
  requireValue(bytes.length === size && sha(bytes) === SHOWCASE_NATIVE_FONT[`${kind}Sha256`], `Showcase native ${kind} SHA-256 mismatch`);
  return bytes;
}
export function loadShowcaseNativeFont({ distributionProfile = 'full', font, license } = {}) {
  requireValue(['full', 'restricted-showcase'].includes(distributionProfile), 'Invalid native font distribution profile');
  if (distributionProfile === 'full') {
    requireValue(font === undefined && license === undefined, 'Showcase native font inputs require restricted-showcase'); return null;
  }
  requireValue(typeof font === 'string' && font.length && typeof license === 'string' && license.length,
    'Restricted native producer requires --showcase-font and --showcase-font-license');
  const fontPath = resolve(font), licensePath = resolve(license); read(fontPath, 'font'); read(licensePath, 'license');
  return Object.freeze({ ...SHOWCASE_NATIVE_FONT, fontPath, licensePath });
}
export function verifyShowcaseNativeFont(input) {
  if (!input) return;
  read(input.fontPath, 'font'); read(input.licensePath, 'license');
  if (input.retainedFontPath) read(input.retainedFontPath, 'font');
  if (input.retainedLicensePath) read(input.retainedLicensePath, 'license');
}
export function retainShowcaseNativeFont(input, directory) {
  if (!input) return null;
  verifyShowcaseNativeFont(input); mkdirSync(directory, { recursive: true });
  const retainedFontPath = resolve(directory, 'showcase-NotoSansSC.ttf'), retainedLicensePath = resolve(directory, 'showcase-NotoSansSC-LICENSE.OFL.txt');
  writeFileSync(retainedFontPath, read(input.fontPath, 'font')); writeFileSync(retainedLicensePath, read(input.licensePath, 'license'));
  return Object.freeze({ ...input, retainedFontPath, retainedLicensePath });
}
export function showcaseNativeFontEnvironment(input) {
  return { WEAPP_SHOWCASE_FONT: input?.retainedFontPath ?? undefined, WEAPP_SHOWCASE_FONT_LICENSE: input?.retainedLicensePath ?? undefined };
}
export function verifyShowcaseNativeFontArtifact(bytes, input) {
  if (!input) return null;
  const marker = Buffer.from(`weapp-container-native-font:${SHOWCASE_NATIVE_FONT.fontSha256}:${SHOWCASE_NATIVE_FONT.licenseSha256}\0`);
  requireValue(Buffer.from(bytes).includes(marker), 'Compiled artifact is missing the reviewed native showcase font identity');
  if (input.fontPath) requireValue(Buffer.from(bytes).includes(read(input.fontPath, 'font')), 'Compiled artifact is missing the complete reviewed native showcase font bytes');
  return { ...SHOWCASE_NATIVE_FONT, markerVerified: true };
}
export function readShowcaseNativeFontLicense(path) { return read(path, 'license'); }
