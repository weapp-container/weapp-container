/** Normalization shared by official and native collectors; contains no oracle values. */
export const DATATYPE_OBSERVATION_VERSION = 1;

export function normalizeDatatypeObservation(caseId, { dataset, errors = [] } = {}) {
  if (dataset && dataset.case === caseId && typeof dataset.value === 'string') {
    return { schemaVersion: DATATYPE_OBSERVATION_VERSION, caseId,
      outcome: errors.length ? 'value-with-errors' : 'value', value: dataset.value };
  }
  // Retain the actual errors separately in the capture. Error equivalence is
  // deliberately not inferred from two failed render operations.
  return { schemaVersion: DATATYPE_OBSERVATION_VERSION, caseId,
    outcome: errors.length ? 'reported-error' : 'unresolved', value: null };
}

export function compareDatatypeObservations(left, right, cases) {
  const records = cases.map(({ id }) => {
    const leftCases = left.filter(value => value.caseId === id);
    const rightCases = right.filter(value => value.caseId === id);
    if (leftCases.length !== 1 || rightCases.length !== 1) {
      return { caseId: id, status: 'incomparable', reason: 'missing or duplicate observation identity' };
    }
    const a = leftCases[0];
    const b = rightCases[0];
    if (!a || !b || a.schemaVersion !== DATATYPE_OBSERVATION_VERSION || b.schemaVersion !== DATATYPE_OBSERVATION_VERSION) {
      return { caseId: id, status: 'incomparable', reason: 'missing or incompatible observation' };
    }
    if (a.outcome === 'unresolved' || b.outcome === 'unresolved') {
      return { caseId: id, status: 'incomparable', reason: 'unresolved render or transport' };
    }
    if (a.outcome !== b.outcome) return { caseId: id, status: 'different', left: a, right: b };
    if (a.outcome !== 'value') {
      return { caseId: id, status: 'incomparable', reason: 'reported errors require reviewed error-shape evidence', left: a, right: b };
    }
    return { caseId: id, status: a.value === b.value ? 'matched' : 'different', left: a.value, right: b.value };
  });
  return { status: records.some(value => value.status === 'different') ? 'different'
    : records.some(value => value.status === 'incomparable') ? 'incomplete' : 'matched', cases: records };
}
