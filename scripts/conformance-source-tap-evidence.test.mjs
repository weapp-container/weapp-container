/** Explicit synthetic journals; never receipt evidence. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fixture,pollOptions} from '../conformance/recipes/issue1011-test-fixture.mjs'
import {descriptor} from '../conformance/recipes/issue1011-descriptor.mjs'
import {expectedSnapshot} from '../conformance/recipes/issue1011-source-assertions.mjs'
import {pureReadAudit} from '../conformance/recipes/issue1011-pure-read.mjs'
import {assertSourcePollEvidence} from './conformance-source-poll-evidence.mjs'
const page=await readFile(new URL('../vendor/weapp-vite/'+pureReadAudit.sourcePath,import.meta.url)),ref={path:'synthetic/1011-page',bytes:page.length,sha256:createHash('sha256').update(page).digest('hex')}
async function evidence(){
 const f=fixture({onOperation:({operation})=>{if(operation==='tap')throw new Error('actual failed input')},onMethod:({at})=>at===0?{objectCaptures:[],tupleCaptures:[]}:structuredClone(expectedSnapshot)})
 await f.start();await f.taps();await f.collector.sourcePoll(pollOptions,async()=>{await f.page.callMethodWithOptions('_snapshot',{timeout:5000});await f.page.callMethodWithOptions('_snapshot',{timeout:5000})});f.finish()
 return{trace:{...f.trace(),run:{status:'passed',environment:{caseSourceSha256:descriptor.sourceSha256}}},journal:f.collector.diagnostics(),build:Object.fromEntries(['sourceBefore','sourceAfter'].map(stage=>[stage,[{kind:'file',path:'src/pages/issue-1011/index.vue',artifact:ref}]])),load:()=>page}
}
test('complete failed/fulfilled input attempts and pure snapshot double deadlines are independently admitted',async()=>{
 const input=await evidence(),result=assertSourcePollEvidence(input);assert.equal(result.actualAttempts,2);assert.equal(input.journal.tapHelperJournal.attempts.length,15)
})
test('missing/duplicate/rebound/reordered/tampered input acquisitions and attempts fail closed',async()=>{
 for(const mutation of [x=>{delete x.journal.tapHelperJournal;x.trace.events=x.trace.events.filter(e=>e.op!=='tap.helper.attempt')},x=>delete x.journal.tapHelperJournal,x=>x.journal.tapHelperJournal.acquisitions.pop(),x=>x.journal.tapHelperJournal.acquisitions[1].acquisition=x.journal.tapHelperJournal.acquisitions[0].acquisition,x=>x.journal.tapHelperJournal.acquisitions.forEach(a=>a.epoch=null),x=>x.journal.tapHelperJournal.attempts.shift(),x=>x.journal.tapHelperJournal.attempts.reverse(),x=>x.journal.tapHelperJournal.attempts[0].acquisition++,x=>x.journal.tapHelperJournal.attempts[1].pageId++,x=>x.journal.tapHelperJournal.attempts[1].epoch++,x=>x.journal.tapHelperJournal.attempts[1].startedAtMs=0,x=>x.trace.events.splice(2,1),x=>x.trace.events[2].payload.completion={kind:'fulfilled',value:{kind:'undefined'}}]){
  const input=await evidence();mutation(input);assert.throws(()=>assertSourcePollEvidence(input),/Source tap evidence|Source-plan/)
 }
})
test('1011 poll retains explicit5000 call options, both deadlines, same input Page and exact source closure',async()=>{
 for(const mutation of [x=>delete x.journal.sourcePollJournal.attempts[0].callOptions,x=>x.journal.sourcePollJournal.attempts[0].callDeadlineMs++,x=>x.journal.sourcePollJournal.attempts[0].endedAtMs+=5001,x=>x.journal.sourcePollJournal.attempts.forEach(a=>a.pageId++),x=>x.build.sourceAfter=[],x=>x.load=()=>Buffer.from('other snapshot'),x=>x.trace.events.find(e=>e.op==='method.poll').payload.callOptions.timeout=6000]){
  const input=await evidence();mutation(input);input.journal.pollAttempts=structuredClone(input.journal.sourcePollJournal.attempts);assert.throws(()=>assertSourcePollEvidence(input),/Source poll evidence|Source tap evidence|Source-plan/)
 }
})
