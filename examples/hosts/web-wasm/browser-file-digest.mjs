// FileSystem API compatibility digest. MD5 is the baseline getFileInfo default;
// package authenticity and installation integrity continue to use SHA-256.
const shifts = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21]
const constants = Uint32Array.from({length:64}, (_, index) => Math.floor(Math.abs(Math.sin(index+1))*2**32))
const hex = bytes => [...bytes].map(value => value.toString(16).padStart(2,'0')).join('')

export async function browserFileDigest(buffer, algorithm = 'md5') {
  if (algorithm === 'sha1') return hex(new Uint8Array(await crypto.subtle.digest('SHA-1',buffer)))
  if (algorithm !== 'md5') throw Object.assign(new Error('digestAlgorithm must be md5 or sha1'),{code:'invalid_request'})
  const bytes = new Uint8Array(buffer), padded = new Uint8Array(Math.ceil((bytes.length+9)/64)*64)
  padded.set(bytes); padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer), bitLength = BigInt(bytes.length)*8n
  view.setUint32(padded.length-8,Number(bitLength&0xffffffffn),true)
  view.setUint32(padded.length-4,Number(bitLength>>32n),true)
  const state = new Uint32Array([0x67452301,0xefcdab89,0x98badcfe,0x10325476])
  for (let offset=0;offset<padded.length;offset+=64) {
    let [a,b,c,d]=state
    for(let index=0;index<64;index++) {
      const round=index>>>4
      const f=round===0?(b&c)|(~b&d):round===1?(d&b)|(~d&c):round===2?b^c^d:c^(b|~d)
      const word=round===0?index:round===1?(5*index+1)%16:round===2?(3*index+5)%16:(7*index)%16
      const sum=(a+f+constants[index]+view.getUint32(offset+word*4,true))|0, shift=shifts[round*4+index%4]
      const previous=d;d=c;c=b;b=(b+((sum<<shift)|(sum>>>(32-shift))))|0;a=previous
    }
    state[0]+=a;state[1]+=b;state[2]+=c;state[3]+=d
  }
  const output=new Uint8Array(16), result=new DataView(output.buffer)
  state.forEach((value,index)=>result.setUint32(index*4,value,true))
  return hex(output)
}
