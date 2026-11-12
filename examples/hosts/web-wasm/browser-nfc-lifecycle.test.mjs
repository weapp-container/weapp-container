import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {BrowserHostServices} from './browser-host-services.mjs'

const catalog=JSON.parse(await readFile(new URL('../../../crates/container-runtime/src/host-api-catalog.json',import.meta.url)))
const nfcNames=catalog.apis.filter(api=>api.name==='wx.getNFCAdapter'||/^object:(NFCAdapter|Ndef|IsoDep|MifareClassic|MifareUltralight|Nfc[ABFV])\./.test(api.name)).map(api=>api.name)
const trusted={application:{hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'app',environment:'release',version:'1',packRoot:'a'.repeat(64)},account:{principalId:'alice',epoch:1}}
const turn=()=>new Promise(resolve=>setImmediate(resolve))

class Transport {
  requests=[];completions=[];sequence=0
  host_services_protocol_json(){return '{"version":"1.0"}'}
  configure_host_services_json(value){this.config=JSON.parse(value)}
  take_host_requests_json(){return JSON.stringify(this.requests.splice(0))}
  complete_host_api_call_json(callId,value){this.completions.push({callId,...JSON.parse(value)});return '{}'}
  dispatch_host_api_event_json(){throw new Error('an unavailable NFC producer emitted an event')}
  revoke_host_services_json(){return '[]'}
  call(method,payload={}){const callId='call-'+ ++this.sequence;this.requests.push({kind:'call',method,payload,callId,context:{...trusted,sessionId:'owner',callId,api:method}});return callId}
}

async function fixture({webNfc=true,register}={}) {
  const native={constructors:0,scans:0,writes:0,makeReadOnly:0,permissions:[]}
  class NDEFReader extends EventTarget {
    constructor(){super();native.constructors++}
    async scan(){native.scans++}
    async write(){native.writes++}
    async makeReadOnly(){native.makeReadOnly++}
  }
  const runtime=new Transport(),environment={isSecureContext:true,navigator:{permissions:{async query({name}){native.permissions.push(name);return {state:'granted'}}}},setTimeout,clearTimeout,
    document:Object.assign(new EventTarget(),{hidden:false}),window:new EventTarget(),...(webNfc?{NDEFReader}:{})}
  const services=new BrowserHostServices({runtime,catalog,environment})
  register?.(services)
  const capabilities=await services.configure(trusted)
  const flush=async()=>{await services.drain();await turn();await services.drain()}
  return {services,runtime,native,capabilities,flush}
}

test('Web NFC availability never advertises the locked wx tag-reader contract or requests a device',async()=>{
  const f=await fixture()
  try {
    assert.equal(nfcNames.length,66)
    for(const name of nfcNames){assert.ok(!f.capabilities.apis.includes(name),name);assert.ok(!f.runtime.config.apis.includes(name),name)}
    assert.equal(f.capabilities.secureContext,true)
    assert.equal(f.native.constructors,0);assert.equal(f.native.scans,0);assert.equal(f.native.writes,0);assert.equal(f.native.makeReadOnly,0)
    assert.ok(!f.native.permissions.includes('nfc'))
  } finally {await f.services.close()}
  assert.equal(f.native.constructors,0)
})

test('requests bypassing unavailable NFC capabilities fail without creating retained readers, prompts or events',async()=>{
  const f=await fixture()
  try {
    for(const name of nfcNames)f.runtime.call(name,{objectId:'untrusted-reader',subscriptionId:'untrusted-nfc',action:'subscribe'})
    await f.flush()
    assert.equal(f.runtime.completions.length,nfcNames.length)
    assert.ok(f.runtime.completions.every(value=>value.error?.code==='unsupported'))
    assert.equal(f.services.binary.size,0)
    assert.equal(f.native.constructors,0);assert.equal(f.native.scans,0);assert.equal(f.native.writes,0);assert.equal(f.native.makeReadOnly,0)
    assert.ok(!f.native.permissions.includes('nfc'))
  } finally {await f.services.close()}
})

test('a separately supplied trusted native NFC handler keeps its explicit capability without browser NFC interference',async()=>{
  let calls=0
  const f=await fixture({register:services=>services.registerApiHandler('object:NFCAdapter.startDiscovery',()=>{calls++;return {errMsg:'startDiscovery:ok'}})})
  try {
    assert.deepEqual(f.capabilities.apis.filter(name=>nfcNames.includes(name)),['object:NFCAdapter.startDiscovery'])
    f.runtime.call('object:NFCAdapter.startDiscovery');await f.flush()
    assert.equal(calls,1);assert.equal(f.runtime.completions[0].result.errMsg,'startDiscovery:ok')
    assert.equal(f.native.constructors,0);assert.equal(f.native.scans,0)
  } finally {await f.services.close()}
})

test('browsers without Web NFC expose the same truthful default NFC subset',async()=>{
  const f=await fixture({webNfc:false})
  try {assert.ok(nfcNames.every(name=>!f.capabilities.apis.includes(name)))}
  finally {await f.services.close()}
})
