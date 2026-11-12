import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHostServicesAudioFixture } from './create-host-services-audio-fixture.mjs'
const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')}}`:JSON.stringify(value)
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const source=`
// Explicit recorder probe exports; source input is synthetic Web Audio, not a microphone.
var __hostRecorder=null,__hostRecorderLog=[],__hostRecorderFile=null,__hostRecorderFs=null;
function __hostRecorderDone(name,promise){promise.then(function(){__hostRecorderLog.push([name+'-resolved']);},function(error){__hostRecorderLog.push([name+'-rejected',error.code,error.errMsg||error.message]);});}
exports.__hostRecorderCreate=function(){__hostRecorderLog=[];__hostRecorderFile=null;__hostRecorder=wx.getRecorderManager();['Start','Pause','Resume','Stop','Error','InterruptionBegin'].forEach(function(name){__hostRecorder['on'+name](function(value){__hostRecorderLog.push([name,value]);if(name==='Stop')__hostRecorderFile=value.tempFilePath;});});return 'created';};
exports.__hostRecorderStart=function(){__hostRecorderDone('start',__hostRecorder.start({format:'wav',sampleRate:8000,numberOfChannels:2,duration:5000}));return 'start-queued';};
exports.__hostRecorderPause=function(){__hostRecorderDone('pause',__hostRecorder.pause());return 'pause-queued';};
exports.__hostRecorderResume=function(){__hostRecorderDone('resume',__hostRecorder.resume());return 'resume-queued';};
exports.__hostRecorderStop=function(){__hostRecorderDone('stop',__hostRecorder.stop());return 'stop-queued';};
exports.__hostRecorderRead=function(){return {log:__hostRecorderLog,file:__hostRecorderFile};};
exports.__hostRecorderReadFile=function(){__hostRecorderFs=wx.getFileSystemManager();__hostRecorderFs.readFile({filePath:__hostRecorderFile}).then(function(value){var bytes=new Uint8Array(value.data),nonzero=false;for(var n=44;n<bytes.length;n++)if(bytes[n]!==0){nonzero=true;break;}__hostRecorderLog.push(['private-read',{arrayBuffer:value.data instanceof ArrayBuffer,bytes:bytes.length,header:Array.prototype.slice.call(bytes,0,44),nonzero:nonzero}]);},function(error){__hostRecorderLog.push(['read-rejected',error.code,error.errMsg||error.message]);});return 'read-queued';};
exports.__hostRecorderRemoveFile=function(){__hostRecorderDone('private-delete',__hostRecorderFs.unlink({filePath:__hostRecorderFile}));return 'delete-queued';};
`
export async function createHostServicesRecorderFixture({pack,out}) {
  const prior=await createHostServicesAudioFixture({pack,out}),destination=resolve(out),manifest=JSON.parse(await readFile(join(destination,'manifest.json'),'utf8')),index=JSON.parse(await readFile(join(destination,'pack-index.json'),'utf8'))
  const entry=manifest.modules.find(module=>module.id.replace(/^module:/,'')===manifest.app.entryModule.replace(/^module:/,'')),bytes=await readFile(join(destination,'blobs/sha256',entry.sha256))
  if(bytes.toString('utf8').includes('exports.__hostRecorderCreate'))throw new Error('recorder fixture export collision')
  const changed=Buffer.concat([bytes,Buffer.from(source)]),sha=digest(changed);await writeFile(join(destination,'blobs/sha256',sha),changed);entry.sha256=sha
  manifest.compiler.commit='explicit-browser-recorder-probe';manifest.capabilities['wx.getRecorderManager']='partial';manifest.integrity.root='';manifest.integrity.root=digest(canonical(manifest))
  const manifestBytes=Buffer.from(canonical(manifest));await writeFile(join(destination,'manifest.json'),manifestBytes)
  index.manifestSha256=digest(manifestBytes);index.integrityRoot=manifest.integrity.root;index.blobs.push({sha256:sha,size:changed.length,url:`blobs/sha256/${sha}`});await writeFile(join(destination,'pack-index.json'),canonical(index))
  const report={schemaVersion:1,classification:'explicit-synthetic-recorder-fixture',sourceRoot:prior.sourceRoot,priorAudioFixtureRoot:prior.integrityRoot,integrityRoot:manifest.integrity.root,entryModule:entry.id,index:{sha256:digest(canonical(index)),size:Buffer.byteLength(canonical(index))},physicalMicrophone:'not-run'}
  await writeFile(join(destination,'fixture-report.json'),JSON.stringify(report,null,2)+'\n');return report
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),value=name=>{const at=args.indexOf(name);return at<0?null:args[at+1]}
  if(args.length!==4||!value('--pack')||!value('--out'))throw new Error('Usage: node scripts/create-host-services-recorder-fixture.mjs --pack <portable-pack> --out <new-served-directory>')
  console.log(JSON.stringify(await createHostServicesRecorderFixture({pack:value('--pack'),out:value('--out')})))
}
