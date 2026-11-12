// Deterministic synthetic PCM/guest fixture for real browser audio validation.
// This creates a new derived package; it never edits or resigns the source pack.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')}}`:JSON.stringify(value)
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const check=(value,message)=>{if(!value)throw new Error(message)}
export function audioProbeWav() {
  const rate=22050,frames=rate*4,bytes=Buffer.alloc(44+frames*2)
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16)
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40)
  for(let frame=0;frame<frames;frame++)bytes.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*frame/rate)*1638),44+frame*2)
  return bytes
}
const guestSource=`
// Explicit synthetic browser audio fixture, not upstream application behavior.
var __hostAudio=null,__hostAudioLog=[];
function __hostAudioDone(name,promise){if(promise&&typeof promise.then==='function')promise.then(function(){__hostAudioLog.push([name+'-resolved']);},function(error){__hostAudioLog.push([name+'-rejected',error.code,error.errMsg||error.message]);});}
exports.__hostAudioCreate=function(){__hostAudioLog=[];__hostAudio=wx.createInnerAudioContext();['Canplay','Play','Pause','Ended','TimeUpdate','Error'].forEach(function(name){__hostAudio['on'+name](function(value){__hostAudioLog.push([name,value.currentTime,value.duration,value.errCode,value.errMsg]);});});__hostAudio.volume=0;return 'created';};
exports.__hostAudioSource=function(value){__hostAudio.src=value;return 'source-queued';};
exports.__hostAudioPlay=function(){__hostAudioDone('play',__hostAudio.play());return 'play-queued';};
exports.__hostAudioPause=function(){__hostAudioDone('pause',__hostAudio.pause());return 'pause-queued';};
exports.__hostAudioDestroy=function(){__hostAudioDone('destroy',__hostAudio.destroy());return 'destroy-queued';};
exports.__hostAudioRead=function(){return {log:__hostAudioLog,properties:{src:__hostAudio.src,duration:__hostAudio.duration,currentTime:__hostAudio.currentTime,paused:__hostAudio.paused,volume:__hostAudio.volume}};};
`

export async function createHostServicesAudioFixture({pack,out}) {
  const input=resolve(pack),destination=resolve(out),manifestBytes=await readFile(join(input,'manifest.json')),manifest=JSON.parse(manifestBytes)
  check(manifest.integrity?.algorithm==='sha256'&&digest(canonical({...manifest,integrity:{...manifest.integrity,root:''}}))===manifest.integrity.root,'source package canonical root mismatch')
  const sourceRoot=manifest.integrity.root,blobs=new Map()
  for(const name of (await readdir(join(input,'blobs/sha256'))).sort()) {
    check(/^[a-f0-9]{64}$/.test(name),'unexpected source blob filename')
    const bytes=await readFile(join(input,'blobs/sha256',name));check(digest(bytes)===name,'source package blob mismatch');blobs.set(name,bytes)
  }
  const entry=manifest.modules.find(module=>module.id.replace(/^module:/,'')===manifest.app.entryModule.replace(/^module:/,''))
  check(entry?.format==='commonjs'&&blobs.has(entry.sha256),'source requires a verified CommonJS app entry')
  const source=blobs.get(entry.sha256).toString('utf8');check(!source.includes('__hostAudio'),'fixture export collision')
  const changed=Buffer.from(source+guestSource),wav=audioProbeWav();blobs.set(digest(changed),changed);blobs.set(digest(wav),wav)
  entry.sha256=digest(changed);manifest.compiler.commit='explicit-browser-audio-probe'
  manifest.assets=manifest.assets.filter(asset=>asset.path!=='assets/host-audio-probe.wav')
  manifest.assets.push({path:'assets/host-audio-probe.wav',sha256:digest(wav),size:wav.length,mime:'audio/wav'})
  manifest.capabilities['wx.createInnerAudioContext']='partial'
  manifest.integrity.root='';manifest.integrity.root=digest(canonical(manifest))
  const outputManifest=Buffer.from(canonical(manifest)),index={schemaVersion:1,manifest:'manifest.json',manifestSha256:digest(outputManifest),integrityRoot:manifest.integrity.root,blobs:[...blobs].map(([sha256,bytes])=>({sha256,size:bytes.length,url:`blobs/sha256/${sha256}`}))}
  // Avoid silently replacing another validation fixture or evidence directory.
  await mkdir(destination,{recursive:false});await mkdir(join(destination,'blobs/sha256'),{recursive:true})
  for(const [sha,bytes]of blobs)await writeFile(join(destination,'blobs/sha256',sha),bytes)
  await writeFile(join(destination,'manifest.json'),outputManifest);await writeFile(join(destination,'pack-index.json'),canonical(index))
  await writeFile(join(destination,'remote.wav'),wav)
  const report={schemaVersion:1,classification:'explicit-synthetic-audio-fixture',sourceRoot,integrityRoot:manifest.integrity.root,entryModule:entry.id,assetPath:'assets/host-audio-probe.wav',wav:{sha256:digest(wav),bytes:wav.length,format:'PCM signed 16-bit little-endian mono',sampleRate:22050,durationSeconds:4},index:{sha256:digest(canonical(index)),size:Buffer.byteLength(canonical(index))},physicalAudioOutput:'not-run'}
  await writeFile(join(destination,'fixture-report.json'),JSON.stringify(report,null,2)+'\n')
  return report
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),value=name=>{const at=args.indexOf(name);return at<0?null:args[at+1]}
  check(args.length===4&&value('--pack')&&value('--out'),'Usage: node scripts/create-host-services-audio-fixture.mjs --pack <portable-pack> --out <new-served-directory>')
  console.log(JSON.stringify(await createHostServicesAudioFixture({pack:value('--pack'),out:value('--out')})))
}
