/** Only this pinned pure guest read may normalize its actual poll attempts to one terminal event. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { descriptor as issue1009 } from '../conformance/recipes/issue1009-descriptor.mjs'
import { descriptor as issue1011 } from '../conformance/recipes/issue1011-descriptor.mjs'
import { methodPollPolicies as policies1011 } from '../conformance/recipes/issue1011-source-policy.mjs'
import { pureReadAudit as audit1011, assertIssue1011PureReadSource } from '../conformance/recipes/issue1011-pure-read.mjs'
import { assertSourceTapHelperEvidence } from './conformance-source-tap-evidence.mjs'
import { methodPollPolicies as policies1009 } from '../conformance/recipes/issue1009-source-policy.mjs'
import { pureReadAudit as audit1009, assertIssue1009PureReadSource } from '../conformance/recipes/issue1009-pure-read.mjs'
import { decodeMethodValue, methodArguments } from '../conformance/recipes/source-method-values.mjs'
const require = (ok, message) => { if (!ok) throw new Error('Source poll evidence: ' + message) }
const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : ''
const sha = value => createHash('sha256').update(value).digest('hex')
export function assertSourcePollEvidence({ trace, journal, build, load }) {
  assertSourceTapHelperEvidence({trace,journal})
  const descriptor=trace.caseId===issue1009.caseId?issue1009:trace.caseId===issue1011.caseId?issue1011:undefined
  const methodPollPolicies=descriptor===issue1011?policies1011:policies1009,pureReadAudit=descriptor===issue1011?audit1011:audit1009
  const assertPureRead=descriptor===issue1011?assertIssue1011PureReadSource:assertIssue1009PureReadSource
  const events = trace.events.filter(event => event.op === 'method.poll')
  if (!events.length) { require(journal === undefined, 'orphan raw journal has no normalized terminal event'); return }
  require(descriptor,'normalized poll is outside its reviewed exact source cases')
  const plan = descriptor.plans[0], step = plan.steps.find(entry => entry.kind === 'method.poll'), policy = methodPollPolicies[step.sourceCallsite]
  require(trace.caseId === descriptor.caseId && trace.run?.environment?.caseSourceSha256 === descriptor.sourceSha256 && events.length === 1,
    'normalized poll is outside its one reviewed exact source case')
  const raw = journal?.sourcePollJournal
  require(raw?.schemaVersion === 1 && raw.kind === 'pinned-pure-read-poll-journal-v1' && raw.caseId === descriptor.caseId
    && raw.sourceSha256 === descriptor.sourceSha256 && isDeepStrictEqual(raw.normalization, pureReadAudit)
    && Array.isArray(raw.attempts) && raw.attempts.length > 0, 'complete actual source-bound raw journal is absent or empty')
  for (const stage of ['sourceBefore', 'sourceAfter']) {
    const members = build?.[stage]?.filter(member => member.path === pureReadAudit.sourcePath.replace(/^e2e-apps\/github-issues\//,''))
    require(members?.length === 1 && members[0].kind === 'file' && members[0].artifact?.sha256 === pureReadAudit.sourceSha256,
      'actual build source closure differs from audited pure-read method')
    const ref = members[0].artifact, bytes = load(ref)
    require(Buffer.isBuffer(bytes) && bytes.length === ref.bytes && sha(bytes) === ref.sha256, 'audited guest source reference bytes differ')
    assertPureRead(bytes)
  }
  require(isDeepStrictEqual(journal.pollAttempts, raw.attempts), 'raw attempt journal has contradictory duplicate diagnostics')
  const first = raw.attempts[0]
  for (const [at, attempt] of raw.attempts.entries()) {
    require(keys(attempt) === (step.callOptions ? 'actionOrdinal,args,attemptOrdinal,callDeadlineMs,callOptions,completion,endedAtMs,helperSha256,method,pageId,planOrdinal,route,scopeStartedAtMs,sourceCallsite,sourceDeadlineMs,sourceStepCursor,startedAtMs' : 'actionOrdinal,args,attemptOrdinal,completion,endedAtMs,helperSha256,method,pageId,planOrdinal,route,scopeStartedAtMs,sourceCallsite,sourceDeadlineMs,sourceStepCursor,startedAtMs')
      && isDeepStrictEqual(attempt.callOptions,step.callOptions)
      && (!step.callOptions || attempt.callDeadlineMs===attempt.startedAtMs+step.callOptions.timeout && attempt.endedAtMs<=attempt.callDeadlineMs)
      && attempt.attemptOrdinal === at && attempt.planOrdinal === plan.ordinal && attempt.sourceStepCursor === plan.steps.indexOf(step)
      && attempt.actionOrdinal === step.ordinal && attempt.route === plan.route && attempt.method === step.method
      && isDeepStrictEqual(methodArguments(attempt.args), methodArguments(step.args)) && attempt.sourceCallsite === step.sourceCallsite
      && attempt.helperSha256 === step.helperSha256 && Number.isSafeInteger(attempt.pageId) && attempt.pageId >= 0 && attempt.pageId === first.pageId,
    'actual attempt identity, ordering, arguments or Page incarnation differs')
    require([attempt.startedAtMs, attempt.endedAtMs, attempt.scopeStartedAtMs, attempt.sourceDeadlineMs].every(Number.isSafeInteger)
      && attempt.scopeStartedAtMs === first.scopeStartedAtMs && attempt.sourceDeadlineMs === first.sourceDeadlineMs
      && attempt.sourceDeadlineMs === attempt.scopeStartedAtMs + step.timeoutMs && attempt.startedAtMs >= attempt.scopeStartedAtMs
      && attempt.endedAtMs >= attempt.startedAtMs && attempt.endedAtMs <= attempt.sourceDeadlineMs
      && (at === 0 || attempt.startedAtMs >= raw.attempts[at - 1].endedAtMs), 'actual attempt crossed its original source interval/deadline')
    const completion = attempt.completion
    if (completion?.kind === 'fulfilled') {
      require(keys(completion) === 'kind,value', 'actual fulfilled attempt shape differs')
      const satisfied = policy.satisfied(decodeMethodValue(completion.value))
      require(satisfied === (at === raw.attempts.length - 1), 'original matcher skipped an earlier successful result or ended on an incorrect value')
    } else {
      require(at < raw.attempts.length - 1 && completion?.kind === 'rejected' && keys(completion) === 'kind,thrown', 'actual final attempt is not fulfilled')
      const thrown = completion.thrown
      require(keys(thrown) === 'kind' && thrown.kind === 'undefined'
        || keys(thrown) === 'kind,value' && thrown.kind === 'json' && (thrown.value === null || ['string', 'boolean', 'number'].includes(typeof thrown.value))
        || keys(thrown) === 'kind,valueType' && thrown.kind === 'uninspectable' && ['object', 'function', 'symbol', 'bigint', 'number'].includes(thrown.valueType),
      'actual rejected attempt has an unreviewed thrown-value shape')
    }
  }
  require(isDeepStrictEqual(events[0].payload, { planOrdinal: plan.ordinal, actionOrdinal: step.ordinal, route: plan.route,
    method: step.method, args: methodArguments(step.args), sourceCallsite: step.sourceCallsite, helperSha256: step.helperSha256, ...(step.callOptions?{callOptions:structuredClone(step.callOptions)}:{}),
    completion: raw.attempts.at(-1).completion }), 'normalized terminal event is not the final actual fulfilled result')
  return { normalization: pureReadAudit.kind, actualAttempts: raw.attempts.length, sourceSha256: descriptor.sourceSha256 }
}
