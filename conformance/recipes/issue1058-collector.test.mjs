import assert from 'node:assert/strict'
import test from 'node:test'
import { createCollector } from './issue1058-collector.mjs'

const home = 'pages/home/index', boundary = 'pages/boundary/index'
const homeSelectors = ['#builtin', '#pascal', '#kebab', '#duplicate', '#increment']
const boundarySelectors = ['#lowercase', '#explicit-pascal', '#toggle']
const checkpoint = (id, route, { hidden = false } = {}) => ({ fixture: 'synthetic-collector-unit-test', provider: 'unit-test', evidence: { id, route,
  capturedAt: new Date().toISOString(), source: 'synthetic-collector-unit-test',
  nodes: (route === home ? homeSelectors : boundarySelectors).map((selector, index) => ({
    selector, query: 'css', count: hidden && index < 2 ? 0 : 1,
    nodes: hidden && index < 2 ? [] : [{ text: `actual captured ${id} ${selector}` }],
  })) } })

function session({ tapFailure } = {}) {
  const events = [], operations = [], collector = createCollector({ emit: event => events.push(event) })
  const program = { async reLaunch(path) {
    operations.push(['reLaunch', path])
    return { path: path.replace(/^\//, ''), async $(selector) {
      operations.push(['query', selector])
      return { async tap() { operations.push(['tap', selector]); if (tapFailure) throw new Error('actual tap failed'); return { actualTapResult: true } } }
    } }
  } }
  collector.attach(program)
  return { collector, program, events, operations }
}

test('passive collector emits only actual successful checkpoints and taps, without driving the session', async () => {
  const { collector, program, events, operations } = session()
  assert.deepEqual(operations, [])
  const first = await program.reLaunch('/' + home)
  const observed = checkpoint('count-0', home)
  collector.checkpoint(observed)
  observed.evidence.nodes[0].nodes[0].text = 'later mutation'
  assert.equal(events[1].payload.nodes[0].nodes[0].text, 'actual captured count-0 #builtin')
  assert.deepEqual(await (await first.$('#increment')).tap(), { actualTapResult: true })
  collector.checkpoint(checkpoint('count-1', home))
  const second = await program.reLaunch('/' + boundary)
  collector.checkpoint(checkpoint('branch-0', boundary))
  await (await second.$('#toggle')).tap()
  collector.checkpoint(checkpoint('branch-1', boundary, { hidden: true }))
  await (await second.$('#toggle')).tap()
  collector.checkpoint(checkpoint('branch-2', boundary))
  collector.flush()
  assert.equal(events.length, 10)
  assert.deepEqual(events.filter(event => event.op === 'route.active').map(event => event.payload.route), [home, boundary])
  assert.deepEqual(events.filter(event => event.op === 'tap').map(event => event.payload), [
    { route: home, selector: '#increment' }, { route: boundary, selector: '#toggle' }, { route: boundary, selector: '#toggle' },
  ])
  assert.equal(operations.filter(operation => operation[0] === 'reLaunch').length, 2)
  assert.equal(operations.filter(operation => operation[0] === 'tap').length, 3)
  assert.ok(events.every(event => !JSON.stringify(event).includes('capturedAt') && !JSON.stringify(event).includes('synthetic-collector-unit-test')))
  collector.flush()
})

test('missing, skipped and reordered actual checkpoints fail instead of generating events', () => {
  const empty = session()
  assert.throws(() => empty.collector.flush(), /incomplete/)
  assert.deepEqual(empty.events, [])
  const skipped = session()
  assert.throws(() => skipped.collector.checkpoint(checkpoint('count-1', home)), /missing.*out of order/)
  assert.deepEqual(skipped.events, [])
  assert.throws(() => skipped.collector.flush(), /missing.*out of order/)
  const duplicate = session()
  duplicate.collector.checkpoint(checkpoint('count-0', home))
  assert.throws(() => duplicate.collector.checkpoint(checkpoint('count-0', home)), /duplicated/)
})

test('missing actual text/count evidence and absent successful taps fail closed', () => {
  for (const mutation of [e => { delete e.evidence.nodes[0].nodes[0].text }, e => { e.evidence.nodes[0].count = 2 }, e => { e.evidence.nodes.pop() }]) {
    const s = session(), value = checkpoint('count-0', home)
    mutation(value)
    assert.throws(() => s.collector.checkpoint(value), /missing|incomplete/)
    assert.deepEqual(s.events, [])
  }
  const s = session()
  s.collector.checkpoint(checkpoint('count-0', home))
  assert.throws(() => s.collector.checkpoint(checkpoint('count-1', home)), /successful observed tap/)
})

test('failed real taps emit no success and unexpected successful taps cannot fill missing coverage', async () => {
  const s = session({ tapFailure: true }), page = await s.program.reLaunch('/' + home)
  s.collector.checkpoint(checkpoint('count-0', home))
  await assert.rejects((await page.$('#increment')).tap(), /actual tap failed/)
  assert.equal(s.events.filter(event => event.op === 'tap').length, 0)
  assert.throws(() => s.collector.flush(), /incomplete/)
  const wrong = session(), other = await wrong.program.reLaunch('/' + home)
  assert.deepEqual(await (await other.$('#increment')).tap(), { actualTapResult: true })
  assert.deepEqual(wrong.events, [])
  assert.throws(() => wrong.collector.flush(), /outside/)
})
