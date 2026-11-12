import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, relative, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {sha256, verifyInstalledPackage} from './sdk-react-native-integrity.mjs';

const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const consumer = resolve(arg('--consumer', '/tmp/weapp-rn-consumer'));
const rotationMode = arg('--rotation', 'device');
if (!['device', 'scene'].includes(rotationMode)) throw new Error('--rotation must be device or scene');
const metadata = JSON.parse(readFileSync(resolve(consumer, 'consumer.json')));
const out = resolve(arg('--out', resolve(dirname(metadata.package), 'example')));
if (existsSync(out)) throw new Error('Use a fresh --out so an existing example is never overwritten');
const archive = resolve(dirname(out), basename(metadata.package));
if (!existsSync(archive) || sha256(archive) !== metadata.packageSha256) throw new Error('Place the exact tested npm archive beside the example directory');
const excluded = new Set(['node_modules', 'Pods', 'build', '.gradle', '.kotlin', '.cxx', '.bundle', '_bundle', '.git', '.DS_Store', 'local.properties', '.xcode.env.local', 'Podfile.lock', 'consumer.json', '__tests__', 'jest.config.js']);
mkdirSync(out, {recursive: true});
cpSync(consumer, out, {recursive: true, filter: source => {
  const parts = relative(consumer, source).split('/');
  return !parts.some(part => excluded.has(part) || part.startsWith('validation-')) && !source.endsWith('.log');
}});
for (const [from, to] of [['_gitignore', '.gitignore'], ['_watchmanconfig', '.watchmanconfig'], ['_eslintrc.js', '.eslintrc.js'], ['_prettierrc.js', '.prettierrc.js']]) {
  if (existsSync(resolve(out, from))) renameSync(resolve(out, from), resolve(out, to));
}
rmSync(resolve(out, 'ios/_xcode.env'), {force: true});
const testPath = resolve(out, 'ios/ConsumerUITests.swift');
writeFileSync(testPath, readFileSync(testPath, 'utf8').replaceAll('__RN_ROTATION_MODE__', rotationMode));
const dependency = `file:../${basename(archive)}`;
const pkg = JSON.parse(readFileSync(resolve(out, 'package.json')));
pkg.dependencies['@weapp-container/react-native'] = dependency;
delete pkg.scripts.test; // The template's stock Jest test has no native SDK runtime.
writeFileSync(resolve(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
const lock = JSON.parse(readFileSync(resolve(out, 'package-lock.json')));
lock.packages[''].dependencies['@weapp-container/react-native'] = dependency;
lock.packages['node_modules/@weapp-container/react-native'].resolved = dependency;
writeFileSync(resolve(out, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
writeFileSync(resolve(out, 'ios/.xcode.env'), 'export NODE_BINARY=$(command -v node)\n');
const update = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'], {cwd: out, encoding: 'utf8', timeout: 120_000});
if (update.status !== 0) throw new Error(`Portable lockfile validation failed: ${update.stdout}\n${update.stderr}`);
let installedArtifact;
try {
  const install = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'], {cwd: out, encoding: 'utf8', timeout: 120_000});
  if (install.status !== 0) throw new Error(`Portable example installation failed: ${install.stdout}\n${install.stderr}`);
  installedArtifact = verifyInstalledPackage(out);
} finally { rmSync(resolve(out, 'node_modules'), {recursive: true, force: true}); }
writeFileSync(resolve(out, 'README.md'), `# WeappContainer React Native example\n\nMove this entire folder together with the sibling \`${basename(archive)}\`. It is an independent React Native 0.88.0 application with two native GPU containers and a bundled acceptance pack. No Rust toolchain or source checkout is required.\n\nRequirements: Node 24+, the normal React Native native toolchain, Android SDK 37 / Java 21 (minimum runtime Android 26), or Xcode with an iOS 16+ target and CocoaPods. Android ABIs are arm64-v8a and x86_64.\n\nInstall JavaScript dependencies with \`npm ci\`. For iOS, run \`cd ios && pod install\`, then open \`HelloWorld.xcworkspace\`. For Android, configure your own SDK location through \`ANDROID_HOME\` or a local \`android/local.properties\`, then run \`cd android && ./gradlew :app:assembleRelease\`. The Gradle wrapper uses the official React Native template version 9.4.1.\n\nFor development run \`npm start\`, then \`npm run ios\` or \`npm run android\` in a second terminal. The app exposes buttons for rerender, repeated native surface remount, navigation, detach/reattach, lifecycle pause/resume and durable close/reopen. The development build also exposes full React runtime reload. Edit the marker in \`App.tsx\` to exercise Fast Refresh.\n\nThe iOS XCTest rotation mode is \`${rotationMode}\`. Scene mode opts into a consumer-only UIKit button and verifies real system interface orientation, window geometry and SDK surface dimensions. It does not certify device-orientation injection. The native overlay is absent in normal application launches.\n\nThe fixture is stored in \`ios/acceptance-pack\` and \`android/app/src/main/assets/acceptance-pack\`. The iOS resource is a folder reference, preserving its manifest and blobs.\n\nPackage SHA-256: \`${metadata.packageSha256}\`. Portable fixture SHA-256: \`${metadata.fixture}\`. Device execution receipts are distributed beside this example; creating this folder does not rerun device tests.\n`);
const forbidden = ['/Users/', '/private/tmp/weapp-rn-consumer', '/tmp/weapp-rn-consumer'];
let files = 0;
function inspect(directory) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) inspect(path);
    else {
      files++;
      const data = readFileSync(path);
      if (!data.includes(0) && forbidden.some(value => data.includes(value))) throw new Error(`Nonportable local path in ${relative(out, path)}`);
    }
  }
}
inspect(out);
const receipt = {schema: 1, rotationMode, package: `../${basename(archive)}`, packageSha256: metadata.packageSha256, fixture: metadata.fixture, files, portable: true, lockfileValidated: true, offlineInstallVerified: true, installedArtifact, bytes: statSync(archive).size};
writeFileSync(resolve(out, 'example.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({example: out, ...receipt}, null, 2));
