import test from 'node:test'
import assert from 'node:assert/strict'
import {MessageChannel} from 'node:worker_threads'
import {once} from 'node:events'
import {packHostApiWire,unpackHostApiWire,HOST_API_BINARY_WIRE_LIMITS as limits} from './host-api-binary-wire.mjs'
import {measureWorkerPayload} from './worker-session-client.mjs'
const marker=bytes=>({__weappBinary:{type:'ArrayBuffer',bytes}})

test('large reserved byte arrays cross actual transferable MessagePorts and recover exact JSON without changing their source',async()=>{
  const original={callId:'recording-file',completion:{result:{data:marker(Array.from({length:65536},(_,index)=>index%256)),statusCode:200}}},snapshot=JSON.stringify(original)
  assert.throws(()=>measureWorkerPayload(original),/node budget/)
  const packed=packHostApiWire(original),backing=packed.value.completion.result.data.__weappBinary.bytes
  assert.ok(backing instanceof ArrayBuffer);assert.deepEqual(packed.transfer,[backing]);assert.equal(backing.byteLength,65536)
  assert.ok(measureWorkerPayload(packed.value,{transfers:packed.transfer})<70000)
  const {port1,port2}=new MessageChannel()
  try{const arrived=once(port2,'message');port1.postMessage(packed.value,packed.transfer);assert.equal(backing.byteLength,0);const [wire]=await arrived;assert.deepEqual(unpackHostApiWire(wire),original);assert.equal(JSON.stringify(original),snapshot)}
  finally{port1.close();port2.close()}
})

test('a failed transfer attempt can retry from the original completion without reusing a detached packed backing',()=>{
  const completion=JSON.stringify({result:{data:marker([0,127,255])}}),first=packHostApiWire(JSON.parse(completion))
  assert.throws(()=>structuredClone(first.value,{transfer:[...first.transfer,...first.transfer]}),/Transfer list contains duplicate|already listed/)
  const second=packHostApiWire(JSON.parse(completion)),received=structuredClone(second.value,{transfer:second.transfer})
  assert.equal(second.transfer[0].byteLength,0);assert.deepEqual(unpackHostApiWire(received),JSON.parse(completion));assert.equal(first.transfer[0].byteLength,3)
})

test('ordinary arrays keep their node limit and cannot disguise themselves as reserved binary data',()=>{
  for(const transform of [packHostApiWire,unpackHostApiWire]){
    assert.throws(()=>transform({data:Array(20000).fill(1)}),/ordinary.*node budget/)
    assert.throws(()=>transform({bytes:Array(20000).fill(1),type:'ArrayBuffer'}),/ordinary.*node budget/)
    assert.throws(()=>transform({...marker([1]),extra:true}),/only outer field/)
    assert.throws(()=>transform({__weappBinary:{type:'Uint8Array',bytes:[1]}}),/invalid inline/)
  }
})

test('handle markers and prototype-named JSON fields preserve their existing native meaning',()=>{
  const input=JSON.parse('{"id":"outer-id","__proto__":{"safe":true},"constructor":"data","value":{"__weappBinary":{"handle":"binary-1"}}}')
  const packed=packHostApiWire(input);assert.deepEqual(packed.transfer,[]);assert.deepEqual(unpackHostApiWire(packed.value),input);assert.ok(Object.hasOwn(packed.value,'__proto__'));assert.equal(Object.getPrototypeOf(packed.value),Object.prototype)
  for(const bad of [{handle:1},{handle:'binary-1',bytes:[]},{id:'binary-1'},{type:'ArrayBuffer',bytes:[],handle:'binary-1'}])assert.throws(()=>packHostApiWire({__weappBinary:bad}),/invalid.*marker/)
})

test('validated trees without binary conversion preserve frozen exact identities and unchanged siblings share structure',()=>{
  const handle=Object.freeze({__weappBinary:Object.freeze({handle:'binary-1'})}),nested=Object.freeze([Object.freeze({frame:'exact-clone-proof'}),handle]),input=Object.freeze({nested})
  const packed=packHostApiWire(input);assert.equal(packed.value,input);assert.equal(unpackHostApiWire(input),input);assert.equal(Object.isFrozen(packed.value.nested[0]),true);assert.deepEqual(packed.transfer,[])
  const inline=marker([1,2]);assert.equal(unpackHostApiWire(inline),inline)
  const mixed=Object.freeze({nested,data:inline}),converted=packHostApiWire(mixed);assert.notEqual(converted.value,mixed);assert.equal(converted.value.nested,nested);assert.equal(converted.value.nested[1],handle);assert.equal(Object.isFrozen(converted.value.nested),true)
  let called=0;const invalid=Object.freeze(Object.defineProperty({},'value',{enumerable:true,get(){called++;return 1}}));assert.throws(()=>packHostApiWire(invalid),/getters/);assert.equal(called,0)
})

test('invalid inline bytes, holes, extra fields and getters are rejected without invoking user code',()=>{
  for(const bad of [[-1],[256],[1.5],[NaN],[Infinity],['1'],[undefined],new Array(1)])assert.throws(()=>packHostApiWire(marker(bad)),/native binary bytes/)
  const additional=[1];additional.extra=2;assert.throws(()=>packHostApiWire(marker(additional)),/dense array/)
  let called=0
  const accessor=[1];Object.defineProperty(accessor,'0',{get(){called++;return 1},enumerable:true});assert.throws(()=>packHostApiWire(marker(accessor)),/without holes or getters/)
  const value={};Object.defineProperty(value,'data',{get(){called++;return marker([1])},enumerable:true});assert.throws(()=>packHostApiWire(value),/getters/)
  const inner={type:'ArrayBuffer'};Object.defineProperty(inner,'bytes',{get(){called++;return [1]},enumerable:true});assert.throws(()=>packHostApiWire({__weappBinary:inner}),/getters/)
  const hiddenMarker=marker([1]);Object.defineProperty(hiddenMarker,'secret',{get(){called++;return 1}});assert.throws(()=>packHostApiWire(hiddenMarker),/getters/)
  const symbolMarker=marker([1]);symbolMarker[Symbol('extra')]=1;assert.throws(()=>packHostApiWire(symbolMarker),/symbol fields/)
  assert.equal(called,0)
})

test('cycles, non-data values, deep trees and excessive metadata are bounded before transfer',()=>{
  const cycle={};cycle.self=cycle
  for(const transform of [packHostApiWire,unpackHostApiWire]){
    assert.throws(()=>transform(cycle),/cycle/)
    for(const value of [()=>{},Symbol('bad'),1n,new Date(),new Map()])assert.throws(()=>transform({value}),/JSON|plain/)
    let deep=null;for(let index=0;index<limits.maxDepth+1;index++)deep={next:deep};assert.throws(()=>transform(deep),/depth budget/)
    assert.throws(()=>transform('x'.repeat(limits.maxBytes/2)),/byte budget/)
    assert.throws(()=>transform(Object.fromEntries(Array.from({length:limits.maxNodes+1},(_,index)=>['key'+index,null]))),/field budget/)
  }
})

test('each chunk obeys the runtime one MiB limit while a bounded wire batch can carry multiple API payloads',()=>{
  assert.equal(Object.isFrozen(limits),true)
  const exact=marker(Array(limits.maxChunkBytes).fill(255)),packed=packHostApiWire(exact);assert.equal(packed.transfer[0].byteLength,limits.maxChunkBytes);assert.equal(unpackHostApiWire(packed.value).__weappBinary.bytes.length,limits.maxChunkBytes)
  assert.throws(()=>packHostApiWire(marker(Array(limits.maxChunkBytes+1).fill(0))),/one MiB/)
  const batch=packHostApiWire([exact,marker(exact.__weappBinary.bytes)]);assert.equal(batch.transfer.length,2);assert.equal(batch.transfer.reduce((bytes,value)=>bytes+value.byteLength,0),2*limits.maxChunkBytes)
  assert.throws(()=>packHostApiWire(Array.from({length:9},()=>marker(exact.__weappBinary.bytes))),/combined eight MiB/)
  assert.throws(()=>packHostApiWire(Array.from({length:limits.maxChunks+1},()=>marker([]))),/chunk budget/)
})

test('multiple inline occurrences own unique full backings even when their source arrays alias',()=>{
  const source=[4,5],input=[marker(source),marker(source)],packed=packHostApiWire(input)
  assert.equal(new Set(packed.transfer).size,2);assert.notEqual(packed.transfer[0],packed.transfer[1]);assert.equal(packed.transfer.every(value=>value.byteLength===2),true)
  const received=structuredClone(packed.value,{transfer:packed.transfer});assert.deepEqual(unpackHostApiWire(received),input);assert.deepEqual(source,[4,5])
})

test('ordinary shared DAGs keep generic RPC budgets, frozen identity and binary aliases',()=>{
  const shared=Object.freeze(Object.fromEntries(Array.from({length:2000},(_,index)=>['key'+index,index]))),input=Object.freeze(Array(20).fill(shared))
  assert.ok(measureWorkerPayload(input)>0)
  for(const transform of [value=>packHostApiWire(value).value,unpackHostApiWire])assert.equal(transform(input),input)
  const binary=marker([7,8]),nested={shared,binary},mixed={first:nested,second:nested,binary},packed=packHostApiWire(mixed)
  assert.equal(packed.value.first,packed.value.second);assert.equal(packed.value.first.shared,shared);assert.equal(packed.value.first.binary,packed.value.binary);assert.equal(packed.transfer.length,1)
  const decoded=unpackHostApiWire(structuredClone(packed.value,{transfer:packed.transfer}))
  assert.equal(decoded.first,decoded.second);assert.equal(decoded.first.binary,decoded.binary);assert.deepEqual(decoded.binary,binary)
})

test('ordinary sparse arrays retain holes and enumerable custom fields through ancestor conversion',()=>{
  const list=new Array(5);list[2]='present';list.extra=marker([1,2]);Object.defineProperty(list,'hidden',{value:3})
  assert.ok(measureWorkerPayload(list)>0)
  const packed=packHostApiWire({list}),converted=packed.value.list
  assert.equal(converted.length,5);assert.deepEqual(Object.keys(converted),['2','extra']);assert.equal(0 in converted,false);assert.equal(4 in converted,false);assert.equal(converted[2],'present')
  const received=unpackHostApiWire(structuredClone(packed.value,{transfer:packed.transfer})).list
  assert.equal(received.length,5);assert.equal(0 in received,false);assert.equal(4 in received,false);assert.deepEqual(received.extra,list.extra)
  const unchanged=new Array(4);unchanged[2]=1;assert.equal(packHostApiWire(unchanged).value,unchanged);assert.equal(unpackHostApiWire(unchanged),unchanged)
})

test('ordinary hidden accessors and symbol fields are ignored without running user code',()=>{
  let called=0
  const input={plain:1};Object.defineProperty(input,'secret',{get(){called++;throw new Error('must not run')}});input[Symbol('ignored')]=()=>{}
  assert.ok(measureWorkerPayload(input)>0);assert.equal(packHostApiWire(input).value,input);assert.equal(unpackHostApiWire(input),input)
  const mixed={...Object.getOwnPropertyDescriptors(input)}
  const converted=Object.defineProperties({binary:marker([1])},mixed),packed=packHostApiWire(converted)
  assert.deepEqual(Object.keys(packed.value),['binary','plain']);assert.equal(Object.hasOwn(packed.value,'secret'),false);assert.deepEqual(Object.getOwnPropertySymbols(packed.value),[]);assert.equal(called,0)
})

test('configured generic RPC metadata limits remain available beyond the default bridge budgets',()=>{
  const backing=new ArrayBuffer(20*1024*1024),options={maxBytes:32*1024*1024}
  assert.ok(measureWorkerPayload(backing,options)>0)
  for(const transform of [value=>packHostApiWire(value).value,unpackHostApiWire])assert.throws(()=>transform(backing),/byte budget/)
  assert.equal(packHostApiWire(backing,options).value,backing);assert.equal(unpackHostApiWire(backing,options),backing)
  const array=Array(20000).fill(1),nodeOptions={maxNodes:30000}
  assert.ok(measureWorkerPayload(array,nodeOptions)>0);assert.equal(packHostApiWire(array,nodeOptions).value,array);assert.equal(unpackHostApiWire(array,nodeOptions),array)
  let deep=null;for(let index=0;index<80;index++)deep={next:deep}
  assert.ok(measureWorkerPayload(deep,{maxDepth:100})>0);assert.equal(packHostApiWire(deep,{maxDepth:100}).value,deep);assert.equal(unpackHostApiWire(deep,{maxDepth:100}),deep)
  for(const options of [null,[],{maxBytes:0},{maxBytes:256*1024*1024+1},{maxNodes:131073},{maxDepth:257}]){
    assert.throws(()=>packHostApiWire(null,options),/options|metadata limits/);assert.throws(()=>unpackHostApiWire(null,options),/options|metadata limits/)
  }
  assert.throws(()=>packHostApiWire(marker(Array(limits.maxChunkBytes+1).fill(0)),{maxBytes:256*1024*1024,maxNodes:131072,maxChunkBytes:2*limits.maxChunkBytes}),/one MiB/)
})

test('shared object edges still enforce depth and node limits and cannot conceal cycles',()=>{
  const shared={value:1},input=Array(16).fill(shared)
  assert.throws(()=>packHostApiWire(input,{maxNodes:16}),/node.*budget/)
  const reference={shared},deep={next:{next:{next:shared}}},dag={reference,deep}
  for(const transform of [packHostApiWire,unpackHostApiWire]){
    assert.throws(()=>transform(dag,{maxDepth:2}),/depth budget/)
    const cycle={};cycle.child={parent:cycle};assert.throws(()=>transform([cycle,cycle]),/cycle/)
  }
})

test('existing ordinary buffers, typed views, DataViews and undefined stay caller-owned and use their full backing byte budget',()=>{
  const backing=new ArrayBuffer(4096),view=new Uint16Array(backing,8,16),dataView=new DataView(backing,10,8),input={backing,view,dataView,optional:undefined,list:[1,true,null]}
  for(const transform of [value=>packHostApiWire(value),value=>({value:unpackHostApiWire(value),transfer:[]})]){
    const result=transform(input);assert.deepEqual(result.transfer,[]);assert.equal(result.value.backing,backing);assert.equal(result.value.view,view);assert.equal(result.value.dataView,dataView);assert.equal(backing.byteLength,4096);assert.equal(Object.hasOwn(result.value,'optional'),true)
  }
  assert.throws(()=>packHostApiWire(new Uint8Array(new ArrayBuffer(limits.maxBytes+1),0,1)),/byte budget/)
})

test('unpacking accepts canonical transferred Uint8Array views and rejects detached, shared or partial marker backings',()=>{
  assert.deepEqual(unpackHostApiWire(marker(new Uint8Array([0,255]))),marker([0,255]))
  assert.throws(()=>packHostApiWire(marker(new Uint8Array([1]))),/inline byte array/)
  assert.throws(()=>unpackHostApiWire(marker(new Uint8Array(new ArrayBuffer(4),1,2))),/complete backing/)
  assert.throws(()=>unpackHostApiWire(marker(new Uint16Array([1]))),/Uint8Array/)
  const detached=new ArrayBuffer(1);structuredClone(detached,{transfer:[detached]})
  for(const value of [detached,new Uint8Array(new SharedArrayBuffer(1))]){
    assert.throws(()=>unpackHostApiWire(marker(value)),/attached non-shared/)
    assert.throws(()=>packHostApiWire({value}),/attached non-shared/)
  }
})
