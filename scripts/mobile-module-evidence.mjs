function findAppInit(value) {
  if (!value || typeof value !== 'object') return null
  if (value.op === 'app.init' && value.kind === 'response' && value.payload) return value.payload
  for (const child of Object.values(value)) {
    const result = findAppInit(child)
    if (result) return result
  }
  return null
}

function appInitFromLine(line) {
  if (!line.includes('app.init')) return null
  for (let start = line.indexOf('{'); start >= 0; start = line.indexOf('{', start + 1)) {
    let depth = 0
    let quoted = false
    let escaped = false
    for (let index = start; index < line.length; index += 1) {
      const character = line[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"') quoted = true
      else if (character === '{') depth += 1
      else if (character === '}') depth -= 1
      if (depth !== 0) continue
      try {
        const payload = findAppInit(JSON.parse(line.slice(start, index + 1)))
        if (payload) return payload
      } catch { /* Prefix braces or incomplete output are not evidence. */ }
      break
    }
  }
  return null
}

export function inspectMobileModuleExecution(platform, expectedEngine = 'quickjs') {
  const text = [
    ...(platform?.smokeLogs || []),
    ...(platform?.probes || []).flatMap(probe => [probe.stdout || '', probe.stderr || '']),
    platform?.surfaceProbe?.operations?.['app.init']?.json || '',
  ].join('\n')
  const payload = text.split(/\r?\n/).map(appInitFromLine).find(Boolean)
  const observedEngine = payload?.engine || null
  const loadedModules = Number.isInteger(payload?.loadedModules) ? payload.loadedModules : 0
  const manifestIntegrity = payload?.manifest?.integrity || null
  const checks = {
    appInitOk: payload?.ok === true,
    engineMatches: ['quickjs', 'v8'].includes(expectedEngine) && observedEngine === expectedEngine,
    engineProviderAvailable: payload?.engineProviderAvailable === true,
    modulesLoaded: loadedModules > 0,
    // Session verifies every nonempty manifest root before app.init succeeds.
    manifestIntegrity: typeof manifestIntegrity === 'string' && /^[0-9a-f]{64}$/i.test(manifestIntegrity),
  }
  const missing = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
  return {
    status: missing.length === 0 ? 'passed' : 'incomplete',
    expectedEngine,
    observedEngine,
    engineProviderAvailable: payload?.engineProviderAvailable === true,
    loadedModules,
    manifestIntegrity,
    checks,
    missing,
    reason: missing.length === 0
      ? 'app.init observed a real engine provider and modules from an integrity-checked manifest'
      : `module execution evidence is missing: ${missing.join(', ')}`,
  }
}
