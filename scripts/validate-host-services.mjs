import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Reproducible protocol/source gates. Physical devices and merchant transactions
// require separate evidence; this runner never upgrades their acceptance state.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),outIndex=args.indexOf('--out');
if(args.length!==0&&(args.length!==2||args[0]!=='--out'||!args[1]))throw new Error('Usage: node scripts/validate-host-services.mjs [--out <directory>]');
const out=outIndex>=0?resolve(args[outIndex+1]):mkdtempSync(join(tmpdir(),'weapp-host-services-validation-'));
mkdirSync(out,{recursive:true});
const sdkSourcePlatforms=['android','desktop','flutter','ios'];
const sdkSourceGates=sdkSourcePlatforms.map(platform=>[`sdk-source-inventory-${platform}`,['node','tools/source-inventory.mjs'],join(root,'sdk',platform)]);
const gates=[
 ['catalog-and-producer',['node','--test','scripts/cpp-api-inventory.test.mjs','scripts/core-api-inventory.test.mjs','scripts/host-api-matrix.test.mjs','scripts/host-api-matrix-io.test.mjs','scripts/sdk-native-build.test.mjs','scripts/dev-player-runtime-archives.test.mjs','scripts/platform-runtime-archives.test.mjs','scripts/lib/harmony-artifact-contract.test.mjs','scripts/browser-dev-artifacts.test.mjs','scripts/build-native-hosts.test.mjs','scripts/sdk-licenses.test.mjs','scripts/sdk-android-consumer.test.mjs']],
 ['scheduler',['node','--test','scripts/api-completion-compat.test.mjs','scripts/api-owner-context.test.mjs','scripts/nexttick-api-owner.test.mjs','scripts/nexttick-contract.test.mjs','scripts/route-transaction.test.mjs','scripts/scheduler-canvas-owner.test.mjs','scripts/scheduler-framework-boundaries.test.mjs','scripts/turn-scheduler-candidate.test.mjs']],
 ['runtime',['cargo','test','-p','container-runtime','--features','quickjs-native,v8-native','--locked','host_services_contract','--','--test-threads=1']],
 ['sdk',['cargo','test','-p','container-sdk','-p','container-sdk-ffi','--locked','--','--test-threads=1']],
 ['native-components',['cargo','test','-p','container-render-skia','native_component','--locked','--','--test-threads=1']],
 ['web',['node','--test','examples/hosts/web-wasm/browser-host-services.test.mjs','examples/hosts/web-wasm/reference-identity-client.test.mjs','examples/hosts/web-wasm/browser-device-lifecycle.test.mjs','examples/hosts/web-wasm/browser-audio-lifecycle.test.mjs','examples/hosts/web-wasm/browser-bluetooth-lifecycle.test.mjs','examples/hosts/web-wasm/browser-recorder-lifecycle.test.mjs','examples/hosts/web-wasm/browser-wav-recorder.test.mjs','examples/hosts/web-wasm/host-api-binary-wire.test.mjs','examples/hosts/web-wasm/browser-nfc-lifecycle.test.mjs','examples/hosts/web-wasm/browser-host-account-manager.test.mjs','examples/hosts/web-wasm/worker-host-services.test.mjs','scripts/dom-presenter.test.mjs','scripts/worker-runtime.test.mjs','scripts/worker-session-client.test.mjs']],
 ['harmony',['node','--test','scripts/harmony-host-services.test.mjs','scripts/harmony-live-session.test.mjs','scripts/harmony-network-lifecycle.test.mjs','scripts/harmony-bluetooth-lifecycle.test.mjs','scripts/harmony-wifi-lifecycle.test.mjs','scripts/harmony-nfc-lifecycle.test.mjs','scripts/harmony-recorder-lifecycle.test.mjs','scripts/harmony-account-manager.test.mjs','scripts/harmony-reference-services.test.mjs','scripts/harmony-disclosure-prompts.test.mjs','scripts/harmony-account-transport.test.mjs']],
 ['harmony-native',['cargo','test','-p','container-host-harmony','--features','quickjs-native','--locked','--','--test-threads=1']],
 ['harmony-napi',['node','--test','scripts/harmony-native-owner.test.mjs','scripts/harmony-native-surface.test.mjs','scripts/harmony-native-arguments.test.mjs']],
 ['web-native',['cargo','test','-p','container-host-web','--features','quickjs-native','--locked','--','--test-threads=1']],
 ['reference',['node','--test',...readdirSync(join(root,'tools/host-services-reference/test')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tools/host-services-reference/test/'+name)]],
];
const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
const inputInventory=()=>{
 const files=spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024});
 if(files.status!==0)throw new Error('Cannot inventory validation sources');
 const paths=files.stdout.split('\0').filter(path=>path.startsWith('.cargo/')||path.startsWith('crates/')||path.startsWith('examples/hosts/web-wasm/')||path.startsWith('examples/hosts/harmony/entry/src/main/')||path.startsWith('tools/host-services-reference/')||path.startsWith('scripts/')||path==='Cargo.toml'||path==='Cargo.lock');
 paths.push('sdk/contract/include/weapp_container_sdk.h','sdk/contract/include/weapp_container_sdk_gl.h');
 for(const platform of sdkSourcePlatforms){
  const sdkFiles=spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:join(root,'sdk',platform),encoding:'utf8',maxBuffer:16*1024*1024});
  if(sdkFiles.status!==0)throw new Error(`Cannot inventory ${platform} SDK sources`);
  paths.push(...sdkFiles.stdout.split('\0').filter(Boolean).map(path=>`sdk/${platform}/${path}`));
 }
 return [...new Set(paths)].sort().filter(path=>lstatSync(join(root,path)).isFile()).map(path=>{
  const bytes=readFileSync(join(root,path));return {path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 });
};
const sources=inputInventory();
writeFileSync(join(out,'source-inputs.json'),JSON.stringify(sources,null,2)+'\n');
const report={schemaVersion:1,classification:'source-protocol-validation',startedAt:new Date().toISOString(),
 sourceCommit:git.status===0?git.stdout.trim():null,sourceDirty:spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).stdout.trim().length>0,
 sourceInventory:'source-inputs.json',sourceInventorySha256:createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
 physicalDevices:'not-run',merchantTransactions:'not-run',gates:[]};
for(const phase of [sdkSourceGates,gates]){
for(const [name,[command,...argv],cwd=root] of phase){
 const started=Date.now();console.log(`Running ${name}`);
 const result=spawnSync(command,argv,{cwd,encoding:'utf8',maxBuffer:32*1024*1024});
 const log=(result.stdout??'')+(result.stderr??'')+(result.error?'\n'+result.error.message:'');
 const logPath=join(out,`${name}.log`);writeFileSync(logPath,log);
 report.gates.push({name,command:[command,...argv],cwd,exitCode:result.status,signal:result.signal??null,durationMs:Date.now()-started,
  log:logPath,logSha256:createHash('sha256').update(readFileSync(logPath)).digest('hex')});
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
 if(result.status!==0)console.error(`${name} failed: ${logPath}`);
}
if(phase===sdkSourceGates){
 report.sdkSourcePreflightPassed=report.gates.every(gate=>gate.exitCode===0);
 if(!report.sdkSourcePreflightPassed)break;
}
}
report.completedAt=new Date().toISOString();report.sourceChangedDuringRun=JSON.stringify(sources)!==JSON.stringify(inputInventory());
report.passed=!report.sourceChangedDuringRun&&report.gates.every(gate=>gate.exitCode===0);
writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,report:join(out,'report.json')}));
process.exitCode=report.passed?0:1;
