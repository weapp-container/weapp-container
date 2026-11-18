/** Only the reserved native binary marker crosses as transferable bytes.
 * Ordinary JSON arrays retain their node budget. Every packed backing is new:
 * a failed post never detaches or changes the source completion/event value.
 */
export const HOST_API_BINARY_WIRE_LIMITS=Object.freeze({maxChunkBytes:1024*1024,maxBinaryBytes:8*1024*1024,maxChunks:256,maxNodes:16384,maxDepth:64,maxBytes:16*1024*1024})
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key)
const invalid=message=>Object.assign(new Error(message),{code:'ERR_HOST_API_BINARY_WIRE'})
const limited=message=>Object.assign(new Error(message),{code:'ERR_HOST_API_BINARY_WIRE_LIMIT'})
const bufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get
const typedPrototype=Object.getPrototypeOf(Uint8Array.prototype)
const typedTag=Object.getOwnPropertyDescriptor(typedPrototype,Symbol.toStringTag).get
const typedBuffer=Object.getOwnPropertyDescriptor(typedPrototype,'buffer').get
const typedLength=Object.getOwnPropertyDescriptor(typedPrototype,'byteLength').get
const typedOffset=Object.getOwnPropertyDescriptor(typedPrototype,'byteOffset').get
const dataViewBuffer=Object.getOwnPropertyDescriptor(DataView.prototype,'buffer').get

function fields(value,array=false,max=HOST_API_BINARY_WIRE_LIMITS.maxNodes,strict=false){
  const prototype=Object.getPrototypeOf(value)
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw invalid('host API wire requires plain JSON data')
  const result=new Map()
  if(strict){
    const keys=Reflect.ownKeys(value)
    if(keys.length>max+(array?1:0))throw limited('host API wire field budget exceeded')
    for(const key of keys){
      if(typeof key!=='string')throw invalid('host API wire does not accept symbol fields')
      const descriptor=Object.getOwnPropertyDescriptor(value,key)
      if(!descriptor||!own(descriptor,'value'))throw invalid('host API wire does not accept getters or setters')
      if(array&&key==='length')continue
      if(!descriptor.enumerable)throw invalid('host API wire fields must be enumerable data')
      result.set(key,descriptor.value)
    }
  }else{
    // Match generic RPC admission: only own enumerable data crosses structured
    // clone. Hidden and symbol properties must never cause getter execution.
    let inspected=0
    for(const key in value){
      if(++inspected>max)throw limited('host API wire field budget exceeded')
      const descriptor=Object.getOwnPropertyDescriptor(value,key)
      if(!descriptor)continue
      if(!own(descriptor,'value'))throw invalid('host API wire does not accept enumerable getters or setters')
      result.set(key,descriptor.value)
    }
  }
  return result
}
function arrayBytes(value){
  const length=Object.getOwnPropertyDescriptor(value,'length')?.value
  if(!Number.isSafeInteger(length)||length>HOST_API_BINARY_WIRE_LIMITS.maxChunkBytes)throw limited('native binary chunk exceeds one MiB')
  if(Object.getPrototypeOf(value)!==Array.prototype||Reflect.ownKeys(value).length!==length+1)throw invalid('native binary bytes require a dense array without extra fields')
  const bytes=new Uint8Array(length)
  for(let index=0;index<length;index++){
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index)),byte=descriptor?.value
    if(!descriptor?.enumerable||!own(descriptor,'value')||!Number.isInteger(byte)||byte<0||byte>255)throw invalid('native binary bytes must be integers from 0 to 255 without holes or getters')
    bytes[index]=byte
  }
  return bytes
}
function transferredBytes(value){
  let buffer,length,offset=0
  if(value instanceof ArrayBuffer){
    if(Reflect.ownKeys(value).length)throw invalid('transferred ArrayBuffer must have no custom fields')
    buffer=value
    try{length=bufferLength.call(buffer)}catch{throw invalid('native binary requires an attached non-shared ArrayBuffer')}
  }else if(ArrayBuffer.isView(value)){
    if(typedTag.call(value)!=='Uint8Array')throw invalid('native binary transfer must contain Uint8Array bytes')
    buffer=typedBuffer.call(value);length=typedLength.call(value);offset=typedOffset.call(value)
    if(length>HOST_API_BINARY_WIRE_LIMITS.maxChunkBytes)throw limited('native binary chunk exceeds one MiB')
    if(Reflect.ownKeys(value).length!==length)throw invalid('transferred Uint8Array must have no custom fields')
  }else throw invalid('native binary bytes require an inline array or transferred backing')
  let backingLength
  try{backingLength=bufferLength.call(buffer);new Uint8Array(buffer,0,0)}catch{throw invalid('native binary requires an attached non-shared ArrayBuffer')}
  if(offset!==0||length!==backingLength)throw invalid('native binary transfer must own its complete backing')
  if(length>HOST_API_BINARY_WIRE_LIMITS.maxChunkBytes)throw limited('native binary chunk exceeds one MiB')
  return new Uint8Array(buffer,0,length)
}
function convert(value,unpack,options){
  if(!options||typeof options!=='object'||Array.isArray(options))throw invalid('host API wire options must be an object')
  const {maxBytes=HOST_API_BINARY_WIRE_LIMITS.maxBytes,maxNodes=HOST_API_BINARY_WIRE_LIMITS.maxNodes,maxDepth=HOST_API_BINARY_WIRE_LIMITS.maxDepth}=options
  const limits={maxBytes,maxNodes,maxDepth}
  for(const [key,max]of [['maxBytes',256*1024*1024],['maxNodes',131072],['maxDepth',256]]){
    if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>max)throw invalid('invalid finite host API wire metadata limits')
  }
  // Binary caps are protocol constants, independent of generic RPC budgets.
  const binaryLimits=HOST_API_BINARY_WIRE_LIMITS,active=new Set(),memo=new Map(),buffers=new Set(),transfer=[]
  let nodes=0,bytes=0,binary=0,chunks=0
  const add=amount=>{if(amount>limits.maxBytes-bytes)throw limited('host API wire byte budget exceeded');bytes+=amount}
  const node=depth=>{if(++nodes>limits.maxNodes||depth>limits.maxDepth)throw limited('host API wire node or depth budget exceeded')}
  const clone=(value,depth)=>{
    node(depth)
    if(value===null||value===undefined||typeof value==='boolean'){add(8);return value}
    if(typeof value==='number'){if(!Number.isFinite(value))throw invalid('host API wire numbers must be finite');add(8);return value}
    if(typeof value==='string'){add(16+value.length*2);return value}
    if(!value||typeof value!=='object')throw invalid('host API wire requires JSON values')
    if(active.has(value))throw invalid('host API wire contains a cycle')
    if(memo.has(value))return memo.get(value)
    if(value instanceof ArrayBuffer||ArrayBuffer.isView(value)){
      // Existing ordinary backings remain caller-owned, including slices and
      // DataViews. Only reserved inline markers add a new transferable backing.
      let buffer=value
      if(ArrayBuffer.isView(value)){try{buffer=typedBuffer.call(value)}catch{buffer=dataViewBuffer.call(value)}add(32)}
      let length
      try{length=bufferLength.call(buffer);new Uint8Array(buffer,0,0)}catch{throw invalid('host API wire requires attached non-shared backings')}
      if(!buffers.has(buffer)){add(32+length);buffers.add(buffer)}
      memo.set(value,value)
      return value
    }
    const array=Array.isArray(value)
    const length=array?Object.getOwnPropertyDescriptor(value,'length').value:0
    if(array&&length>limits.maxNodes)throw limited('ordinary host API wire array exceeds its node budget')
    const entries=fields(value,array,limits.maxNodes);add(32)
    if(!array&&entries.has('__weappBinary')){
      if(fields(value,false,limits.maxNodes,true).size!==1)throw invalid('native binary marker must be the only outer field')
      const marker=entries.get('__weappBinary')
      if(!marker||typeof marker!=='object'||Array.isArray(marker))throw invalid('invalid native binary marker')
      node(depth+1);const properties=fields(marker,false,limits.maxNodes,true);add(32+16+'__weappBinary'.length*2)
      if(properties.has('handle')){
        if(properties.size!==1||typeof properties.get('handle')!=='string')throw invalid('invalid native binary handle marker')
        add(16+'handle'.length*2);clone(properties.get('handle'),depth+2);memo.set(value,value);return value
      }
      if(properties.size!==2||properties.get('type')!=='ArrayBuffer'||!properties.has('bytes'))throw invalid('invalid inline native binary marker')
      node(depth+2);node(depth+2)
      const source=properties.get('bytes'),data=Array.isArray(source)?arrayBytes(source):unpack?transferredBytes(source):null
      if(!data)throw invalid('packing native binary requires an inline byte array')
      if(++chunks>binaryLimits.maxChunks||data.byteLength>binaryLimits.maxBinaryBytes-binary)throw limited('native binary wire exceeds combined eight MiB or chunk budget')
      binary+=data.byteLength;add(32+data.byteLength+16+'bytes'.length*2+16+'type'.length*2+16+'ArrayBuffer'.length*2)
      const result=unpack?(Array.isArray(source)?value:{__weappBinary:{type:'ArrayBuffer',bytes:Array.from(data)}}):{__weappBinary:{type:'ArrayBuffer',bytes:data.buffer}}
      if(!unpack)transfer.push(data.buffer)
      memo.set(value,result);return result
    }
    active.add(value)
    try{
      if(array)add(length*8)
      let changes=null
      // The RPC validator visits the most recently enqueued field first. Keep
      // its traversal order so shared DAG depth accounting remains compatible.
      for(const [key,item]of [...entries].reverse()){
        add(16+key.length*2);const converted=clone(item,depth+1)
        if(converted!==item)(changes??=new Map()).set(key,converted)
      }
      // Ordinary RenderFrame metadata has no reserved binary markers. Still
      // validate its complete graph and budgets, but allocate replacement
      // objects only along a path whose binary representation actually changes.
      if(!changes){memo.set(value,value);return value}
      const result=array?new Array(length):Object.create(Object.getPrototypeOf(value))
      for(const [key,item]of entries)Object.defineProperty(result,key,{value:changes.has(key)?changes.get(key):item,enumerable:true,writable:true,configurable:true})
      memo.set(value,result);return result
    }finally{active.delete(value)}
  }
  const converted=clone(value,0)
  return {value:converted,transfer}
}
export function packHostApiWire(value,options={}){return convert(value,false,options)}
export function unpackHostApiWire(value,options={}){return convert(value,true,options).value}
