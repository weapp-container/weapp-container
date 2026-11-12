/** Measurement v2 scores complete fixed-phase opportunities inside the actual
 * input interval. Both partial edges are excluded regardless of their result;
 * warmup and cooldown records can never fill a missing measured display slot. */
export function measureScrollPresentation({
  inputs, frames, rafOpportunities, sessionId, configGeneration,
  warmupInputs = 60, measurementIntervals = 180, hz = 60, requestedInputs = 241,
}) {
  const inputOrderValid = Array.isArray(inputs) && inputs.length > 1 &&
    inputs.every((time, index) => Number.isFinite(time) && (!index || time > inputs[index - 1]))
  const elapsed = inputOrderValid ? inputs.at(-1) - inputs[0] : 0
  const inputHz = elapsed > 0 ? (inputs.length - 1) * 1000 / elapsed : 0
  const boundaryIndex = warmupInputs + measurementIntervals
  const windowComplete = inputOrderValid && inputs.length > boundaryIndex
  const window = {
    warmupInputs, firstInputIndex: warmupInputs, endExclusiveInputIndex: boundaryIndex,
    measurementIntervals, requestedHz: hz, complete: windowComplete,
    startMs: windowComplete ? inputs[warmupInputs] : null,
    endExclusiveMs: windowComplete ? inputs[boundaryIndex] : null,
  }
  const period = 1000 / hz
  const rafOrderValid = Array.isArray(rafOpportunities) && rafOpportunities.length > 1 &&
    rafOpportunities.every((entry, index) => Number.isFinite(entry.timestamp) &&
      (!index || entry.timestamp > rafOpportunities[index - 1].timestamp))
  // The first independently observed RAF, fixed before any wheel input,
  // establishes the display phase. Never fit a phase to completed app frames.
  const phase = rafOrderValid ? rafOpportunities[0].timestamp : null
  const opportunities = new Map()
  let maxPhaseErrorMs = 0
  if (rafOrderValid) for (const entry of rafOpportunities) {
    const slot = Math.round((entry.timestamp - phase) / period)
    const phaseErrorMs = Math.abs(entry.timestamp - (phase + slot * period))
    maxPhaseErrorMs = Math.max(maxPhaseErrorMs, phaseErrorMs)
    opportunities.set(entry.timestamp, {slot, phaseErrorMs})
  }
  const rafElapsed = rafOrderValid ? rafOpportunities.at(-1).timestamp - phase : 0
  const rafHz = rafElapsed > 0 ? (rafOpportunities.length - 1) * 1000 / rafElapsed : 0
  // A tiny numeric epsilon handles IEEE rounding at an exactly equal boundary;
  // it is unrelated to display jitter and never fitted to a measured result.
  const firstSlot = windowComplete && phase !== null ? Math.ceil((window.startMs - phase) / period - 1e-9) : 0
  // A scored opportunity must receive its whole nominal period before the
  // hard end boundary. Ceil at both edges would exclude a partial first slot
  // but score a partial last slot with an arbitrarily shortened deadline.
  const endSlot = windowComplete && phase !== null ? Math.max(firstSlot, Math.floor((window.endExclusiveMs - phase) / period + 1e-9)) : firstSlot
  const expectedSlots = endSlot - firstSlot
  const measuredHz = windowComplete ? measurementIntervals * 1000 / (window.endExclusiveMs - window.startMs) : 0
  const measuredCadenceValid = windowComplete && measuredHz >= hz * .95 && measuredHz <= hz * 1.05
  const displayValid = rafOrderValid && inputOrderValid && phase <= inputs[0] && rafHz >= hz * .95 && rafHz <= hz * 1.05 && maxPhaseErrorMs <= period / 4
  const slots = new Map(), seenFrames = new Set()
  const rejected = { outsideWindow: 0, wrongSession: 0, invalid: 0, duplicateFrame: 0, unchangedPixels: 0, occupiedSlot: 0, noDisplayOpportunity: 0, lateCompletion: 0 }
  // Revision zero is the probe's initial pixel baseline, even when no
  // warmup presentation established a preceding frame in this ledger.
  let previousPixelRevision = 0
  for (const frame of [...frames].sort((a, b) => a.presentedAt - b.presentedAt)) {
    if (frame.sessionId !== sessionId || frame.configGeneration !== configGeneration) {
      rejected.wrongSession += 1
      continue
    }
    if (!Number.isFinite(frame.presentedAt) || !Number.isFinite(frame.timestamp) || frame.presentedAt < frame.timestamp ||
        !Number.isSafeInteger(frame.frameId) || frame.frameId < 0 ||
        !Number.isSafeInteger(frame.scrollPixelRevision) || frame.scrollPixelRevision < 0) {
      rejected.invalid += 1
      continue
    }
    const changedPixels = frame.scrollPixelRevision > previousPixelRevision
    previousPixelRevision = Math.max(previousPixelRevision, frame.scrollPixelRevision)
    if (!windowComplete || frame.presentedAt < window.startMs || frame.presentedAt >= window.endExclusiveMs) {
      rejected.outsideWindow += 1
      continue
    }
    const key = JSON.stringify([frame.sessionId, frame.configGeneration, frame.frameId])
    if (seenFrames.has(key)) { rejected.duplicateFrame += 1; continue }
    seenFrames.add(key)
    if (!changedPixels) { rejected.unchangedPixels += 1; continue }
    const opportunity = opportunities.get(frame.timestamp)
    if (!opportunity || opportunity.phaseErrorMs > period / 4) { rejected.noDisplayOpportunity += 1; continue }
    const slot = opportunity.slot - firstSlot
    if (slot < 0 || slot >= expectedSlots) { rejected.outsideWindow += 1; continue }
    if (frame.presentedAt >= phase + (opportunity.slot + 1) * period) { rejected.lateCompletion += 1; continue }
    if (slots.has(slot)) { rejected.occupiedSlot += 1; continue }
    slots.set(slot, {slot, displaySlot: opportunity.slot, opportunityStartMs: phase + opportunity.slot * period,
      deadlineMs: phase + (opportunity.slot + 1) * period, rafTimestamp: frame.timestamp,
      frameId: frame.frameId, presentedAt: frame.presentedAt, scrollPixelRevision: frame.scrollPixelRevision})
  }
  const presented = slots.size
  const dropped = expectedSlots > 0 ? Math.max(0, expectedSlots - presented) / expectedSlots : 1
  const missingSlots = Array.from({length: expectedSlots}, (_, slot) => slot).filter(slot => !slots.has(slot))
  return {
    measurementVersion: 2, window, inputHz, elapsedMs: elapsed, expected60HzSlots: expectedSlots,
    displaySlots: {
      phaseMs: phase, firstSlot, endExclusiveSlot: endSlot, periodMs: period, maxPhaseErrorMs,
      rule: 'first independent RAF before wheel fixes phase; round((RAF timestamp - phase) / (1000/60)) preserves missing opportunity numbers; app frames bind by identical RAF timestamp',
      selection: 'only complete fixed-phase opportunities: start <= phase + slot * period and phase + (slot + 1) * period <= end; both partial edges excluded regardless of success',
      deadline: 'completion must follow its RAF timestamp and precede the next fixed opportunity deadline; every scored deadline is within the end-exclusive input boundary and no completion outside the window receives credit',
    },
    completedSlots: [...slots.values()].sort((a, b) => a.slot - b.slot), missingSlots, rejected,
    scrollInputCadence: {
      minimumHz: hz * .95, maximumHz: hz * 1.05, actualHz: inputHz,
      delivered: inputs.length, requested: requestedInputs,
      status: inputOrderValid && inputHz >= hz * .95 && inputHz <= hz * 1.05 && inputs.length >= requestedInputs - 2 ? 'passed' : 'failed',
      method: 'all actual canvas wheel timestamps; at most two delivery losses; measurement still requires both fixed boundary inputs',
    },
    scrollMeasuredInputCadence: {
      minimumHz: hz * .95, maximumHz: hz * 1.05, actualHz: measuredHz,
      intervals: measurementIntervals, complete: windowComplete,
      status: measuredCadenceValid ? 'passed' : 'failed',
      method: 'actual input 60 to input 240 only; warmup slowdown and later driver catchup cannot cancel each other',
    },
    scrollDisplayCadence: {
      minimumHz: hz * .95, maximumHz: hz * 1.05, actualHz: rafHz,
      observedOpportunities: rafOpportunities?.length || 0, phaseMs: phase, maxPhaseErrorMs,
      status: displayValid ? 'passed' : 'failed',
      method: 'independent full RAF ledger; fixed 60Hz headless environment; missing RAF opportunities remain denominator slots, no phase or refresh-rate fitting',
    },
    scrollDropRate: {
      measurementVersion: 2, limit: .01, actual: dropped, expectedSlots, inputs: inputs.length, presented,
      status: measuredCadenceValid && displayValid && expectedSlots > 0 && dropped <= .01 ? 'passed' : 'failed',
      method: 'one completed pixel-changing frame per complete fixed-phase RAF display opportunity contained in [actual input 60, actual input 240); unique session/generation/frame IDs; neither partial edge nor warmup or cooldown receives credit',
    },
  }
}
