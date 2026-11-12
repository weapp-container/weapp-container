#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
const args=process.argv.slice(2);
const values=key=>args.flatMap((v,i)=>v===key?[args[i+1]]:[]);
const option=key=>values(key)[0];
for(const key of ['--receipt','--distribution','--out'])if(!option(key)||option(key).startsWith('--'))throw new Error(`${key} is required`);
const receipt=resolve(option('--receipt')),distribution=resolve(option('--distribution')),output=resolve(option('--out'));
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const built=JSON.parse(readFileSync(receipt,'utf8')),manifest=JSON.parse(readFileSync(distribution,'utf8'));
if(built.status!=='built'||!built.packageInputDigests)throw new Error('A successful build with packageInputDigests is required');
const packages=resolve(option('--packages')||manifest.packages);
const inputs=built.packageInputDigests;
if(!Object.keys(inputs).length)throw new Error('Build input digests are empty');
const allowed=new Map(values('--allow-change').map(v=>{const at=v.indexOf('=');if(at<1||at===v.length-1)throw new Error('Use --allow-change path=reviewed-reason');return[v.slice(0,at),v.slice(at+1)];}));
const ignored=new Set(['build','.dart_tool','.gradle','.cxx','pubspec.lock']);
const scopes=[...new Set(Object.keys(inputs).map(file=>file.split('/')[0]))].sort();
const current={};
function scan(directory,prefix){for(const e of readdirSync(directory,{withFileTypes:true})){if(ignored.has(e.name))continue;const name=`${prefix}/${e.name}`,file=resolve(directory,e.name);if(e.isDirectory())scan(file,name);else if(e.isFile())current[name]=hash(file);}}
for(const scope of scopes){if(!/^weapp_container(?:_[a-z_]+)?$/.test(scope))throw new Error(`Unexpected package scope ${scope}`);scan(resolve(packages,scope),scope);}
const changed=[],unchanged=[];
for(const file of [...new Set([...Object.keys(inputs),...Object.keys(current)])].sort()){
 if(!resolve(packages,file).startsWith(packages+sep)||file.split('/').some(v=>v==='.'||v==='..')||inputs[file]&&!/^[a-f0-9]{64}$/.test(inputs[file]))throw new Error(`Invalid digest path ${file}`);
 if(inputs[file]===current[file])unchanged.push({file,sha256:current[file]});
 else changed.push({file,testedSha256:inputs[file]||null,finalSha256:current[file]||null,reason:allowed.get(file)||null});
}
const unapproved=changed.filter(v=>!v.reason);
for(const key of allowed.keys())if(!changed.some(v=>v.file===key))throw new Error(`Stale change allowance ${key}`);
const evidence=values('--evidence').map(path=>{path=resolve(path);const value=JSON.parse(readFileSync(path,'utf8'));if(value.status!=='passed')throw new Error(`Evidence did not pass: ${path}`);
 const apk=value.apkSha256;if(apk&&!built.artifacts?.some(a=>a.sha256===apk))throw new Error(`Device APK differs from build: ${path}`);
 if(value.applicationBundleSha256&&built.applicationBundleSha256&&value.applicationBundleSha256!==built.applicationBundleSha256)throw new Error(`Installed app bundle differs from build: ${path}`);
 return{path,sha256:hash(path),status:value.status,apkSha256:apk,applicationBundleSha256:value.applicationBundleSha256};});
if(!evidence.length)throw new Error('At least one passing --evidence receipt is required');
const artifactFiles=(built.artifacts||[]).map(item=>{const file=item.file||item.path;if(typeof file!=='string')throw new Error('Build artifact has no path');if(existsSync(file)&&hash(file)!==item.sha256)throw new Error(`Built artifact changed: ${file}`);return{...item,availableLocally:existsSync(file)};});
const result={schemaVersion:1,status:unapproved.length?'failed':'verified',platform:built.platform,distributionSha256:hash(distribution),distribution,packages,sourceBuild:{receipt,sha256:hash(receipt),distributionSha256:built.distributionSha256,artifacts:artifactFiles,applicationBundleSha256:built.applicationBundleSha256},evidence,scope:scopes,unchangedCount:unchanged.length,changed,unchanged};
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,platform:result.platform,unchanged:unchanged.length,changed},null,2));
if(unapproved.length)process.exitCode=1;
