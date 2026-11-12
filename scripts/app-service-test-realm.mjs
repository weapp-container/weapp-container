import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import vm from 'node:vm'
import { performance } from 'node:perf_hooks'

const root = new URL('../', import.meta.url)
const core = new URL('crates/container-core/src/lib.rs', root)
const environment = new URL('host_environment.rs', core)
const read = path => readFileSync(path, 'utf8')
const cache = new Map()
const unsupported = (file, message) => { throw new Error(`Unsupported production bootstrap in ${file.pathname}: ${message}`) }

// This is deliberately a small, fail-closed reader for the production Rust
// string arrays, not a second implementation of the bootstrap. A new assembly
// expression must either be supported here or fail the source fixture loudly.
class RustSources {
  constructor(file, bindings = {}) { this.file = file; this.source = read(file); this.bindings = bindings; this.offset = 0 }
  whitespace() {
    while (true) {
      const rest = this.source.slice(this.offset), space = /^\s+/.exec(rest)
      if (space) { this.offset += space[0].length; continue }
      if (rest.startsWith('//')) { const end = rest.indexOf('\n'); this.offset += end < 0 ? rest.length : end + 1; continue }
      break
    }
  }
  take(token) { this.whitespace(); if (!this.source.startsWith(token, this.offset)) unsupported(this.file, `expected ${token}`); this.offset += token.length }
  string() {
    this.whitespace()
    const rest = this.source.slice(this.offset), raw = /^r(#{0,255})"/.exec(rest)
    if (raw) {
      const end = this.source.indexOf(`"${raw[1]}`, this.offset + raw[0].length)
      if (end < 0) unsupported(this.file, 'unterminated raw string')
      const value = this.source.slice(this.offset + raw[0].length, end); this.offset = end + 1 + raw[1].length; return value
    }
    if (!rest.startsWith('"')) unsupported(this.file, 'expected Rust string literal')
    const start = this.offset++
    while (this.offset < this.source.length) {
      const next = this.source[this.offset++]
      if (next === '\\') { this.offset++; continue }
      if (next === '"') {
        try { return JSON.parse(this.source.slice(start, this.offset)) }
        catch { unsupported(this.file, 'Rust string uses an unsupported escape') }
      }
    }
    unsupported(this.file, 'unterminated string')
  }
  expression() {
    this.whitespace()
    if (this.source[this.offset] === '"' || /^r#{0,255}"/.test(this.source.slice(this.offset))) return { source: this.string(), origin: this.file }
    if (this.source[this.offset] === '(') {
      this.offset++; const fields = this.list(')'); return fields
    }
    const identifier = /^(?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.offset))?.[0]
    if (!identifier) unsupported(this.file, 'expected string, include_str!, facade or a string constant')
    this.offset += identifier.length
    if (identifier === 'include_str') {
      this.take('!'); this.take('('); const path = this.string(); this.take(')')
      const file = new URL(path, this.file); return { source: read(file), origin: file }
    }
    if (Object.hasOwn(this.bindings, identifier)) {
      if (identifier === 'facade' && this.source.startsWith('.as_str()', this.offset)) this.offset += '.as_str()'.length
      return this.bindings[identifier]
    }
    if (identifier.startsWith('container_core::')) return new RustSources(core).constant(identifier.slice('container_core::'.length))
    if (/^[A-Z][A-Z0-9_]*$/.test(identifier)) return new RustSources(this.file).constant(identifier)
    unsupported(this.file, `unrecognized expression ${identifier}`)
  }
  list(end) {
    const values = []
    while (true) {
      this.whitespace()
      if (this.source.startsWith(end, this.offset)) { this.offset += end.length; return values }
      values.push(this.expression()); this.whitespace()
      if (this.source.startsWith(end, this.offset)) { this.offset += end.length; return values }
      this.take(',')
    }
  }
  constant(name) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) unsupported(this.file, 'invalid string constant name')
    const declaration = new RegExp(`\\bconst\\s+${name}\\s*:\\s*&str\\s*=\\s*`).exec(this.source)
    if (!declaration) unsupported(this.file, `missing string constant ${name}`)
    this.offset = declaration.index + declaration[0].length
    const result = this.expression(); this.take(';'); return result
  }
  environment(facade) {
    const declaration = /\bpub\s+fn\s+app_service_environment_bootstrap\s*\(facade:\s*&str\)\s*->\s*String\s*\{\s*\[/.exec(this.source)
    if (!declaration) unsupported(this.file, 'missing app_service_environment_bootstrap string array')
    this.bindings.facade = facade; this.offset = declaration.index + declaration[0].length
    const parts = this.list(']'); this.take('.'); this.take('concat'); this.take('('); this.take(')'); this.take('}')
    if (parts.some(part => Array.isArray(part))) unsupported(this.file, 'environment assembly must contain strings')
    return { source: parts.map(part => part.source).join(''), origin: this.file, environment: true }
  }
}

/** Read the same source arrays as each native engine, including the real core
 * app_service_environment_bootstrap composition and private receiver registry.
 */
export function productionAppServiceSources(engine) {
  if (!['quickjs', 'v8'].includes(engine)) throw new Error(`Unsupported native engine: ${engine}`)
  if (cache.has(engine)) return cache.get(engine)
  const file = new URL(`crates/container-engine-${engine}/src/lib.rs`, root), parser = new RustSources(file)
  const facade = new RustSources(environment).environment(parser.constant('MINI_PROGRAM_BOOTSTRAP'))
  parser.bindings.facade = facade
  const initialization = /let\s+facade\s*=\s*container_core::app_service_environment_bootstrap\(MINI_PROGRAM_BOOTSTRAP\);/.exec(parser.source)
  if (!initialization) unsupported(file, 'engine does not compile the production environment wrapper')
  const tail = parser.source.slice(initialization.index + initialization[0].length)
  const loading = /for\s*\((?:index|name),\s*source\)\s+in\s*\[/.exec(tail)
  if (!loading) unsupported(file, 'missing native bootstrap loading array')
  parser.offset = initialization.index + initialization[0].length + loading.index + loading[0].length
  const scripts = parser.list(']').map(value => {
    const [label, script] = Array.isArray(value) ? value : [null, value]
    if (!script || Array.isArray(script)) unsupported(file, 'invalid native bootstrap source entry')
    const name = label?.source ?? (script.environment ? 'mini-program' : basename(script.origin.pathname, '.js'))
    return Object.freeze({ name, source: script.source, origin: script.origin.href, environment: script.environment === true })
  })
  assert.equal(scripts.filter(script => script.environment).length, 1, `${engine} must load exactly one production facade scope`)
  const result = Object.freeze(scripts); cache.set(engine, result); return result
}

/** VM transports stay in the test host. Receiver registration/capture cells
 * remain in the exact production lexical scope, never on application globals.
 */
export function createAppServiceTestRealm(engine, globals = {}) {
  const scripts = productionAppServiceSources(engine), context = vm.createContext({
    __container_host_performance_now: performance.now.bind(performance),
    __container_host_performance_active: () => true,
    __container_host_route_rewrite: () => JSON.stringify({ok:false,errMsg:"rewriteRoute:fail no native route event"}), ...globals,
  })
  let transports
  for (const script of scripts) {
    const result = new vm.Script(script.source, { filename: `${engine}/${script.name}.js` }).runInContext(context)
    if (script.environment) transports = result
  }
  assert.equal(typeof transports?.installHostEnvironment, 'function', `${engine} production installer transport`)
  assert.equal(typeof transports?.captureReceiverIncarnations, 'function', `${engine} production receiver transport`)
  const run = source => vm.runInContext(source, context)
  return { context, run, json: source => JSON.parse(run(`JSON.stringify(${source})`)), transports, scripts }
}
