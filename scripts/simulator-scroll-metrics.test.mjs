import assert from 'node:assert/strict'
import test from 'node:test'
import { measureScrollPresentation } from './lib/simulator-scroll-metrics.mjs'

const period = 1000 / 60, sessionId = 'scroll-session', configGeneration = 8
const inputs = Array.from({length: 241}, (_, index) => 1000 + index * period)
const rafOpportunities = Array.from({length: 255}, (_, index) => ({timestamp: inputs[0] + index * period}))
const frame = (index, overrides = {}) => ({
  sessionId, configGeneration, frameId: index + 1, scrollPixelRevision: index + 1,
  timestamp: inputs[0] + index * period,
  // Completion stays strictly inside a slot rather than at a float boundary.
  presentedAt: inputs[0] + (index + .5) * period, ...overrides,
})
const frames = Array.from({length: 241}, (_, index) => frame(index))
const score = (changes = {}) => measureScrollPresentation({inputs, frames, rafOpportunities, sessionId, configGeneration, ...changes})

test('fixed warmup and boundary inputs define 180 measured slots with no cooldown credit', () => {
  const result = score()
  assert.equal(result.measurementVersion, 2)
  assert.equal(result.scrollDropRate.measurementVersion, 2)
  assert.equal(result.scrollInputCadence.status, 'passed')
  assert.equal(result.scrollMeasuredInputCadence.status, 'passed')
  assert.equal(result.scrollDisplayCadence.status, 'passed')
  assert.equal(result.window.startMs, inputs[60])
  assert.equal(result.window.endExclusiveMs, inputs[240])
  assert.equal(result.expected60HzSlots, 180)
  assert.equal(result.scrollDropRate.presented, 180)
  assert.equal(result.scrollDropRate.actual, 0)
  assert.equal(result.scrollDropRate.status, 'passed')
  assert.equal(result.rejected.outsideWindow, 61)
})

test('both partial edge opportunities are excluded whether they complete early, late, or never', () => {
  // The input window starts and ends a quarter period into its edge slots.
  // Only slots 61..239 receive a whole period; slot 60 and slot 240 never do.
  const shiftedInputs = inputs.map(time => time + period / 4)
  for (const boundaryCompletion of ['inside', 'outside', 'absent']) {
    let boundaryFrames = frames.filter((_, index) => index !== 60 && index !== 240)
    if (boundaryCompletion !== 'absent') boundaryFrames = [...boundaryFrames,
      frame(60, { presentedAt: frame(60).timestamp + period * (boundaryCompletion === 'inside' ? .5 : .125) }),
      frame(240, { presentedAt: frame(240).timestamp + period * (boundaryCompletion === 'inside' ? .125 : .5) }),
    ]
    const result = score({ inputs: shiftedInputs, frames: boundaryFrames })
    assert.equal(result.displaySlots.firstSlot, 61)
    assert.equal(result.displaySlots.endExclusiveSlot, 240)
    assert.equal(result.expected60HzSlots, 179)
    assert.equal(result.scrollDropRate.presented, 179, boundaryCompletion)
    assert.equal(result.scrollDropRate.actual, 0, boundaryCompletion)
    assert.equal(result.scrollDropRate.status, 'passed', boundaryCompletion)
    assert.ok(result.completedSlots.every(slot => slot.displaySlot !== 60 && slot.displaySlot !== 240))
  }
})

test('every scored opportunity receives a full nominal period inside the actual input window', () => {
  for (const fraction of [0, .006, .1, .5, .99]) {
    const shiftedInputs = inputs.map(time => time + fraction * period)
    const result = score({ inputs: shiftedInputs })
    assert.equal(result.expected60HzSlots, fraction === 0 ? 180 : 179)
    assert.equal(result.scrollDropRate.status, 'passed')
    for (const opportunity of result.completedSlots) {
      assert.ok(opportunity.opportunityStartMs >= result.window.startMs - 1e-8)
      assert.ok(opportunity.deadlineMs <= result.window.endExclusiveMs + 1e-8)
      assert.ok(Math.abs(opportunity.deadlineMs - opportunity.opportunityStartMs - period) < 1e-8)
      assert.ok(opportunity.presentedAt < opportunity.deadlineMs)
    }
  }
})

test('an end boundary exactly on a deadline includes the preceding full opportunity only', () => {
  const result = score()
  assert.equal(result.displaySlots.endExclusiveSlot, 240)
  assert.equal(result.completedSlots.at(-1).displaySlot, 239)
  assert.equal(result.completedSlots.at(-1).deadlineMs, result.window.endExclusiveMs)
  assert.ok(!result.completedSlots.some(slot => slot.displaySlot === 240))
})

test('a window with no complete opportunity fails even when input and display cadence pass', () => {
  const shortInputs = [inputs[0] + period / 4, inputs[0] + period * 1.25]
  const result = measureScrollPresentation({ inputs: shortInputs, frames, rafOpportunities, sessionId, configGeneration,
    warmupInputs: 0, measurementIntervals: 1, requestedInputs: 2 })
  assert.equal(result.scrollInputCadence.status, 'passed')
  assert.equal(result.scrollMeasuredInputCadence.status, 'passed')
  assert.equal(result.scrollDisplayCadence.status, 'passed')
  assert.equal(result.expected60HzSlots, 0)
  assert.equal(result.scrollDropRate.presented, 0)
  assert.equal(result.scrollDropRate.actual, 1)
  assert.equal(result.scrollDropRate.status, 'failed')
})

test('a shorter-than-one-period window has an empty denominator and cannot pass', () => {
  const result = measureScrollPresentation({ inputs: [inputs[0] + period / 4, inputs[0] + period / 2],
    frames, rafOpportunities, sessionId, configGeneration, warmupInputs: 0, measurementIntervals: 1, requestedInputs: 2 })
  assert.equal(result.expected60HzSlots, 0)
  assert.equal(result.scrollDropRate.status, 'failed')
  assert.deepEqual(result.missingSlots, [])
})

test('two missed visible slots exceed one percent and late catchup frames cannot repair them', () => {
  const dropped = frames.filter((_, index) => index !== 80 && index !== 81)
  const late = [frame(242), frame(243)]
  const result = score({frames: [...dropped, ...late]})
  assert.equal(result.scrollDropRate.presented, 178)
  assert.equal(result.scrollDropRate.actual, 2 / 180)
  assert.equal(result.scrollDropRate.status, 'failed')
  assert.deepEqual(result.missingSlots, [20, 21])
})

test('partial edges and missing RAF callbacks never erase internal losses from the full-opportunity denominator', () => {
  const missing = new Set([80, 81])
  const result = score({ inputs: inputs.map(time => time + period / 4),
    frames: [...frames.filter((_, index) => !missing.has(index)), frame(242), frame(243)],
    rafOpportunities: rafOpportunities.filter((_, index) => !missing.has(index)),
  })
  assert.equal(result.expected60HzSlots, 179)
  assert.equal(result.scrollDropRate.presented, 177)
  assert.equal(result.scrollDropRate.limit, .01)
  assert.equal(result.scrollDropRate.actual, 2 / 179)
  assert.equal(result.scrollDropRate.status, 'failed')
  assert.deepEqual(result.missingSlots, [19, 20])
})

test('one missed slot keeps the original one-percent threshold rather than requiring an invented zero-drop gate', () => {
  const result = score({frames: frames.filter((_, index) => index !== 80)})
  assert.equal(result.scrollDropRate.actual, 1 / 180)
  assert.equal(result.scrollDropRate.status, 'passed')
})

test('completion at the end-exclusive boundary and old RAF metadata cannot fill a missed slot', () => {
  const result = score({frames: frames.map((value, index) =>
    index === 80 ? {...value, timestamp: frame(80).presentedAt, presentedAt: inputs[240]} :
      index === 81 ? {...value, timestamp: frame(81).presentedAt, presentedAt: inputs[240] + .1} : value)})
  assert.equal(result.scrollDropRate.presented, 178)
  assert.equal(result.scrollDropRate.status, 'failed')
  assert.deepEqual(result.missingSlots, [20, 21])
})

test('multiple frames in one display slot cannot fill any missing slot', () => {
  const result = score({frames: frames.map((value, index) =>
    index === 80 || index === 81 ? {...value, timestamp: frame(79).timestamp, presentedAt: frame(79).presentedAt + index / 1000} : value)})
  assert.equal(result.scrollDropRate.presented, 178)
  assert.equal(result.rejected.occupiedSlot, 2)
  assert.equal(result.scrollDropRate.status, 'failed')
})

test('repeated frame identity cannot create new progress in a later slot', () => {
  const result = score({frames: frames.map((value, index) =>
    index === 80 || index === 81 ? {...value, frameId: frame(79).frameId} : value)})
  assert.equal(result.scrollDropRate.presented, 178)
  assert.equal(result.rejected.duplicateFrame, 2)
  assert.equal(result.scrollDropRate.status, 'failed')
})

test('new metadata over unchanged visible pixels cannot create completed progress', () => {
  const result = score({frames: frames.map((value, index) =>
    index === 80 || index === 81 ? {...value, scrollPixelRevision: frame(79).scrollPixelRevision} : value)})
  assert.equal(result.scrollDropRate.presented, 178)
  assert.equal(result.rejected.unchangedPixels, 2)
  assert.equal(result.scrollDropRate.status, 'failed')
})

test('an unchanged first measured presentation cannot manufacture progress when warmup painted nothing', () => {
  // No frame was presented during warmup. The first measured commit repeats
  // the probe's initial pixels (revision zero); a second slot is also absent.
  // Counting that unchanged first commit would turn two real losses into one
  // and incorrectly pass the unchanged one-percent gate.
  const measuredOnly = frames.filter((_, index) => index >= 60 && index !== 80)
    .map((value, index) => ({...value, scrollPixelRevision: index, scrollPixelsChanged: index > 0}))
  const result = score({frames: measuredOnly})
  assert.equal(result.scrollInputCadence.status, 'passed')
  assert.equal(result.scrollMeasuredInputCadence.status, 'passed')
  assert.equal(result.scrollDisplayCadence.status, 'passed')
  assert.equal(result.expected60HzSlots, 180)
  assert.equal(result.scrollDropRate.presented, 178)
  assert.equal(result.rejected.unchangedPixels, 1)
  assert.deepEqual(result.missingSlots, [0, 20])
  assert.equal(result.scrollDropRate.actual, 2 / 180)
  assert.equal(result.scrollDropRate.status, 'failed')
})

test('a changed first measured presentation still counts without warmup frames', () => {
  const measuredOnly = frames.filter((_, index) => index >= 60)
    .map((value, index) => ({...value, scrollPixelRevision: index + 1, scrollPixelsChanged: true}))
  const result = score({frames: measuredOnly})
  assert.equal(result.expected60HzSlots, 180)
  assert.equal(result.scrollDropRate.presented, 180)
  assert.equal(result.rejected.unchangedPixels, 0)
  assert.deepEqual(result.missingSlots, [])
  assert.equal(result.scrollDropRate.actual, 0)
  assert.equal(result.scrollDropRate.status, 'passed')
})

test('wrong session and configuration frames cannot compensate for missing pixels', () => {
  const result = score({frames: frames.map((value, index) =>
    index === 80 ? {...value, sessionId: 'old-session'} : index === 81 ? {...value, configGeneration: 7} : value)})
  assert.equal(result.scrollDropRate.presented, 178)
  assert.equal(result.rejected.wrongSession, 2)
  assert.equal(result.scrollDropRate.status, 'failed')
})

test('up to two missing native inputs never manufacture the absent measurement boundary', () => {
  const result = score({inputs: inputs.slice(0, 239)})
  assert.equal(result.scrollInputCadence.status, 'passed', 'delivery tolerance stays explicit and separate')
  assert.equal(result.window.complete, false)
  assert.equal(result.scrollDropRate.status, 'failed')
  assert.equal(result.scrollDropRate.presented, 0)
})

test('a slow driver cannot claim 60Hz coverage even when every visible frame completes', () => {
  const slowInputs = inputs.map((time, index) => inputs[0] + index * 1000 / 30)
  const result = score({inputs: slowInputs})
  assert.equal(result.scrollInputCadence.status, 'failed')
  assert.equal(result.scrollDropRate.status, 'failed')
})

test('slow warmup and measured driver catchup cannot hide an out-of-range measured input cadence', () => {
  const caughtUp = inputs.map((_, index) => inputs[0] +
    (index <= 60 ? index * 20 : 1200 + (index - 60) * 2800 / 180))
  const result = score({inputs: caughtUp})
  assert.equal(result.scrollInputCadence.status, 'passed', 'all 241 inputs still average exactly 60Hz')
  assert.equal(result.scrollDisplayCadence.status, 'passed')
  assert.equal(result.scrollDropRate.actual, 0, 'a zero raw drop count cannot establish 60Hz measured coverage')
  assert.ok(result.scrollMeasuredInputCadence.actualHz > 63)
  assert.equal(result.scrollMeasuredInputCadence.status, 'failed')
  assert.equal(result.scrollDropRate.status, 'failed')
})

test('fast warmup cannot hide a slow measurement segment under an overall 60Hz average', () => {
  const slowed = inputs.map((_, index) => inputs[0] +
    (index <= 60 ? index * 1000 / 90 : 60 * 1000 / 90 + (index - 60) * 1000 / 54))
  const result = score({inputs: slowed})
  assert.equal(result.scrollInputCadence.status, 'passed')
  assert.ok(result.scrollMeasuredInputCadence.actualHz < 57)
  assert.equal(result.scrollMeasuredInputCadence.status, 'failed')
  assert.equal(result.scrollDropRate.status, 'failed')
})

test('stable RAF display opportunities survive alternating completion jitter across input slot boundaries', () => {
  const phase = inputs[0] - .5
  const jittered = frames.map((value, index) => ({...value,
    timestamp: phase + index * period,
    presentedAt: inputs[0] + index * period + (index % 2 ? .2 : -.2),
  }))
  const ledger = rafOpportunities.map((_, index) => ({timestamp: phase + index * period}))
  const result = score({frames: jittered, rafOpportunities: ledger})
  assert.equal(result.scrollDisplayCadence.status, 'passed')
  assert.equal(result.displaySlots.phaseMs, phase)
  assert.equal(result.scrollDropRate.presented, 179, 'the partial last opportunity is excluded independently of its completed pixels')
  assert.equal(result.scrollDropRate.actual, 0)
  assert.equal(result.scrollDropRate.status, 'passed')
  assert.equal(result.rejected.occupiedSlot, 0)
})

test('missing real RAF callbacks keep empty opportunity numbers in the fixed denominator', () => {
  const missing = new Set([80, 81])
  const result = score({
    frames: frames.filter((_, index) => !missing.has(index)),
    rafOpportunities: rafOpportunities.filter((_, index) => !missing.has(index)),
  })
  assert.equal(result.scrollDisplayCadence.status, 'passed', 'two missing opportunities do not change the nominal environment')
  assert.equal(result.expected60HzSlots, 180)
  assert.equal(result.scrollDropRate.presented, 178)
  assert.equal(result.scrollDropRate.status, 'failed')
  assert.deepEqual(result.missingSlots, [20, 21])
})

test('a frame without an independently observed RAF opportunity cannot fill a missing display slot', () => {
  const result = score({rafOpportunities: rafOpportunities.filter((_, index) => index !== 80 && index !== 81)})
  assert.equal(result.scrollDropRate.presented, 178)
  assert.equal(result.rejected.noDisplayOpportunity, 2)
  assert.equal(result.scrollDropRate.status, 'failed')
})

test('long presentations miss their original opportunity even if metadata names that old RAF', () => {
  const result = score({frames: frames.map((value, index) =>
    index === 80 || index === 81 ? {...value, presentedAt: value.timestamp + period + .2} : value)})
  assert.equal(result.scrollDropRate.presented, 178)
  assert.equal(result.rejected.lateCompletion, 2)
  assert.equal(result.scrollDropRate.status, 'failed')
})

test('display phase must be fixed before the wheel sequence and is never selected from good app frames', () => {
  const result = score({rafOpportunities: rafOpportunities.slice(1)})
  assert.equal(result.scrollDisplayCadence.status, 'failed')
  assert.equal(result.scrollDropRate.status, 'failed')
})

test('a 120Hz display is explicitly outside this fixed 60Hz environment gate', () => {
  const ledger = Array.from({length: 510}, (_, index) => ({timestamp: inputs[0] + index * period / 2}))
  const result = score({rafOpportunities: ledger})
  assert.equal(result.scrollDisplayCadence.status, 'failed')
  assert.equal(result.scrollDropRate.status, 'failed')
})
