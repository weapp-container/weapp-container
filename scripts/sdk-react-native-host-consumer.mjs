import {cpSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {makeHostFixture} from '../examples/sdk/react-native/host/make-fixture.mjs';
import {verifyInstalledPackage} from './sdk-react-native-integrity.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const out = resolve(arg('--out', '/tmp/weapp-rn-host-consumer'));
const archive = resolve(arg('--package', resolve(root, 'artifacts/sdk/react-native/weapp-container-react-native-0.1.0-preview.2.tgz')));
function run(command, args, cwd = root) { const result = spawnSync(command, args, {cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 600_000}); if (result.status !== 0) throw new Error(`${command}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`); }
run(process.execPath, ['scripts/sdk-react-native-consumer.mjs', '--package', archive, '--out', out, ...(process.argv.includes('--reuse') ? ['--reuse'] : [])]);
run('npm', ['install', '--save-exact', '@react-navigation/native@7.5.1', '@react-navigation/native-stack@7.21.0', 'react-native-screens@4.30.0', '--ignore-scripts', '--no-audit', '--no-fund'], out);
const metadata = JSON.parse(readFileSync(resolve(out, 'consumer.json')));
const previous = metadata.bundle;
metadata.bundle += '.host';
for (const relative of ['android/app/build.gradle', 'ios/HelloWorld.xcodeproj/project.pbxproj']) {
  const path = resolve(out, relative);
  if (existsSync(path)) writeFileSync(path, readFileSync(path, 'utf8').replaceAll(previous, metadata.bundle));
}
cpSync(resolve(root, 'examples/sdk/react-native/host/App.tsx'), resolve(out, 'App.tsx'));
writeFileSync(resolve(out, 'ios/ConsumerUITests.swift'), readFileSync(resolve(root, 'examples/sdk/react-native/host/ConsumerUITests.swift'), 'utf8').replaceAll('__BUNDLE__', metadata.bundle));
metadata.fixture = makeHostFixture(root, resolve(out, 'ios/acceptance-pack'));
cpSync(resolve(out, 'ios/acceptance-pack'), resolve(out, 'android/app/src/main/assets/acceptance-pack'), {recursive: true});
metadata.installedArtifact = verifyInstalledPackage(out);
metadata.harness = {name: 'native host routing and parent scroll', navigation: '7.5.1', nativeStack: '7.21.0', screens: '4.30.0'};
writeFileSync(resolve(out, 'consumer.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify({consumer: out, bundle: metadata.bundle, packageSha256: metadata.packageSha256, fixture: metadata.fixture, installedArtifact: metadata.installedArtifact, harness: metadata.harness}, null, 2));
