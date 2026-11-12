import { createHash } from 'node:crypto'

export const hosts = ['android', 'ios', 'harmony', 'web', 'macos', 'windows', 'linux']
export const sdkChains = {
  android: ['native', 'flutter', 'react-native'],
  ios: ['swiftpm', 'cocoapods', 'flutter', 'react-native'],
  harmony: ['native'],
  web: ['direct', 'worker'],
  macos: ['native', 'flutter'],
  windows: ['native', 'flutter'],
  linux: ['native', 'flutter'],
}
export const responsibilities = ['runtime', 'device', 'hostService', 'ecosystem']
export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const catalogNamesDigest = catalog => sha256(JSON.stringify(catalog.apis.map(api => api.name)))
export const catalogDigest = catalog => sha256(JSON.stringify(catalog))
const key = (...parts) => JSON.stringify(parts)
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const text = value => typeof value === 'string' && value.trim().length > 0
const digest = value => /^[a-f0-9]{64}$/.test(value ?? '')
const commit = value => /^[a-f0-9]{40}$/.test(value ?? '')
const safePath = value => text(value) && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => part === '..' || part === '' || part === '.')
const unique = (values, description) => assert(new Set(values).size === values.length, `Duplicate ${description}`)

export function validateResponsibilities(catalog, manifest) {
  assert(manifest.schemaVersion === 1, 'Unsupported API responsibility schema')
  assert(manifest.baseLibrary === catalog.baseline.baseLibrary, 'API responsibility baseline mismatch')
  assert(manifest.catalogNamesSha256 === catalogNamesDigest(catalog), 'API responsibility catalog digest mismatch')
  assert(Array.isArray(manifest.apis), 'Missing API responsibilities')
  const expected = new Set(catalog.apis.map(api => api.name))
  unique(manifest.apis.map(api => api.name), 'API responsibility')
  for (const api of manifest.apis) {
    assert(expected.has(api.name), `Unknown API responsibility: ${api.name}`)
    assert(responsibilities.includes(api.responsibility), `Invalid responsibility: ${api.name}`)
    assert(text(api.group) && text(api.basis), `Missing responsibility rationale: ${api.name}`)
  }
  assert(manifest.apis.length === expected.size, 'Incomplete API responsibilities')
  return new Map(manifest.apis.map(api => [api.name, api]))
}

// A contract is a reviewed, finite parameter/condition scope, never a claim that
// one happy-path call covers every option. An empty contract file accepts none.
export function validateAcceptanceContracts(catalog, contracts) {
  assert(contracts.schemaVersion === 1, 'Unsupported acceptance contract schema')
  assert(contracts.catalogNamesSha256 === catalogNamesDigest(catalog) && contracts.catalogSha256 === catalogDigest(catalog), 'Acceptance contract catalog digest mismatch')
  assert(Array.isArray(contracts.contracts), 'Missing acceptance contracts')
  const known = new Set(catalog.apis.map(api => api.name)), result = new Map()
  for (const contract of contracts.contracts) {
    const id = key(contract.host, contract.api)
    assert(!result.has(id), `Duplicate acceptance contract: ${id}`)
    assert(known.has(contract.api) && hosts.includes(contract.host), `Unknown acceptance scope: ${id}`)
    assert(contract.review?.status === 'reviewed' && text(contract.review.reviewer) && text(contract.review.date), `Unreviewed acceptance contract: ${id}`)
    assert(['completeApplicableScope', 'partialScope'].includes(contract.baselineCoverage), `Missing baseline parameter coverage: ${id}`)
    assert(contract.profiles?.length > 0, `No acceptance profiles: ${id}`)
    unique(contract.profiles.map(profile => profile.id), `profile in ${id}`)
    for (const profile of contract.profiles) {
      assert(text(profile.id) && text(profile.parameters) && profile.platformConditions?.length > 0 && profile.platformConditions.every(text), `Incomplete parameter or platform scope: ${id}`)
      assert(profile.sdks?.length > 0 && profile.sdks.every(sdk => sdkChains[contract.host].includes(sdk)), `Invalid SDK scope: ${id}`)
      assert(profile.engines?.length > 0 && profile.engines.every(engine => ['quickjs', 'v8'].includes(engine)), `Invalid engine scope: ${id}`)
      unique(profile.sdks, `SDK in ${id}`)
      unique(profile.engines, `engine in ${id}`)
      assert(profile.requiredChecks?.length > 0 && profile.requiredChecks.every(text), `Missing semantic checks: ${id}`)
      assert(profile.sources?.length > 0, `Missing reviewed source closure: ${id}`)
      unique(profile.sources.map(source => key(source.repository, source.path)), `source in ${id}`)
      for (const source of profile.sources) assert((source.repository === '.' || safePath(source.repository)) && safePath(source.path), `Unsafe source path: ${id}`)
      assert(Array.isArray(profile.requiredCapabilities) && profile.requiredCapabilities.every(value => ['physicalHardware', 'merchantTransaction'].includes(value)), `Invalid required capabilities: ${id}`)
    }
    const coveredSdks = new Set(contract.profiles.flatMap(profile => profile.sdks))
    // A complete contract must cover every public SDK chain for the host. A
    // partial scope is intentionally allowed to record a reviewed subset; its
    // cell remains pending until a later contract closes the remaining chains.
    if (contract.baselineCoverage === 'completeApplicableScope') {
      assert(sdkChains[contract.host].every(sdk => coveredSdks.has(sdk)), `Incomplete public SDK contract: ${id}`)
    }
    result.set(id, contract)
  }
  return result
}

async function verifyFile(reference, load, description) {
  assert(safePath(reference?.path) && digest(reference?.sha256), `Invalid ${description} reference`)
  const bytes = await load(reference.path)
  assert(sha256(bytes) === reference.sha256, `${description} digest mismatch: ${reference.path}`)
  return bytes
}

// IO is injected so the validator can check checked-in files, archived build
// receipts and git objects without interpreting a report as executable code.
export async function validateAcceptanceLedger({ catalog, contracts, ledger, load, readSource, readCommittedSource, verifyCommit }) {
  const contractMap = validateAcceptanceContracts(catalog, contracts)
  assert(ledger.schemaVersion === 1 && Array.isArray(ledger.reports), 'Invalid acceptance ledger')
  assert(ledger.catalogNamesSha256 === catalogNamesDigest(catalog) && ledger.catalogSha256 === catalogDigest(catalog), 'Acceptance ledger catalog digest mismatch')
  unique(ledger.reports.map(report => report.path), 'acceptance report')
  const accepted = new Map()
  for (const reference of ledger.reports) {
    const report = JSON.parse(await verifyFile(reference, load, 'Acceptance report'))
    assert(report.schemaVersion === 1 && report.kind === 'real-sdk-chain', 'Builds, harnesses and source inventory are not SDK acceptance')
    assert(report.catalogNamesSha256 === catalogNamesDigest(catalog) && report.catalogSha256 === catalogDigest(catalog), 'Acceptance report catalog digest mismatch')
    const claim = report.claim ?? {}, id = key(claim.host, claim.api)
    const contract = contractMap.get(id), profile = contract?.profiles.find(item => item.id === claim.profile)
    assert(profile, `No reviewed acceptance scope: ${id}`)
    assert(profile.sdks.includes(claim.sdk) && profile.engines.includes(claim.engine), `Wrong SDK or engine: ${id}`)
    assert(report.parameters === profile.parameters && JSON.stringify(report.platformConditions) === JSON.stringify(profile.platformConditions), `Evidence parameter/condition scope mismatch: ${id}`)
    assert(report.result === 'passed' && report.execution?.exitCode === 0 && text(report.execution.command), `Failed or missing execution: ${id}`)
    assert(text(report.environment?.os?.name) && text(report.environment?.os?.version), `Missing OS evidence: ${id}`)
    if (claim.host === 'web') assert(text(report.environment?.browser?.name) && text(report.environment?.browser?.version), `Missing browser evidence: ${id}`)
    for (const check of ['publicSdk', 'nativeTransport', 'realJs', 'completionToJs', ...profile.requiredChecks]) assert(report.checks?.[check] === true, `Missing real SDK check ${check}: ${id}`)
    for (const capability of profile.requiredCapabilities) assert(report.capabilities?.[capability] === true, `Missing ${capability} evidence: ${id}`)
    await verifyFile(report.execution.log, load, 'Execution log')
    const sources = report.sources
    assert(Array.isArray(sources) && sources.length > 0, `Missing source provenance: ${id}`)
    unique(sources.map(source => key(source.repository, source.path)), `evidence source in ${id}`)
    for (const required of profile.sources) assert(sources.some(source => source.repository === required.repository && source.path === required.path), `Missing source closure: ${required.repository}/${required.path}`)
    for (const source of sources) {
      assert((source.repository === '.' || safePath(source.repository)) && safePath(source.path) && digest(source.sha256) && commit(source.commit), `Invalid source provenance: ${id}`)
      assert(await verifyCommit(source.repository, source.commit), `Unreachable source commit: ${id}`)
      const current = await readSource(source.repository, source.path), committed = await readCommittedSource(source.repository, source.commit, source.path)
      assert(sha256(current) === source.sha256 && sha256(committed) === source.sha256, `Stale or unbound evidence source: ${source.repository}/${source.path}`)
    }
    for (const role of ['runtime', 'sdk']) {
      const artifact = report.artifacts?.[role]
      assert(artifact?.role === role && artifact.host === claim.host && text(artifact.version) && text(artifact.architecture) && Array.isArray(artifact.features) && artifact.protocolVersion === catalog.protocolVersion, `Invalid ${role} artifact: ${id}`)
      if (role === 'sdk') assert(artifact.sdk === claim.sdk, `Wrong SDK artifact: ${id}`)
      assert(sources.some(source => source.repository === artifact.repository && source.commit === artifact.sourceCommit), `Unbound ${role} artifact source: ${id}`)
      await verifyFile(artifact, load, `${role} artifact`)
      const receipt = JSON.parse(await verifyFile(artifact.buildReceipt, load, `${role} build receipt`))
      for (const field of ['role', 'host', 'version', 'architecture', 'protocolVersion', 'repository', 'sourceCommit', 'sha256']) assert(receipt[field] === artifact[field], `${role} build receipt ${field} mismatch: ${id}`)
      assert(JSON.stringify(receipt.features) === JSON.stringify(artifact.features) && receipt.cleanSource === true && receipt.profile === 'release', `Non-release or dirty ${role} artifact: ${id}`)
      if (role === 'sdk') assert(receipt.sdk === claim.sdk, `SDK build receipt mismatch: ${id}`)
    }
    assert(report.cleanup?.status === 'complete' && Array.isArray(report.cleanup.resources), `Missing cleanup receipt: ${id}`)
    for (const resource of report.cleanup.resources) {
      assert(text(resource.kind) && text(resource.id) && ['created', 'borrowed'].includes(resource.ownership), `Invalid cleanup resource: ${id}`)
      assert(resource.ownership === 'created' ? resource.terminal === 'closed' : resource.terminal === 'preserved' && text(resource.reason), `Resource cleanup incomplete: ${id}`)
    }
    const claimId = key(claim.host, claim.api, claim.profile, claim.sdk, claim.engine)
    assert(!accepted.has(claimId), `Duplicate acceptance claim: ${claimId}`)
    accepted.set(claimId, { path: reference.path, sha256: reference.sha256, claim, parameters: report.parameters, platformConditions: report.platformConditions, sourceCommits: [...new Set(sources.map(source => source.commit))], artifacts: report.artifacts, environment: report.environment, command: report.execution.command, cleanup: report.cleanup })
  }
  return { contracts: contractMap, accepted }
}

export function cellAcceptance(host, api, evidence = { contracts: new Map(), accepted: new Map() }) {
  const contract = evidence.contracts.get(key(host, api))
  const profiles = (contract?.profiles ?? []).map(profile => ({
    id: profile.id, parameters: profile.parameters, platformConditions: profile.platformConditions,
    chains: profile.sdks.flatMap(sdk => profile.engines.map(engine => {
      const record = evidence.accepted.get(key(host, api, profile.id, sdk, engine))
      return { sdk, engine, status: record ? 'implementedAndAccepted' : 'pendingAcceptance', ...(record ? { evidence: record } : {}) }
    })),
  }))
  const accepted = contract?.baselineCoverage === 'completeApplicableScope' && profiles.length > 0 && profiles.every(profile => profile.chains.every(chain => chain.status === 'implementedAndAccepted'))
  return {
    status: accepted ? 'implementedAndAccepted' : 'pendingAcceptance',
    coverage: { contractReviewed: Boolean(contract), baselineCoverage: contract?.baselineCoverage ?? 'unreviewed', requiredSdkChains: sdkChains[host], profiles },
  }
}

export function resolveImplementation({ api, registeredSources = [], core, delegated = false, parameterLimit }) {
  const sources = [...(core?.sources ?? []), ...registeredSources.map(source => ({ ...source, role: 'platformProvider' }))]
  const missing = [...(core?.missing ?? [])].filter(requirement => requirement !== 'platformSnapshotProvider' || registeredSources.length === 0)
  const concreteCore = sources.some(source => source.role === 'runtimeImplementation')
  const partialCore = sources.some(source => ['runtimeBridge', 'jsFacade'].includes(source.role))
  if (parameterLimit) missing.push('documentedParameterLimit')
  const implementation = registeredSources.length > 0 ? delegated ? 'delegated' : 'present' : api.owner === 'runtime' ? 'runtimeOwned' : 'absent'
  const implementationState = delegated && registeredSources.length > 0 ? 'requiresHostService'
    : (registeredSources.length > 0 || concreteCore) && missing.length === 0 ? 'available'
      : registeredSources.length > 0 || concreteCore || partialCore ? 'partial' : 'missing'
  return {
    implementation, implementationState, sources,
    ...(core?.scopes?.length ? { implementationScopes: core.scopes } : {}),
    ...(missing.length ? { missing: [...new Set(missing)] } : {}),
  }
}

export function buildApiCells({ catalog, responsibilityMap, implementation, restrictions = new Map(), parameterLimits = new Map(), evidence }) {
  return catalog.apis.map(api => ({
    name: api.name, kind: api.kind, owner: api.owner,
    responsibility: responsibilityMap.get(api.name).responsibility,
    responsibilityGroup: responsibilityMap.get(api.name).group,
    hosts: Object.fromEntries(hosts.map(host => {
      const id = key(host, api.name), source = implementation(host, api), restriction = restrictions.get(id), acceptance = cellAcceptance(host, api.name, evidence)
      assert(['missing', 'partial', 'available', 'requiresHostService'].includes(source.implementationState), `Invalid implementation state: ${id}`)
      assert(!restriction || source.implementationState === 'missing', `Restriction conflicts with implementation: ${id}`)
      assert(acceptance.status !== 'implementedAndAccepted' || ['available', 'requiresHostService'].includes(source.implementationState), `Acceptance has incomplete implementation: ${id}`)
      assert(!restriction || acceptance.coverage.profiles.length === 0, `Restriction conflicts with reviewed acceptance: ${id}`)
      return [host, {
        ...source, ...acceptance,
        ...(restriction ? { status: 'platformNotApplicable', restriction } : {}),
        ...(parameterLimits.has(id) ? { parameterLimit: parameterLimits.get(id) } : {}),
      }]
    })),
  }))
}
