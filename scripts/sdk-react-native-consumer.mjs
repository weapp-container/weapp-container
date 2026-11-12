import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {tmpdir, homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {makeFixture} from '../examples/sdk/shared/make-fixture.mjs';
import {verifyInstalledPackage} from './sdk-react-native-integrity.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const archive = resolve(arg('--package', resolve(root, 'artifacts/sdk/react-native/weapp-container-react-native-0.1.0-preview.2.tgz')));
const out = resolve(arg('--out', resolve(tmpdir(), `weapp-rn-consumer-${Date.now()}`)));
function run(command, args, cwd, timeout = 600_000) { const result = spawnSync(command, args, {cwd, encoding: 'utf8', maxBuffer: 25 * 1024 * 1024, timeout}); if (result.status !== 0) throw new Error(`${command}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`); return result.stdout; }
if (!existsSync(archive)) throw new Error(`Missing SDK package: ${archive}`);
if (existsSync(out) && !process.argv.includes('--reuse')) throw new Error('Consumer exists; use a new --out or explicit --reuse to refresh this task-owned consumer');
mkdirSync(out, {recursive: true});
if (!existsSync(resolve(out, 'package.json'))) {
  const temporary = mkdtempSync(resolve(tmpdir(), 'weapp-rn-template-'));
  try {
    const [pkg] = JSON.parse(run('npm', ['pack', '@react-native-community/template@0.88.0', '--ignore-scripts', '--json', '--pack-destination', temporary], temporary));
    run('tar', ['-xf', resolve(temporary, pkg.filename), '-C', temporary], temporary);
    cpSync(resolve(temporary, 'package/template'), out, {recursive: true});
  } finally { rmSync(temporary, {recursive: true, force: true}); }
}
run('npm', ['install', archive, '--ignore-scripts', '--no-audit', '--no-fund'], out);
const installedArtifact = verifyInstalledPackage(out);
cpSync(resolve(root, 'examples/sdk/react-native/App.tsx'), resolve(out, 'App.tsx'));
const fixture = makeFixture(root, resolve(out, 'ios/acceptance-pack'));
cpSync(resolve(out, 'ios/acceptance-pack'), resolve(out, 'android/app/src/main/assets/acceptance-pack'), {recursive: true});
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
// Each Android application-id segment must start with a letter, including when
// an archive's hexadecimal digest begins with a digit.
const bundle = `org.weappcontainer.rnconsumer.p${digest.slice(0, 10)}`;
let appGradle = readFileSync(resolve(out, 'android/app/build.gradle'), 'utf8');
appGradle = appGradle.replace(/applicationId "[^"]+"/, `applicationId "${bundle}"`);
appGradle = appGradle.replace(/minSdkVersion [^\n]+/, 'minSdkVersion 26');
writeFileSync(resolve(out, 'android/app/build.gradle'), appGradle);
const gradleProperties = resolve(out, 'android/gradle.properties');
writeFileSync(gradleProperties, readFileSync(gradleProperties, 'utf8').replace(/^reactNativeArchitectures=.*$/m, 'reactNativeArchitectures=arm64-v8a,x86_64'));
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || resolve(homedir(), 'Library/Android/sdk');
if (existsSync(sdk)) writeFileSync(resolve(out, 'android/local.properties'), `sdk.dir=${sdk}\n`);
writeFileSync(resolve(out, 'ios/.xcode.env'), `export NODE_BINARY=${JSON.stringify(process.execPath)}\n`);
if (process.platform === 'darwin') {
  run('plutil', ['-replace', 'UISupportedInterfaceOrientations', '-json', JSON.stringify(['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight']), resolve(out, 'ios/HelloWorld/Info.plist')], out);
  const podfile = resolve(out, 'ios/Podfile');
  writeFileSync(podfile, readFileSync(podfile, 'utf8').replace('platform :ios, min_ios_version_supported', "platform :ios, '16.0'"));
  const projectPath = resolve(out, 'ios/HelloWorld.xcodeproj/project.pbxproj');
  const project = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', projectPath], out));
  const objects = project.objects;
  const add = (key, object) => { const id = createHash('sha256').update(`weapp-rn-${key}`).digest('hex').slice(0, 24).toUpperCase(); objects[id] = object; return id; };
  const app = objects['13B07F861A680F5B00A75B9A'];
  for (const id of objects[app.buildConfigurationList].buildConfigurations) { objects[id].buildSettings.PRODUCT_BUNDLE_IDENTIFIER = bundle; objects[id].buildSettings.IPHONEOS_DEPLOYMENT_TARGET = '16.0'; }
  const resource = add('fixture', {isa: 'PBXFileReference', lastKnownFileType: 'folder', path: 'acceptance-pack', sourceTree: '<group>'});
  const resourceBuild = add('fixture-build', {isa: 'PBXBuildFile', fileRef: resource});
  const mainGroup = objects[objects[project.rootObject].mainGroup];
  if (!mainGroup.children.includes(resource)) mainGroup.children.push(resource);
  const resources = app.buildPhases.map(id => objects[id]).find(item => item.isa === 'PBXResourcesBuildPhase');
  if (!resources.files.includes(resourceBuild)) resources.files.push(resourceBuild);
  cpSync(resolve(root, 'examples/sdk/react-native/ConsumerSceneRotation.swift'), resolve(out, 'ios/ConsumerSceneRotation.swift'));
  const rotationSource = add('rotation-source', {isa: 'PBXFileReference', lastKnownFileType: 'sourcecode.swift', path: 'ConsumerSceneRotation.swift', sourceTree: '<group>'});
  const rotationBuild = add('rotation-build', {isa: 'PBXBuildFile', fileRef: rotationSource});
  if (!mainGroup.children.includes(rotationSource)) mainGroup.children.push(rotationSource);
  const sources = app.buildPhases.map(id => objects[id]).find(item => item.isa === 'PBXSourcesBuildPhase');
  if (!sources.files.includes(rotationBuild)) sources.files.push(rotationBuild);
  const appDelegatePath = resolve(out, 'ios/HelloWorld/AppDelegate.swift');
  let appDelegate = readFileSync(appDelegatePath, 'utf8');
  if (!appDelegate.includes('ConsumerSceneRotation.supportedOrientations')) appDelegate = appDelegate.replace('class AppDelegate: UIResponder, UIApplicationDelegate {', 'class AppDelegate: UIResponder, UIApplicationDelegate {\n  func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask { ConsumerSceneRotation.supportedOrientations }');
  writeFileSync(appDelegatePath, appDelegate);
  const sceneDelegatePath = resolve(out, 'ios/HelloWorld/SceneDelegate.swift');
  let sceneDelegate = readFileSync(sceneDelegatePath, 'utf8');
  if (!sceneDelegate.includes('ConsumerSceneRotation.install')) sceneDelegate = sceneDelegate.replace('      connectionOptions: connectionOptions\n    )', '      connectionOptions: connectionOptions\n    )\n    ConsumerSceneRotation.install(in: window)');
  writeFileSync(sceneDelegatePath, sceneDelegate);
  const testSource = add('test-source', {isa: 'PBXFileReference', lastKnownFileType: 'sourcecode.swift', path: 'ConsumerUITests.swift', sourceTree: '<group>'});
  if (!mainGroup.children.includes(testSource)) mainGroup.children.push(testSource);
  const testProduct = add('test-product', {isa: 'PBXFileReference', explicitFileType: 'wrapper.cfbundle', path: 'ConsumerUITests.xctest', sourceTree: 'BUILT_PRODUCTS_DIR'});
  const testBuild = add('test-build', {isa: 'PBXBuildFile', fileRef: testSource});
  const testPhase = add('test-phase', {isa: 'PBXSourcesBuildPhase', buildActionMask: '2147483647', files: [testBuild], runOnlyForDeploymentPostprocessing: '0'});
  const testConfigs = ['Debug', 'Release'].map(name => add(`test-${name}`, {isa: 'XCBuildConfiguration', name, buildSettings: {SWIFT_VERSION: '5.0', IPHONEOS_DEPLOYMENT_TARGET: '16.0', PRODUCT_BUNDLE_IDENTIFIER: `${bundle}.tests`, PRODUCT_NAME: '$(TARGET_NAME)', GENERATE_INFOPLIST_FILE: 'YES', TEST_TARGET_NAME: 'HelloWorld', CODE_SIGN_STYLE: 'Automatic', TARGETED_DEVICE_FAMILY: '1,2', LD_RUNPATH_SEARCH_PATHS: ['$(inherited)', '@executable_path/Frameworks', '@loader_path/Frameworks']}}));
  const testConfigList = add('test-configs', {isa: 'XCConfigurationList', buildConfigurations: testConfigs, defaultConfigurationIsVisible: '0', defaultConfigurationName: 'Release'});
  const testTarget = add('test-target', {isa: 'PBXNativeTarget', buildConfigurationList: testConfigList, buildPhases: [testPhase], buildRules: [], dependencies: [], name: 'ConsumerUITests', productName: 'ConsumerUITests', productReference: testProduct, productType: 'com.apple.product-type.bundle.ui-testing'});
  const projectObject = objects[project.rootObject];
  if (!projectObject.targets.includes(testTarget)) projectObject.targets.push(testTarget);
  const products = objects[projectObject.productRefGroup];
  if (!products.children.includes(testProduct)) products.children.push(testProduct);
  function plist(value) { if (Array.isArray(value)) return `(${value.map(plist).join(',')})`; if (typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}=${plist(v)};`).join('')}}`; return JSON.stringify(String(value)); }
  writeFileSync(projectPath, `// !$*UTF8*$!\n${plist(project)}\n`);
  writeFileSync(resolve(out, 'ios/ConsumerUITests.swift'), readFileSync(resolve(root, 'examples/sdk/react-native/ConsumerUITests.swift'), 'utf8').replaceAll('__BUNDLE__', bundle));
  const schemePath = resolve(out, 'ios/HelloWorld.xcodeproj/xcshareddata/xcschemes/HelloWorld.xcscheme');
  let scheme = readFileSync(schemePath, 'utf8').replace(/<Testables>[\s\S]*?<\/Testables>/, `<Testables><TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${testTarget}" BuildableName="ConsumerUITests.xctest" BlueprintName="ConsumerUITests" ReferencedContainer="container:HelloWorld.xcodeproj"/></TestableReference></Testables>`);
  scheme = scheme.replace(/(<TestAction\s+buildConfiguration = )"Debug"/, '$1"Release"');
  writeFileSync(schemePath, scheme);
}
const receipt = {schema: 1, consumer: out, bundle, reactNative: '0.88.0', package: archive, packageSha256: digest, installedArtifact, fixture, prepared: true, installed: true, nativeBuilds: 'not run by preparation', instructions: ['cd ios && pod install', 'xcodebuild -workspace ios/HelloWorld.xcworkspace -scheme HelloWorld -configuration Release -sdk iphonesimulator -destination id=YOUR_EXISTING_SIMULATOR_ID -derivedDataPath build/ios build-for-testing CODE_SIGNING_ALLOWED=NO', 'cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a,x86_64', 'Run ConsumerUITests on an existing iOS simulator; capture XCTest attachments. Uninstall this consumer and its .tests.xctrunner when finished.']};
writeFileSync(resolve(out, 'consumer.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
