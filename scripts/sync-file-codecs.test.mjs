import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../crates/container-core/src/host-bridge.js',import.meta.url),'utf8');
const catalog=JSON.parse(readFileSync(process.env.WEAPP_CODEC_CATALOG || new URL('../crates/container-runtime/src/host-api-catalog.json',import.meta.url),'utf8'));
// A wire-only native test double: no implementation or filesystem claim.
function realm(){
  const calls=[];const resolved=[];let response=null;
  const context=vm.createContext({wx:{canIUse:()=>true},
    __container_report_error:()=>{},__container_errors:[],__container_events:[],
    __container_capability:()=> 'full',__container_options:o=>o,
    __container_async_result:()=>Promise.resolve({}),__container_api_pending:{},__container_api_id:0,
    __container_api_call:()=>Promise.resolve({}),__container_resolve_api:(id,result,error)=>resolved.push({id,result,error}),resolved,
    __container_host_sync_call:(api,wire)=>{calls.push({api,payload:JSON.parse(wire)});return JSON.stringify({ok:true,value:response});}
  });
  vm.runInContext(source,context);
  const names=['wx.getFileSystemManager','object:FileSystemManager.writeFileSync','object:FileSystemManager.appendFileSync','object:FileSystemManager.readFileSync','object:FileSystemManager.writeSync','object:FileSystemManager.readSync'];
  const descriptors=catalog.apis.filter(a=>names.includes(a.name)).map(a=>({...a,parameters:a.signatures[0].parameters.map(p=>p.name)}));
  context.__container_install_host_services({apis:descriptors,objectApis:descriptors.filter(a=>a.receiver)});
  vm.runInContext('globalThis.fs=wx.getFileSystemManager()',context);
  return {calls,resolved,run:s=>vm.runInContext(s,context),response:v=>{response=v;}};
}
const text=units=>({__weappSyncText:{type:'UTF16',units}});

test('public sync writes project every original UTF-16 code unit before JSON',()=>{
  const r=realm();
  for(const alias of ['ascii','base64','binary','hex','ucs2','ucs-2','utf16le','utf-16le','utf-8','utf8','latin1']){
    r.run(`globalThis.input='\\ud800A\\udc00😀é';fs.writeFileSync('wxfile://user/a',input,${JSON.stringify(alias)})`.replaceAll('\\\\u','\\u'));
    const {payload}=r.calls.at(-1);
    assert.deepEqual(payload.data,text([0xd800,65,0xdc00,0xd83d,0xde00,0xe9]));assert.equal(payload.encoding,alias);
    assert.equal(payload.args,undefined);
  }
  r.run(`fs.appendFileSync('wxfile://user/a','\ud800','ucs2');fs.writeSync({fd:'fd',data:'\udc00',encoding:'utf16le',offset:99,length:1})`);
  assert.deepEqual(r.calls.at(-2).payload.data,text([0xd800]));assert.deepEqual(r.calls.at(-1).payload.data,text([0xdc00]));
});
test('readFileSync alone materializes typed text including isolated surrogates',()=>{
  const r=realm();r.response(text([0,0xd800,65,0xdc00,0xd83d,0xde00,0xffff]));
  const result=r.run(`fs.readFileSync('wxfile://user/a','ucs2')`);
  assert.deepEqual(Array.from({length:result.length},(_,i)=>result.charCodeAt(i)),[0,0xd800,65,0xdc00,0xd83d,0xde00,0xffff]);
  r.run(`String.fromCharCode=()=>{throw Error('poisoned')};String.prototype.charCodeAt=()=>{throw Error('poisoned')};Object.create=()=>{throw Error('poisoned')}`);
  assert.equal(r.run(`fs.readFileSync('wxfile://user/a','ucs2').length`),7);
  r.run(`fs.writeFileSync('wxfile://user/a','\ud800','ucs2')`);assert.deepEqual(r.calls.at(-1).payload.data,text([0xd800]));
});
test('async readFile materializes the shared typed text projection at delivery',()=>{
  const r=realm();
  r.run(`__container_api_pending[9]={name:'object:FileSystemManager.readFile'};__container_resolve_api(9,{data:${JSON.stringify(text([0xd800,65,0xdc00,0xd83d,0xde00]))}},null)`);
  assert.deepEqual(JSON.parse(r.run(`JSON.stringify(Array.from({length:resolved.at(-1).result.data.length},(_,i)=>resolved.at(-1).result.data.charCodeAt(i)))`)),[0xd800,65,0xdc00,0xd83d,0xde00]);
  r.run(`__container_api_pending[10]={name:'object:FileSystemManager.readFile'};__container_resolve_api(10,{data:{__weappBinary:{type:'ArrayBuffer',bytes:[0,128,255]}}},null)`);
  assert.equal(r.run(`resolved.at(-1).result.data instanceof ArrayBuffer`),true);
  assert.equal(r.run(`resolved.at(-1).result.data.byteLength`),3);
});
test('genuine ArrayBuffer bytes and readSync caller identity keep their binary path',()=>{
  const r=realm();r.run(`globalThis.buffer=new Uint8Array([0,128,255]).buffer;fs.writeFileSync('wxfile://user/a',buffer,'hex')`);
  assert.deepEqual(r.calls.at(-1).payload.data,{__weappBinary:{type:'ArrayBuffer',bytes:[0,128,255]}});
  r.response({__weappBinary:{type:'ArrayBuffer',bytes:[0,128,255]}});
  assert.equal(r.run(`fs.readFileSync('wxfile://user/a') instanceof ArrayBuffer`),true);
  r.response({bytesRead:2,arrayBuffer:{__weappBinary:{type:'ArrayBuffer',bytes:[1,2,255]}}});
  assert.equal(r.run(`fs.readSync({fd:'fd',arrayBuffer:buffer,length:2}).arrayBuffer===buffer`),true);
  assert.deepEqual(Array.from(new Uint8Array(r.run('buffer'))),[1,2,255]);
});
test('private string projection reaches native wire once despite Array prototype toJSON',()=>{
  const r=realm();
  r.run(`Array.prototype.toJSON=function(){return [66]}`);
  r.run(`fs.writeFileSync('wxfile://user/a','A','utf8')`);
  assert.deepEqual(r.calls.at(-1).payload.data,text([65]));
  r.run(`Array.prototype.toJSON=function(){throw Error('guest array serializer')}`);
  r.run(`fs.appendFileSync('wxfile://user/a','\\ud800','ucs2')`);
  assert.deepEqual(r.calls.at(-1).payload.data,text([0xd800]));
  r.run(`fs.writeSync({fd:'fd',data:'\\udc00',encoding:'utf16le'})`);
  assert.deepEqual(r.calls.at(-1).payload.data,text([0xdc00]));
});
test('text unit and JSON budgets reject before reaching the native owner',()=>{
  const r=realm();
  assert.throws(()=>r.run(`fs.writeFileSync('wxfile://user/a','A'.repeat(2097153),'utf8')`),
    error=>error.code==='ERR_INVALID_REQUEST'&&/code-unit budget/.test(error.errMsg));
  assert.equal(r.calls.length,0);
  assert.throws(()=>r.run(`fs.writeFileSync('wxfile://user/a','\\uffff'.repeat(1500000),'utf16le')`),
    /native API payload exceeds byte budget/);
  assert.equal(r.calls.length,0);
});
test('forged public text markers, typed-array writes, and malformed native code units fail explicitly',()=>{
  const r=realm();
  for(const input of [`{__weappSyncText:{type:'UTF16',units:[65]}}`,`new Uint8Array([65])`,`{}`]){
    assert.throws(()=>r.run(`fs.writeFileSync('wxfile://user/a',${input})`),e=>e.code==='ERR_INVALID_REQUEST');
  }
  for(const value of [text([65536]),text([-1]),text([1.5]),text(['65']),{__weappSyncText:{type:'UTF16',units:[]},extra:true},{__weappSyncText:{type:'UTF16',units:[],extra:true}}]){
    r.response(value);assert.throws(()=>r.run(`fs.readFileSync('wxfile://user/a','ucs2')`),/invalid synchronous file/);
  }
});
