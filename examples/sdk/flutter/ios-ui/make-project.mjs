import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A standalone UI runner drives an already installed, independently built app.
export function makeProject(directory, bundle) {
  const project = resolve(directory, 'FlutterSDKTests.xcodeproj');
  mkdirSync(resolve(project, 'xcshareddata/xcschemes'), { recursive: true });
  const objects = []; let count = 0;
  const add = value => { const id = (++count).toString(16).padStart(24, 'B'); objects.push(`${id} = {${value}};`); return id; };
  const source = add('isa=PBXFileReference;lastKnownFileType=sourcecode.swift;path=ConsumerUITests.swift;sourceTree="<group>";');
  const product = add('isa=PBXFileReference;explicitFileType=wrapper.cfbundle;path=FlutterSDKTests.xctest;sourceTree=BUILT_PRODUCTS_DIR;');
  const build = add(`isa=PBXBuildFile;fileRef=${source};`);
  const sources = add(`isa=PBXSourcesBuildPhase;buildActionMask=2147483647;files=(${build});runOnlyForDeploymentPostprocessing=0;`);
  const frameworks = add('isa=PBXFrameworksBuildPhase;buildActionMask=2147483647;files=();runOnlyForDeploymentPostprocessing=0;');
  const configs = settings => {
    const debug = add(`isa=XCBuildConfiguration;name=Debug;buildSettings={${settings}};`);
    return add(`isa=XCConfigurationList;buildConfigurations=(${debug});defaultConfigurationIsVisible=0;defaultConfigurationName=Debug;`);
  };
  const targetConfig = configs(`SWIFT_VERSION=5.0;IPHONEOS_DEPLOYMENT_TARGET=16.0;TARGETED_DEVICE_FAMILY="1,2";CODE_SIGN_IDENTITY="-";CODE_SIGN_STYLE=Automatic;GENERATE_INFOPLIST_FILE=YES;PRODUCT_NAME="$(TARGET_NAME)";PRODUCT_BUNDLE_IDENTIFIER="${bundle}";SUPPORTED_PLATFORMS=iphonesimulator;LD_RUNPATH_SEARCH_PATHS=("$(inherited)","@executable_path/Frameworks","@loader_path/Frameworks");`);
  const target = add(`isa=PBXNativeTarget;buildConfigurationList=${targetConfig};buildPhases=(${sources},${frameworks});buildRules=();dependencies=();name=FlutterSDKTests;productName=FlutterSDKTests;productReference=${product};productType="com.apple.product-type.bundle.ui-testing";`);
  const products = add(`isa=PBXGroup;children=(${product});name=Products;sourceTree="<group>";`);
  const group = add(`isa=PBXGroup;children=(${source},${products});sourceTree="<group>";`);
  const config = configs('CLANG_ENABLE_MODULES=YES;ENABLE_TESTING_SEARCH_PATHS=YES;SDKROOT=iphonesimulator;');
  const root = add(`isa=PBXProject;attributes={LastUpgradeCheck=1600;};buildConfigurationList=${config};compatibilityVersion="Xcode 14.0";developmentRegion=en;knownRegions=(en,Base);mainGroup=${group};productRefGroup=${products};projectDirPath="";projectRoot="";targets=(${target});`);
  writeFileSync(resolve(project, 'project.pbxproj'), `// !$*UTF8*$!\n{archiveVersion=1;classes={};objectVersion=56;objects={${objects.join('\n')}};rootObject=${root};}\n`);
  const ref = `<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${target}" BuildableName="FlutterSDKTests.xctest" BlueprintName="FlutterSDKTests" ReferencedContainer="container:FlutterSDKTests.xcodeproj"/>`;
  writeFileSync(resolve(project, 'xcshareddata/xcschemes/FlutterSDKTests.xcscheme'), `<?xml version="1.0"?><Scheme version="1.7"><BuildAction parallelizeBuildables="NO" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">${ref}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">${ref}</TestableReference></Testables></TestAction></Scheme>`);
  return project;
}
