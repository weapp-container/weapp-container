/**
 * Normalize only engine metadata from a retained simulator trace.
 *
 * `traceSummary.retainedBytes` measures the serialized size of records held by
 * the engine adapter. It is an implementation/accounting detail: the encoded
 * records include engine-specific diagnostic metadata even when their bridge
 * semantics are identical. Protocol records remain fully comparable.
 */
export function normalizeEngineTrace(value, context = '') {
  if (Array.isArray(value)) return value.map(item => normalizeEngineTrace(item, context))
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const key of Object.keys(value).sort()) {
    if (key === 'engine' || key === 'engineProviderAvailable') continue
    if (key === 'source' && (value[key] === 'quickjs' || value[key] === 'v8')) continue
    if (context === 'traceSummary' && key === 'retainedBytes') continue
    output[key] = normalizeEngineTrace(value[key], key === 'traceSummary' ? key : context)
  }
  return output
}

export function compareEngineTraces(quickjs, v8) {
  if (!quickjs || !v8) return { status: 'failed', reason: 'missing trace' }
  const left = JSON.stringify(normalizeEngineTrace(quickjs))
  const right = JSON.stringify(normalizeEngineTrace(v8))
  return left === right
    ? { status: 'passed', reason: 'normalized bridge traces match' }
    : { status: 'failed', reason: 'normalized bridge traces differ' }
}
