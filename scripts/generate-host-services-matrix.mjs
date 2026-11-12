// Source inventory, never a substitute for seven-platform acceptance evidence.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { hosts, sdkChains, validateResponsibilities, validateAcceptanceLedger, buildApiCells, resolveImplementation } from './host-api-matrix.mjs'
import { createMatrixValidationIo } from './host-api-matrix-io.mjs'
import { inventoryCoreApis } from './core-api-inventory.mjs'
import { BrowserHostServices } from '../examples/hosts/web-wasm/browser-host-services.mjs'
import { cppInventory } from './cpp-api-inventory.mjs'

const args=process.argv.slice(2),check=args.length===1&&args[0]==='--check'
if(args.length&&!check)throw new Error('Usage: node scripts/generate-host-services-matrix.mjs [--check]')
const root = new URL('../',import.meta.url), path = relative => new URL(relative,root)
const io = await createMatrixValidationIo(fileURLToPath(root)), read = io.read
const catalogText = await read('crates/container-runtime/src/host-api-catalog.json'), catalog=JSON.parse(catalogText)
const nativePaths = {
  android:[
    'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/AndroidDeviceApis.kt',
    'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/AndroidBluetoothApis.kt',
    'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/HostServicesClient.kt',
    'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/AndroidAppPayments.kt',
    'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/AndroidManagedFiles.kt',
    'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/AndroidNativeMedia.kt',
    'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/AndroidNetworkApis.kt',
    'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/AndroidRecorderApis.kt',
    'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/AndroidSystemApis.kt',
    'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/AndroidNdefApis.kt',
    'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/AndroidBeaconApis.kt',
    'sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/AndroidWifiApis.kt',
  ],
  ios:[
    'sdk/ios/Sources/WeappContainer/DeviceApis.swift',
    'sdk/ios/Sources/WeappContainer/HostServicesClient.swift',
    'sdk/ios/Sources/WeappContainer/AppPayments.swift',
    'sdk/ios/Sources/WeappContainer/ManagedFiles.swift',
    'sdk/ios/Sources/WeappContainer/NativeMedia.swift',
    'sdk/ios/Sources/WeappContainer/BluetoothApis.swift',
    'sdk/ios/Sources/WeappContainer/NetworkApis.swift',
    'sdk/ios/Sources/WeappContainer/RecorderApis.swift',
    'sdk/ios/Sources/WeappContainer/SystemApis.swift',
    'sdk/ios/Sources/WeappContainer/BeaconApis.swift',
    'sdk/ios/Sources/WeappContainer/WifiApis.swift',
    'sdk/ios/Sources/WeappContainer/NfcApis.swift',
  ],
  harmony:['examples/hosts/harmony/entry/src/main/ets/native/HarmonyDeviceApis.ets','examples/hosts/harmony/entry/src/main/ets/native/HarmonyManagedFiles.ets','examples/hosts/harmony/entry/src/main/ets/native/HarmonyNetworkApis.ets','examples/hosts/harmony/entry/src/main/ets/native/HarmonySocketApis.ets','examples/hosts/harmony/entry/src/main/ets/native/HarmonySystemApis.ets','examples/hosts/harmony/entry/src/main/ets/native/HarmonyBluetoothApis.ets','examples/hosts/harmony/entry/src/main/ets/native/HarmonyRecorderApis.ets','examples/hosts/harmony/entry/src/main/ets/native/HarmonyWifiApis.ets','examples/hosts/harmony/entry/src/main/ets/native/HarmonyNfcApis.ets','examples/hosts/harmony/entry/src/main/ets/session/ReferenceHostServices.ts'],
  macos:['sdk/desktop/src/host_services_adapter.cpp','sdk/desktop/src/device_apis_common.hpp','sdk/desktop/src/device_apis_macos.mm'],
  windows:['sdk/desktop/src/host_services_adapter.cpp','sdk/desktop/src/device_apis_common.hpp','sdk/desktop/src/device_socket_common.hpp','sdk/desktop/src/device_location_common.hpp','sdk/desktop/src/device_bluetooth_common.hpp','sdk/desktop/src/device_bluetooth_winrt.hpp','sdk/desktop/src/device_sensor_common.hpp','sdk/desktop/src/device_sensor_winrt.hpp','sdk/desktop/src/device_audio_common.hpp','sdk/desktop/src/device_audio_winrt.hpp','sdk/desktop/src/device_audio_wave.hpp','sdk/desktop/src/device_apis_windows.cpp'],
  linux:['sdk/desktop/src/host_services_adapter.cpp','sdk/desktop/src/device_apis_common.hpp','sdk/desktop/src/device_socket_common.hpp','sdk/desktop/src/device_location_common.hpp','sdk/desktop/src/device_bluetooth_common.hpp','sdk/desktop/src/device_bluetooth_bluez.hpp','sdk/desktop/src/device_apis_linux.cpp'],
}
const native = new Map(), sources = {}, known=new Set(catalog.apis.map(api=>api.name))
const strings=value=>[...value.matchAll(/["']([^"']+)["']/g)].map(match=>match[1])
function literalInventory(source,relative) {
  const declarations=[...source.matchAll(/\b(?:supportedApis|syncApis|potentialApis)\b[^\n=]*=\s*(?:setOf\(|\[)/g)]
  if(!declarations.length) {
    const result=new Set()
    for(const match of source.matchAll(/registerApiHandler\(\s*["']([^"']+)["']/g))result.add(match[1])
    for(const match of source.matchAll(/(?:(?:arrayOf|setOf)\(|for api in \[)([^)\]]+)(?:\)|\])/g)) {
      if(!source.slice(match.index,match.index+match[0].length+150).includes('registerApiHandler(api)'))continue
      for(const name of strings(match[1]))result.add(name)
    }
    if(!result.size)throw new Error(`Cannot inventory ${relative}`)
    return [...result]
  }
  const result=new Set()
  for(const match of source.matchAll(/setSyncSnapshot\(\s*["']([^"']+)["']/g))result.add(match[1])
  for(const match of source.matchAll(/\bsupportedApis\.push\(([^)]+)\)/g))for(const name of strings(match[1]))result.add(name)
  for(const declaration of declarations){
    const start=declaration.index+declaration[0].length,closing=declaration[0].endsWith('[')?']':')'
    const end=source.indexOf(closing,start)
    if(end<0)throw new Error(`Unterminated API inventory ${relative}`)
    for(const name of strings(source.slice(start,end)).filter(name=>/^(?:wx\.|object:|weappContainer\.|component:)/.test(name)))result.add(name)
  }
  return [...result]
}
for(const [host,paths] of Object.entries(nativePaths)) {
  const names=new Set(),entries=[]
  for(const relative of paths) {
    let source
    try{source=await read(relative)}catch(error){if(error.code==='ENOENT')continue;throw error}
    const inventory=/\.(?:cpp|mm|hpp)$/.test(relative)?cppInventory(source,known,relative):literalInventory(source,relative)
    if(relative.endsWith('/host_services_adapter.cpp')&&!inventory.length)throw new Error(`Missing installed host service inventory: ${relative}`)
    for(const name of inventory){if(!known.has(name))throw new Error(`Unknown registered API ${name} in ${relative}`);names.add(name)}
    entries.push({path:relative,sha256:createHash('sha256').update(source).digest('hex'),registeredApis:inventory.sort()})
  }
  // Shared file/consent code is not a linked platform implementation when the
  // matching DeviceApis::create translation unit is absent.
  if(['macos','windows','linux'].includes(host)&&!entries.some(entry=>/device_apis_(?:macos\.mm|windows\.cpp|linux\.cpp)$/.test(entry.path)))names.clear()
  native.set(host,names);sources[host]=entries
}
// This feature shell lists concrete adapter registrations without invoking a
// browser API, granting a permission, creating a device or asserting support.
const runtime={host_services_protocol_json:()=>'{"version":"1.0"}',configure_host_services_json:()=>{},revoke_host_services_json:()=>{}}
const document=Object.assign(new EventTarget(),{hidden:false}), eventTarget=new EventTarget()
const privateDirectory={async getDirectoryHandle(){return this}}
const environment={navigator:{onLine:true,storage:{getDirectory:async()=>privateDirectory},geolocation:{watchPosition(){},clearWatch(){}},clipboard:{writeText(){},readText(){}},vibrate(){},share(){},wakeLock:{request(){}},getBattery(){},permissions:{query(){}},bluetooth:{requestDevice(){},getAvailability(){},getDevices(){}},mediaDevices:{getUserMedia(){}}},
  window:eventTarget,document,location:{origin:'https://inventory.invalid',href:'https://inventory.invalid/'},isSecureContext:true,
  fetch(){},WebSocket:class{},MediaRecorder:class{static isTypeSupported(value){return ['audio/mpeg','audio/aac','audio/wav'].includes(value)}},Audio:class{},DeviceMotionEvent:class{},DeviceOrientationEvent:class{},NDEFReader:class{},BarcodeDetector:class{},setTimeout,clearTimeout}
const delegated=['weappContainer.identity.getState','weappContainer.identity.onChange','weappContainer.identity.offChange','wx.login','wx.checkSession','wx.getUserInfo','wx.getUserProfile','weappContainer.identity.logout','weappContainer.identity.authorizePhone','component:button.open-type.getPhoneNumber','component:button.bindgetphonenumber','wx.requestPayment','weappContainer.payment.request']
const inventoryIdentity={application:{hostAppId:'inventory',tenantId:'inventory',publisherId:'inventory',appId:'inventory',environment:'release',version:'inventory',packRoot:'a'.repeat(64)},account:{principalId:null,epoch:'1'}}
// This inert grant discovers the explicitly configurable GATT subset without
// performing chooser/connection/notification operations or granting access.
const inventoryDevice=Object.assign(new EventTarget(),{id:'potential-device',gatt:{connect(){throw new Error('inventory cannot connect')},disconnect(){throw new Error('inventory cannot disconnect')}}})
const bluetooth={initialized:true,grants:[{...inventoryIdentity,device:inventoryDevice,exclusiveSession:true,purpose:'source inventory only',permissionVersion:'inventory',services:['180d']}]}
const adapter=new BrowserHostServices({runtime,catalog,environment,componentRoot:{},bluetooth,identity:{login(){},checkSession(){},getUserInfo(){},getUserProfile(){},logout(){},authorizePhone(){}},payment:{request(){},requestLegacy(){}}})
await adapter.configure(inventoryIdentity)
const browser=new Set(adapter.capabilities().apis);await adapter.close()
browser.add('component:camera');browser.add('component:video')
const browserSource=await read('examples/hosts/web-wasm/browser-host-services.mjs')
sources.web={path:'examples/hosts/web-wasm/browser-host-services.mjs',sha256:createHash('sha256').update(browserSource).digest('hex')}
sources.web.dependencies=[]
for(const relative of ['examples/hosts/web-wasm/reference-identity-client.mjs','examples/hosts/web-wasm/browser-bluetooth-owner.mjs','examples/hosts/web-wasm/browser-recorder-support.mjs','examples/hosts/web-wasm/browser-wav-recorder.mjs','examples/hosts/web-wasm/browser-wav-recorder-worklet.mjs'])sources.web.dependencies.push({path:relative,sha256:createHash('sha256').update(await read(relative)).digest('hex')})
const responsibilitiesPath='docs/host-services/api-responsibilities.json'
const responsibilitiesText=await read(responsibilitiesPath),responsibilities=JSON.parse(responsibilitiesText)
const responsibilityMap=validateResponsibilities(catalog,responsibilities)
const core=await inventoryCoreApis(catalog,read)
sources.core=core.sources
const contractsPath='docs/host-services/acceptance-contracts.json',ledgerPath='docs/host-services/acceptance-ledger.json'
const contractsText=await read(contractsPath),ledgerText=await read(ledgerPath)
const acceptance=await validateAcceptanceLedger({
  catalog,contracts:JSON.parse(contractsText),ledger:JSON.parse(ledgerText),
  load:io.load,readSource:io.readSource,readCommittedSource:io.readCommittedSource,verifyCommit:io.verifyCommit,
})
const buildEvidence=await read('docs/host-services/build-evidence.json')
const constraintsPath='docs/host-services/platform-constraints.json',constraintsText=await read(constraintsPath),constraints=JSON.parse(constraintsText)
const restrictions=new Map(),parameterLimits=new Map()
for(const entry of constraints.restrictions){
  if(!hosts.includes(entry.host)||!entry.scope||!entry.reason||!entry.evidence?.length||!entry.officialSources?.length)throw new Error('Invalid documented platform restriction')
  for(const evidence of entry.evidence)await read(evidence)
  for(const name of entry.apis){
    if(!known.has(name)||native.get(entry.host)?.has(name)||entry.host==='web'&&browser.has(name))throw new Error(`Restriction conflicts with an implementation or unknown API: ${entry.host}/${name}`)
    const key=JSON.stringify([entry.host,name]);if(restrictions.has(key))throw new Error(`Duplicate platform restriction: ${key}`);restrictions.set(key,entry)
  }
}
for(const entry of constraints.parameterLimits){
  if(!hosts.includes(entry.host)||!known.has(entry.api)||!entry.reason||!entry.evidence?.length)throw new Error('Invalid documented API parameter limit')
  for(const evidence of entry.evidence)await read(evidence)
  const key=JSON.stringify([entry.host,entry.api]);if(parameterLimits.has(key))throw new Error(`Duplicate parameter limit: ${key}`);parameterLimits.set(key,entry)
}
const matrix={schemaVersion:2,protocolVersion:catalog.protocolVersion,baseLibrary:catalog.baseline.baseLibrary,
  catalogSha256:createHash('sha256').update(catalogText).digest('hex'),hosts,sdkChains,
  statusDefinitions:{implementedAndAccepted:'Available implementation and reviewed, source/artifact-bound real SDK evidence for every declared profile and chain',pendingAcceptance:'Implementation, reviewed parameter/platform scope or real SDK evidence is incomplete',platformNotApplicable:'Documented platform restriction; never used for missing implementation'},
  implementationDefinitions:{present:'Concrete platform adapter registration exists; see implementationState and documented scope',delegated:'Requires explicitly supplied host account/payment service',runtimeOwned:'Protected wire boundary; does not assert implementation',absent:'No platform registration inventoried; inspect core source roles'},
  implementationStateDefinitions:{missing:'No implementation source found; a protected boundary alone does not count',partial:'Core bridge/facade or implementation has an unresolved provider or parameter scope',available:'Concrete core or platform implementation source found; acceptance remains separate',requiresHostService:'Installed client requires a configured host account/payment backend'},
  responsibilityDefinitions:responsibilities.definitions,
  responsibilities:{path:responsibilitiesPath,sha256:createHash('sha256').update(responsibilitiesText).digest('hex')},
  evidence:[{path:'docs/host-services/build-evidence.json',sha256:createHash('sha256').update(buildEvidence).digest('hex'),kind:'build-and-protocol-only',deviceAcceptance:false,merchantAcceptance:false}],sources,
  acceptanceContracts:{path:contractsPath,sha256:createHash('sha256').update(contractsText).digest('hex')},
  acceptanceLedger:{path:ledgerPath,sha256:createHash('sha256').update(ledgerText).digest('hex')},
  platformConstraints:{path:constraintsPath,sha256:createHash('sha256').update(constraintsText).digest('hex')},
  globalProperties:catalog.globalProperties,
  apis:buildApiCells({catalog,responsibilityMap,restrictions,parameterLimits,evidence:acceptance,
    implementation:(host,api)=>resolveImplementation({api,core:core.forHost(host,api.name),delegated:delegated.includes(api.name),parameterLimit:parameterLimits.get(JSON.stringify([host,api.name])),
      registeredSources:host==='web'?(browser.has(api.name)?[{id:'web'}]:[]):(native.get(host)?.has(api.name)?sources[host].filter(source=>source.registeredApis.includes(api.name)).map(source=>({path:source.path})):[]),
    }),
  }),
}
const json=JSON.stringify(matrix,null,2)+'\n'
const csv=[['API','Kind','Owner','Responsibility',...hosts].join(','),...matrix.apis.map(api=>[api.name,api.kind,api.owner,api.responsibility,...hosts.map(host=>`${api.hosts[host].implementationState}/${api.hosts[host].status}`)].join(','))].join('\n')+'\n'
const outputs=[['docs/host-services/api-matrix.json',json],['docs/host-services/api-matrix.csv',csv]]
if(check)for(const [relative,contents] of outputs)if(await readFile(path(relative),'utf8')!==contents)throw new Error(`Generated API matrix is stale: ${relative}`)
await io.assertUnchanged()
if(!check) {
  await mkdir(path('docs/host-services/'),{recursive:true})
  for(const [relative,contents] of outputs)await writeFile(path(relative),contents)
}
console.log(JSON.stringify({apis:matrix.apis.length,hosts:hosts.length,cells:matrix.apis.length*hosts.length,
  implementation:Object.fromEntries(hosts.map(host=>[host,Object.fromEntries(['missing','partial','available','requiresHostService'].map(state=>[state,matrix.apis.filter(api=>api.hosts[host].implementationState===state).length]))])),
  accepted:matrix.apis.reduce((sum,api)=>sum+hosts.filter(host=>api.hosts[host].status==='implementedAndAccepted').length,0),platformNotApplicable:restrictions.size,check,validationIo:io.stats()}))
