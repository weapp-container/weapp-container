#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');const args=process.argv.slice(2);
const option=(key,fallback)=>{const at=args.indexOf(key);return at<0?fallback:args[at+1];};
const serial=option('--serial');if(!serial||serial.startsWith('--'))throw new Error('--serial must name an existing device');
const artifacts=resolve(option('--artifacts',join(root,'artifacts/sdk/flutter-android-host')));
const out=resolve(option('--out',join(artifacts,'device')));mkdirSync(out,{recursive:true});
const adb=process.env.ADB||join(process.env.ANDROID_HOME||join(os.homedir(),'Library/Android/sdk'),'platform-tools/adb');
const name='dev.weapp.weapp_sdk_consumer',ui='/sdcard/weapp-flutter-host.xml';
const build=JSON.parse(readFileSync(join(artifacts,'build-android.json'),'utf8'));
const apk=build.artifacts?.[0]?.file;
if(build.status!=='built'||!apk||createHash('sha256').update(readFileSync(apk)).digest('hex')!==build.artifacts[0].sha256)throw new Error('Build receipt does not match APK');
const commands=[],cleanupErrors=[];let installed=false;let result={schemaVersion:1,status:'failed',serial,cleanupErrors};
function command(argv,optional=false,binary=false){
 const value=spawnSync(adb,['-s',serial,...argv],{encoding:binary?null:'utf8',timeout:60000,maxBuffer:32*1024*1024});
 commands.push({argv,status:value.status,...(!binary?{stdout:value.stdout,stderr:value.stderr}:{})});
 if(!optional&&(value.error||value.status!==0))throw new Error(`adb failed: ${value.error?.message||value.stderr}`);return value;
}
function read(){try{return JSON.parse(command(['shell','run-as',name,'cat','files/sdk-flutter-host-lifecycle.json'],true).stdout);}catch{return null;}}
async function until(predicate){const end=Date.now()+90000;while(Date.now()<end){const v=read();if(v?.error)throw new Error(v.error);if(v&&predicate(v))return v;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for host lifecycle stage');}
function screen(label,value){writeFileSync(join(out,`${label}.png`),command(['exec-out','screencap','-p'],false,true).stdout);writeFileSync(join(out,`${label}.json`),JSON.stringify(value,null,2)+'\n');}
function button(label){
 command(['shell','uiautomator','dump',ui]);const xml=command(['shell','cat',ui]).stdout;writeFileSync(join(out,`${label.replaceAll(' ','-')}.xml`),xml);
 const node=[...xml.matchAll(/<node\b[^>]*>/g)].map(m=>m[0]).find(n=>n.includes(`text="${label}"`)||n.includes(`content-desc="${label}"`));
 if(!node)throw new Error(`Missing visible button ${label}`);const b=node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);if(!b)throw new Error('Button has no bounds');
 command(['shell','input','tap',String(Math.round((+b[1]+ +b[3])/2)),String(Math.round((+b[2]+ +b[4])/2))]);
}
function point(v,x,y){const g=v.geometry;return [Math.round((v.viewOrigin.x+x*v.viewSize.width/g.windowWidth)*g.pixelRatio),Math.round((v.viewOrigin.y+y*v.viewSize.height/g.windowHeight)*g.pixelRatio)];}
try{
 if(command(['get-state']).stdout.trim()!=='device')throw new Error('Device is offline');
 if(command(['shell','pm','path',name],true).stdout.trim())throw new Error(`Refusing to replace existing ${name}`);
 const since=command(['shell','date "+%m-%d %H:%M:%S.000"']).stdout.trim();
 installed=true;command(['install','-t',apk]);command(['shell','am','start','-W','-n',`${name}/.MainActivity`]);
 let v=await until(v=>v.stage==='scroll-parent-then-check'&&v.geometry);screen('initial',v);
 const ratio=v.geometry.pixelRatio,x=Math.round((v.viewOrigin.x+v.viewSize.width/2)*ratio);
 command(['shell','input','swipe',String(x),String(Math.round((v.viewOrigin.y-30)*ratio)),String(x),String(Math.round((v.viewOrigin.y-110)*ratio)),'650']);
 v=await until(v=>v.parentOffset>=20);screen('parent-scrolled',v);button('Check parent');
 v=await until(v=>v.stage==='click-child-after-parent-scroll');command(['shell','input','tap',...point(v,v.geometry.tap.x,v.geometry.tap.y).map(String)]);
 v=await until(v=>v.stage==='scroll-child');screen('child-tapped',v);const s=v.geometry.scroll;
 command(['shell','input','swipe',...point(v,s.left+s.width/2,s.top+s.height*.8).map(String),...point(v,s.left+s.width/2,s.top+s.height*.2).map(String),'650']);
 v=await until(v=>v.stage==='move-route');screen('child-scrolled',v);button('Move route');
 v=await until(v=>v.stage==='pop-flutter-route');screen('detail-route',v);button('Back');
 v=await until(v=>v.stage==='ready-to-close');screen('primary-returned',v);button('Close SDK');
 v=await until(v=>v.stage==='complete');screen('complete',v);
 const logs=command(['logcat','-d','-T',since,'WeappContainer:V','skia:V','AndroidRuntime:E','*:S']).stdout;writeFileSync(join(out,'logcat.txt'),logs);
 result={...result,...v,cleanupErrors,apk,apkSha256:build.artifacts[0].sha256,buildReceipt:join(artifacts,'build-android.json'),distributionSha256:build.distributionSha256,harnessSha256:build.harnessSha256,
  abi:command(['shell','getprop','ro.product.cpu.abi']).stdout.trim(),api:command(['shell','getprop','ro.build.version.sdk']).stdout.trim(),targetKind:serial.startsWith('emulator-')?'emulator':'physical-device',observedRecoveryLogs:(logs.match(/Recreating invalid owned GLES context once/g)||[]).length};
 if(v.status!=='passed'||v.checks.length!==8)throw new Error(`Host lifecycle did not pass: ${JSON.stringify(v.issues)}`);
}catch(error){result.status='failed';result.error=error.stack;const last=read();if(last){result.lastReport=last;screen('failure',last);}process.exitCode=1;}
finally{
 if(installed)try{command(['shell','am','force-stop',name]);command(['uninstall',name]);if(command(['shell','pm','path',name],true).stdout.trim())throw new Error('Package remains installed');}catch(error){cleanupErrors.push({package:name,error:error.message});}
 try{command(['shell','rm','-f',ui]);}catch(error){cleanupErrors.push({resource:ui,error:error.message});}
 if(cleanupErrors.length){result.status='failed';process.exitCode=1;}
 writeFileSync(join(out,'commands.json'),JSON.stringify(commands,null,2)+'\n');writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
