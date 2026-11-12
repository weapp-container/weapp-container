import assert from 'node:assert/strict'
import test from 'node:test'
import { createCollector } from './issue1014-collector.mjs'
import { descriptor } from './issue1014-descriptor.mjs'
const route = descriptor.route
const evidence = (at, title = 'actual-attribute-never-an-expected-value') => ({ evidence: {
  id: descriptor.checkpoints[at].id, route,
  nodes: descriptor.checkpoints[at].queries.map(q => ({ selector: q.selector, query: 'css', count: 1, nodes: [q.text ? { text: `actual text ${at} ${q.selector}` } : { attributes: { 'data-title': title } }] })),
} })
function session({ collector, program: provided, tapFailure } = {}) {
  const events = [], originals = [], c = collector ?? createCollector({ emit: e => events.push(e) })
  const remember = (obj, keys) => { for (const key of keys) originals.push({ obj, key, own: Object.getOwnPropertyDescriptor(obj, key), value: obj[key] }); return obj }
  let id = 0
  const program = provided ?? { async reLaunch(path) {
    const page = { path: path.slice(1), pageId: ++id, async $$(selector) {
      return [remember({ async tap() { if (tapFailure) throw tapFailure; return 'original tap result' } }, ['tap'])]
    } }
    return remember(page, ['$$'])
  }, async currentPage() { return undefined } }
  remember(program, ['reLaunch', 'currentPage'].filter(key => typeof program[key] === 'function'))
  c.attach(program)
  return { c, program, events, originals }
}
async function launch(s) { return s.program.reLaunch('/' + route) }
async function tap(page) { return (await page.$$('#issue1014-explicit-control'))[0].tap() }
async function complete(s) { const page = await launch(s); s.c.checkpoint(evidence(0), { session: s.program, page }); await tap(page); s.c.checkpoint(evidence(1), { session: s.program, page }); s.c.flush(); return page }

test('1014 emits only actual text/attribute projection and observes original $$ tap, with exact restoration', async () => {
 const s = session(), page = await launch(s), first = evidence(0, 'actual different title')
 s.c.checkpoint(first, { session: s.program, page }); first.evidence.nodes[1].nodes[0].attributes['data-title'] = 'mutated later'
 assert.equal(await tap(page), 'original tap result'); s.c.checkpoint(evidence(1), { session: s.program, page }); s.c.flush(); s.c.flush()
 assert.deepEqual(s.events.map(e => e.op), ['route.active','dom.checkpoint','tap','dom.checkpoint'])
 assert.deepEqual(s.events[1].payload.nodes[1].nodes, [{ attributes: { 'data-title': 'actual different title' } }])
 assert(!('text' in s.events[1].payload.nodes[1].nodes[0]))
 for (const {obj,key,own,value} of s.originals) { assert.equal(obj[key], value); assert.deepEqual(Object.getOwnPropertyDescriptor(obj,key),own) }
 assert.equal(Object.getOwnPropertySymbols(s.program).length,0)
})
test('1014 required actual attribute absent/null/undefined cannot become a value', async () => {
 for (const value of [null,undefined,3,{},[]]) {
  const s=session(),page=await launch(s),e=evidence(0);e.evidence.nodes[1].nodes[0].attributes['data-title']=value
  assert.throws(()=>s.c.checkpoint(e,{session:s.program,page}),/actual attribute/);assert.equal(s.events.length,0);assert.throws(()=>s.c.flush())
 }
 for (const mutation of [node=>delete node.attributes,node=>delete node.attributes['data-title']]) {
  const s=session(),page=await launch(s),e=evidence(0);mutation(e.evidence.nodes[1].nodes[0]);assert.throws(()=>s.c.checkpoint(e,{session:s.program,page}),/attributes|attribute/)
 }
})
test('1014 zero count remains actual zero and no missing node is synthesized', async () => {
 const s=session(),page=await launch(s),e=evidence(0);e.evidence.nodes[1].count=0;e.evidence.nodes[1].nodes=[]
 s.c.checkpoint(e,{session:s.program,page});assert.deepEqual(s.events[1].payload.nodes[1].nodes,[]);assert.equal(s.events[1].payload.nodes[1].count,0)
 await tap(page);s.c.checkpoint(evidence(1),{session:s.program,page});s.c.flush()
})
test('1014 missing/extra/reordered checkpoints and wrong scopes/query/count remain blocked', async () => {
 for (const mutate of [e=>e.evidence.nodes.pop(),e=>e.evidence.nodes.reverse(),e=>delete e.evidence.nodes[0],e=>e.evidence.nodes[0].scope=['#other'],e=>e.evidence.nodes[0].has='#other',e=>e.evidence.nodes[0].query='xpath',e=>e.evidence.nodes[0].count=2,e=>delete e.evidence.nodes[0].nodes[0].text]) {
  const s=session(),page=await launch(s),e=evidence(0);mutate(e);assert.throws(()=>s.c.checkpoint(e,{session:s.program,page}));assert.throws(()=>s.c.flush())
 }
 const s=session(),page=await launch(s);assert.throws(()=>s.c.checkpoint(evidence(1),{session:s.program,page}),/out of order/)
 const d=session(),p=await launch(d);d.c.checkpoint(evidence(0),{session:d.program,page:p});assert.throws(()=>d.c.checkpoint(evidence(0),{session:d.program,page:p}),/duplicated/)
})
test('1014 early/duplicate/wrong-selector taps preserve original values but fail evidence', async () => {
 for (const scenario of ['early','duplicate','selector']) {
  const s=session(),page=await launch(s)
  if(scenario!=='early')s.c.checkpoint(evidence(0),{session:s.program,page})
  if(scenario==='duplicate')await tap(page)
  const element=(await page.$$(scenario==='selector'?'#other':'#issue1014-explicit-control'))[0]
  assert.equal(await element.tap(),'original tap result');assert.throws(()=>s.c.flush(),/interval|scope/)
 }
 const error=new Error('original upstream rejection'),s=session({tapFailure:error}),page=await launch(s)
 s.c.checkpoint(evidence(0),{session:s.program,page});await assert.rejects(tap(page),e=>e===error);assert.equal(s.events.some(e=>e.op==='tap'),false);assert.throws(()=>s.c.flush(),/incomplete/)
})
test('1014 Page/session owners and replacement epochs cannot cross the completed plan', async () => {
 for(const scenario of ['session','page','generation','transport']) {
  const s=session(),page=await launch(s);s.c.checkpoint(evidence(0),{session:s.program,page});await tap(page)
  if(scenario==='generation')await launch(s)
  if(scenario==='transport')s.c.attach(session().program)
  const context={session:scenario==='session'?{}:s.program,page:scenario==='page'?{}:page}
  assert.throws(()=>s.c.checkpoint(evidence(1),context),/Page|generation|tap/);assert.throws(()=>s.c.flush())
 }
})
test('1014 delayed $$ from an old generation fails without replacing actual results', async () => {
 let resolve;const delayed=new Promise(yes=>resolve=yes),element={async tap(){return 'actual'}},page={path:route,pageId:1,async $$(selector){return selector==='#delayed'?delayed:[element]}}
 const s=session({program:{async reLaunch(){return page}}});await launch(s);const pending=page.$$('#delayed');await launch(s);resolve([element]);assert.equal((await pending)[0],element)
 assert.equal(await element.tap(),'actual');assert.throws(()=>s.c.flush(),/generation|interval/)
})
test('1014 stable forwarding Proxy context binds the attached actual transport', async () => {
 const s=session(),proxy=new Proxy({}, {get(_target,key){const v=Reflect.get(s.program,key,s.program);return typeof v==='function'?v.bind(s.program):v}})
 const page=await proxy.reLaunch('/'+route);s.c.checkpoint(evidence(0),{session:proxy,page});await tap(page);s.c.checkpoint(evidence(1),{session:proxy,page});s.c.flush();assert.equal(s.events.length,4)
})
test('1014 sink failures remain sticky and exact own method descriptors restore', async () => {
 const failure=new Error('sink failure'),c=createCollector({emit(){throw failure}}),s=session({collector:c}),page=await launch(s)
 assert.throws(()=>c.checkpoint(evidence(0),{session:s.program,page}),e=>e===failure);assert.throws(()=>c.flush(),e=>e===failure)
 for(const {obj,key,own}of s.originals)assert.deepEqual(Object.getOwnPropertyDescriptor(obj,key),own)
})

test('1014 legal array query aliases of the same actual node retain its canonical action acquisition', async () => {
 const element={async tap(){return 'upstream actual value'}},array=[element],page={path:route,pageId:1,async $$(){return array}}
 const s=session({program:{async reLaunch(){return page}}});await launch(s)
 s.c.checkpoint(evidence(0),{session:s.program,page})
 assert.equal(await page.$$('#issue1014-explicit-control'),array)
 assert.equal(await page.$$('#other-selector'),array)
 assert.equal(await element.tap(),'upstream actual value')
 s.c.checkpoint(evidence(1),{session:s.program,page});s.c.flush()
 assert.deepEqual(s.events[2].payload,{route,selector:'#issue1014-explicit-control'})
})
