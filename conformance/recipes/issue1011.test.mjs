/** Source/contract tests only; no official or native execution is claimed. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {descriptor} from './issue1011-descriptor.mjs'
import {expectedSnapshot,expectedDomCheckpoints,assertIssue1011MethodResult,assertIssue1011DomEvidence} from './issue1011-source-assertions.mjs'
import {assertIssue1011PureReadSource,pureReadAudit} from './issue1011-pure-read.mjs'
import {staticInputs,plan,poll,checkpointGroups} from './issue1011-test-fixture.mjs'
import {assertIssue1011Outputs,loadIssue1011Inputs} from '../../examples/hosts/conformance-desktop/issue1011-static.mjs'
const sha=b=>createHash('sha256').update(b).digest('hex')
const results=value=>[{route:plan.route,method:'_snapshot',sourceCallsite:poll.sourceCallsite,value}]
const dom=()=>expectedDomCheckpoints.map(({id})=>({id,route:plan.route,nodes:checkpointGroups(id)}))
test('all exact source/helper/page/automator/config/lock guards match captured fixed-commit bytes',async()=>{
 for(const ref of descriptor.sourceGuards){const bytes=await readFile(new URL('../../vendor/weapp-vite/'+ref.path,import.meta.url));assert.equal(sha(bytes),ref.sha256,ref.path);assert.equal(bytes.length,ref.bytes,ref.path)}
 assert.equal(descriptor.sourceSha256,'d7dacedd9dc11c244ec49ef22491829d1b316d2f1ad8b72f574be6408c55fdfa')
 assert.deepEqual(plan.steps.map(s=>s.kind),['checkpoint',...Array(5).fill('tap'),'method.poll','checkpoint'])
 assert.deepEqual(plan.steps.filter(s=>s.kind==='tap').map(s=>s.queryOptions),Array(5).fill(undefined))
 assert.deepEqual(poll.callOptions,{timeout:5000});assert.equal(poll.timeoutMs,10000);assert.equal(poll.intervalMs,50)
})
test('three file existence checks allow empty files while app.json must satisfy original toContain',()=>{
 const input=staticInputs();input.files=input.files.map((file,at)=>at===3?file:{...file,bytes:Buffer.alloc(0),length:0,sha256:sha(Buffer.alloc(0))})
 const coverage=assertIssue1011Outputs(input,{methodResults:results(structuredClone(expectedSnapshot))})
 assert.equal(coverage.originalStaticExpectations,4);assert.equal(coverage.originalRuntimeCaptures,5)
 for(const change of [x=>x.files.pop(),x=>x.files.reverse(),x=>x.files[1]=x.files[0],x=>x.files[0].sha256='0'.repeat(64),x=>x.sourceSha256='0'.repeat(64)]){const x=staticInputs();change(x);assert.throws(()=>assertIssue1011Outputs(x,{methodResults:results(expectedSnapshot)}))}
 for(const pages of [[],['pages/other/index'],null]){const x=staticInputs(),bytes=Buffer.from(JSON.stringify({pages}));x.files[3]={...x.files[3],bytes,length:bytes.length,sha256:sha(bytes)};assert.throws(()=>assertIssue1011Outputs(x,{methodResults:results(expectedSnapshot)}),/toContain/)}
})
test('full snapshot distinguishes missing fallback/null/zero/false/rest exclusions/indices/tuple tails',()=>{
 assert.doesNotThrow(()=>assertIssue1011MethodResult(results(structuredClone(expectedSnapshot))))
 const mutations=[x=>x.objectCaptures.shift(),x=>x.tupleCaptures=[],x=>x.objectCaptures[0].label=undefined,x=>x.objectCaptures[1].label='null',x=>x.objectCaptures[2].label=false,x=>x.objectCaptures[3].label=0,x=>x.objectCaptures[0].rest.id='missing',x=>x.objectCaptures[0].restKeys=[],x=>x.objectCaptures[0].rowIndex=1,x=>x.objectCaptures[0].sectionName='other',x=>x.tupleCaptures[0].tail.pop(),x=>x.tupleCaptures[0].tupleIndex=1,x=>x.extra=true]
 for(const mutate of mutations){const x=structuredClone(expectedSnapshot);mutate(x);assert.throws(()=>assertIssue1011MethodResult(results(x)))}
 for(const x of [[],results(null),[...results(expectedSnapshot),...results(expectedSnapshot)],[{...results(expectedSnapshot)[0],route:'other'}]])assert.throws(()=>assertIssue1011MethodResult(x))
})
test('all seven original DOM checks reject omitted/duplicated/count/selector/value/order changes',()=>{
 assert.equal(assertIssue1011DomEvidence(dom()).nodeAssertions,7)
 for(const change of [x=>x.reverse(),x=>x.pop(),x=>x[0].nodes.pop(),x=>x[1].nodes.push(x[1].nodes[0]),x=>x[1].nodes[0].count=0,x=>x[0].nodes[0].selector='#substitute',x=>x[0].nodes[0].nodes[0].text='wrong']){const x=dom();change(x);assert.throws(()=>assertIssue1011DomEvidence(x))}
})
test('pure-read proof belongs to exact1011 page and AST span independently',async()=>{
 const bytes=await readFile(new URL('../../vendor/weapp-vite/'+pureReadAudit.sourcePath,import.meta.url));assert.deepEqual(assertIssue1011PureReadSource(bytes),poll.normalization)
 assert.equal(pureReadAudit.methodStartLine,55);assert.equal(pureReadAudit.methodEndLine,60)
 for(const changed of [bytes.toString().replace('objectCaptures.map','objectCaptures.splice(0).map'),bytes.toString().replace('return {','objectCaptures.push({}); return {'),bytes.toString()+'\n',bytes.toString().replace('tupleCaptures.map','objectCaptures.map')])assert.throws(()=>assertIssue1011PureReadSource(Buffer.from(changed)),/independent pure-read/)
})
test('static reader retains complete official/fixture admission before any substitute read',async()=>{
 let reads=0;await assert.rejects(loadIssue1011Inputs({recipe:{caseId:descriptor.caseId,sourceSha256:descriptor.sourceSha256},loadArtifact:async()=>{reads++;return Buffer.from('{}')}}),/actual pinned fixture and official oracle/);assert.equal(reads,0)
})
