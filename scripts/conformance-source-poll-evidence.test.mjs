/** Synthetic raw-journal/schema contracts; no execution receipt is written or promoted. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fixture, pollOptions } from '../conformance/recipes/issue1009-test-fixture.mjs'
import { descriptor } from '../conformance/recipes/issue1009-descriptor.mjs'
import { expectedResults } from '../conformance/recipes/issue1009-source-assertions.mjs'
import { pureReadAudit } from '../conformance/recipes/issue1009-pure-read.mjs'
import { assertSourcePollEvidence } from './conformance-source-poll-evidence.mjs'
import { artifactReader, schemaErrors } from './conformance-evidence.mjs'
const page = await readFile(new URL('../vendor/weapp-vite/' + pureReadAudit.sourcePath, import.meta.url))
const ref = { path: 'synthetic/pure-read-source', bytes: page.length, sha256: createHash('sha256').update(page).digest('hex') }
async function evidence() {
  const f = fixture({ samples: [{ throw: 'actual-not-ready' }, { ...expectedResults, ctxCallback: 'pending' }, expectedResults] })
  await f.start(); await f.taps()
  await f.collector.sourcePoll(pollOptions, async () => { try { await f.page.callMethod('_runE2E') } catch {};
    await f.page.callMethod('_runE2E'); await f.page.callMethod('_runE2E') })
  f.checkpoint('completed'); f.collector.flush()
  return { trace: { ...f.trace(), run: { environment: { caseSourceSha256: descriptor.sourceSha256 } } }, journal: f.collector.diagnostics(),
    build: Object.fromEntries(['sourceBefore', 'sourceAfter'].map(stage => [stage, [{ kind: 'file', path: 'src/pages/issue-1009/index.vue', artifact: ref }]])), load: () => page }
}
const mutateJournal = (input, change) => { change(input.journal.sourcePollJournal); input.journal.pollAttempts = structuredClone(input.journal.sourcePollJournal.attempts) }
test('complete source-bound raw attempts, exact pure-read build bytes and actual final terminal normalize honestly', async () => {
  const input = await evidence(), result = assertSourcePollEvidence(input)
  assert.equal(result.actualAttempts, 3); assert.equal(result.sourceSha256, descriptor.sourceSha256)
  assert.equal(input.trace.events.filter(event => event.op === 'method.poll').length, 1)
  assert.equal(input.trace.events.some(event => event.op === 'method.poll.attempt'), false)
})
test('full oracle reader supplies verified guest bytes to source-poll admission', async t => {
  const root = mkdtempSync(resolve(tmpdir(), 'weapp-source-poll-reader-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false) })
  const file = resolve(root, ref.path)
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, page)
  const input = await evidence()
  const reader = artifactReader(root)
  input.load = reference => reader.loadBytes(reference, 'audited guest source')
  const result = assertSourcePollEvidence(input)
  assert.equal(result.sourceSha256, descriptor.sourceSha256)
  assert.equal(reader.stable(), true)
})
test('missing/empty/foreign/contradictory journals cannot admit terminal normalization', async () => {
  for (const mutation of [value => delete value.journal, value => value.journal = {}, value => mutateJournal(value, raw => raw.attempts = []),
    value => mutateJournal(value, raw => raw.caseId = 'other'), value => mutateJournal(value, raw => raw.sourceSha256 = '0'.repeat(64)),
    value => mutateJournal(value, raw => raw.normalization.methodBodySha256 = '0'.repeat(64)), value => value.journal.pollAttempts.pop()]) {
    const input = await evidence(); mutation(input); assert.throws(() => assertSourcePollEvidence(input), /Source poll evidence/)
  }
})
test('attempt omissions/duplicates/reordering/Page/address/default/deadline changes all fail closed', async () => {
  for (const mutation of [raw => raw.attempts.shift(), raw => raw.attempts.push(raw.attempts[0]), raw => raw.attempts.reverse(),
    raw => raw.attempts[1].attemptOrdinal++, raw => raw.attempts[1].sourceCallsite = 'other:94', raw => raw.attempts[1].method = 'other',
    raw => raw.attempts[1].pageId++, raw => raw.attempts[1].args = ['changed'], raw => raw.attempts[1].route = 'pages/other/index',
    raw => raw.attempts[1].sourceDeadlineMs++, raw => raw.attempts[1].endedAtMs = raw.attempts[1].sourceDeadlineMs + 1,
    raw => raw.attempts[1].completion = structuredClone(raw.attempts[2].completion), raw => raw.attempts[2].completion = raw.attempts[0].completion]) {
    const input = await evidence(); mutateJournal(input, mutation); assert.throws(() => assertSourcePollEvidence(input), /Source poll evidence/)
  }
})
test('actual before/after build source hash/blob/coverage cannot be substituted by a purity label', async () => {
  for (const mutation of [input => input.build.sourceAfter = [], input => input.build.sourceBefore.push(input.build.sourceBefore[0]),
    input => input.build.sourceAfter[0].artifact = { ...ref, sha256: '0'.repeat(64) }, input => input.load = () => Buffer.from('changed guest function')]) {
    const input = await evidence(); mutation(input); assert.throws(() => assertSourcePollEvidence(input), /Source poll evidence/)
  }
})
test('normalized final value/source/op count cannot be replaced by a raw journal or declared assertion result', async () => {
  for (const mutation of [input => input.trace.caseId = 'other', input => input.trace.run.environment.caseSourceSha256 = '0'.repeat(64),
    input => input.trace.events.push(input.trace.events.find(event => event.op === 'method.poll')),
    input => input.trace.events.find(event => event.op === 'method.poll').payload.completion.value.value.event = 'forged',
    input => input.trace.events.find(event => event.op === 'method.poll').payload.attempts = 3]) {
    const input = await evidence(); mutation(input); assert.throws(() => assertSourcePollEvidence(input), /Source poll evidence/)
  }
  assert.equal(assertSourcePollEvidence({ trace: { events: [] } }), undefined)
  assert.throws(() => assertSourcePollEvidence({ trace: { events: [] }, journal: {} }), /orphan/)
})
test('schema keeps old receipts valid without optional journal and rejects every malformed new artifact reference', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/conformance-oracle-execution-v1.schema.json', import.meta.url)))
  assert.equal(schema.required.includes('sourcePollJournal'), false)
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schemaErrors(ref, schema.properties.sourcePollJournal, '$', schema), [])
  for (const invalid of [null, [], {}, { ...ref, sha256: 'fake' }, { ...ref, bytes: -1 }, { ...ref, extra: true }]) {
    assert.ok(schemaErrors(invalid, schema.properties.sourcePollJournal, '$', schema).length > 0)
  }
})
