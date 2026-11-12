import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { posix, resolve } from 'node:path'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const requireCondition = (condition, message) => { if (!condition) throw new Error(message) }
// This is the already locked build dependency, not a new browser dependency.
// Pin executable parser bytes before evaluating them; version metadata alone
// does not authenticate an installed package. Keep its license with evidence.
export const GENERATED_MODULE_PARSER_PIN = Object.freeze({
  name: 'acorn', version: '8.15.0', license: 'MIT', archiveVerifiedAtBuild: false,
  npmIntegrity: 'sha512-NZyJarBfL7nWwIq+FDL6Zp/yHEhePMNnnJ0y3qfieCrmNvYct8uvtiV41UvlSe6apAfk0fY1FbWx+NwfmpvtTg==',
  files: Object.freeze([
    Object.freeze({ path: 'package.json', size: 1061, sha256: '9e422c8225c9cc4c774e9a9392d0ecac7f766b46122ef2db99db0fc4bbedc247' }),
    Object.freeze({ path: 'dist/acorn.mjs', size: 229792, sha256: 'b4c8c70200e72bae33cf1085e0ecb1e792c1b6924ed50cab817caf14f51bb249' }),
    Object.freeze({ path: 'LICENSE', size: 1099, sha256: '76a876cf886ff9be2a8b5e2e86514fed06223c8c9f0c1e9ee9606e93841e00b7' }),
  ]),
})
export const GENERATED_MODULE_LIMITS = Object.freeze({ files: 1024, fileBytes: 4 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024, references: 16_384, astNodes: 1_000_000,
  packageFileBytes: 64 * 1024 * 1024, packageBytes: 128 * 1024 * 1024, directories: 1024, depth: 64 })

export async function loadPinnedGeneratedModuleParser({ root, destination } = {}) {
  requireCondition(typeof root === 'string' && typeof destination === 'string', 'Parser needs explicit dependency root and evidence destination')
  const packageRoot = await realpath(resolve(root, 'tools/container-manifest/node_modules/acorn'))
  requireCondition((await lstat(packageRoot)).isDirectory(), 'Pinned parser root must be a directory')
  const inputs = []
  for (const file of GENERATED_MODULE_PARSER_PIN.files) {
    const path = resolve(packageRoot, file.path), stat = await lstat(path)
    requireCondition(stat.isFile() && await realpath(path) === path && stat.size === file.size,
      `Pinned parser is not a matching regular file: ${file.path}`)
    const bytes = await readFile(path)
    requireCondition(bytes.length === file.size && sha256(bytes) === file.sha256,
      `Pinned parser SHA-256 mismatch: ${file.path}`)
    inputs.push({ ...file, bytes })
  }
  const metadata = JSON.parse(inputs[0].bytes)
  requireCondition(metadata.name === 'acorn' && metadata.version === GENERATED_MODULE_PARSER_PIN.version,
    'Pinned parser metadata mismatch')
  await mkdir(destination, { recursive: true })
  const evidenceDirectory = await realpath(destination)
  for (const file of inputs) {
    const path = resolve(evidenceDirectory, file.path)
    await mkdir(resolve(path, '..'), { recursive: true })
    await writeFile(path, file.bytes, { flag: 'wx' })
  }
  // Import the verified in-memory bytes, never re-read a mutable installation
  // during evaluation. The pinned Acorn ESM is self-contained.
  const parserBytes = inputs.find(file => file.path === 'dist/acorn.mjs').bytes
  const parser = await import(`data:text/javascript;base64,${parserBytes.toString('base64')}`)
  requireCondition(typeof parser.parse === 'function' && parser.version === GENERATED_MODULE_PARSER_PIN.version,
    'Pinned parser exports mismatch')
  return { parse: parser.parse, provenance: { ...GENERATED_MODULE_PARSER_PIN,
    evidenceDirectory, status: 'passed', retainedStatus: 'not-run' } }
}

export async function verifyRetainedGeneratedModuleParser(provenance) {
  try {
    requireCondition(provenance?.name === GENERATED_MODULE_PARSER_PIN.name
      && provenance.version === GENERATED_MODULE_PARSER_PIN.version
      && JSON.stringify(provenance.files) === JSON.stringify(GENERATED_MODULE_PARSER_PIN.files),
    'Retained parser inventory differs from the fixed pin')
    for (const file of GENERATED_MODULE_PARSER_PIN.files) {
      const path = resolve(provenance.evidenceDirectory, file.path), stat = await lstat(path)
      requireCondition(stat.isFile() && await realpath(path) === path && stat.size === file.size,
        `Retained parser is not regular: ${file.path}`)
      const bytes = await readFile(path)
      requireCondition(bytes.length === file.size && sha256(bytes) === file.sha256,
        `Retained parser changed: ${file.path}`)
    }
    provenance.retainedStatus = 'passed'
  } catch (error) { if (provenance) provenance.retainedStatus = 'failed'; throw error }
}

const staticText = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value
  : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined
const importMetaUrl = node => node?.type === 'MemberExpression' && !node.computed && node.property?.name === 'url'
  && node.object?.type === 'MetaProperty' && node.object.meta.name === 'import' && node.object.property.name === 'meta'
const isJs = path => /\.(?:m?js)$/.test(path)

/** Syntax closure, not a sandbox: computed fetch/eval behavior is not certified. */
export function generatedModuleReferences(source, file, parse) {
  requireCondition(typeof parse === 'function', 'A byte-pinned module parser is required')
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })
  const stack = [tree], references = []
  let visited = 0
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    requireCondition(++visited <= GENERATED_MODULE_LIMITS.astNodes, `Generated module AST exceeds budget: ${file}`)
    let kind, specifier
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      kind = 'module'; specifier = staticText(node.source)
    } else if (node.type === 'ImportExpression') {
      kind = 'module'; specifier = staticText(node.source)
    } else if (node.type === 'NewExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'URL'
      && node.arguments.length >= 2 && importMetaUrl(node.arguments[1])) {
      kind = 'resource'; specifier = staticText(node.arguments[0])
    }
    if (kind) {
      requireCondition(typeof specifier === 'string', `Generated ${kind} reference must be static: ${file}`)
      requireCondition(references.length < GENERATED_MODULE_LIMITS.references, `Generated module references exceed budget: ${file}`)
      references.push({ kind, specifier })
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'range') continue
      if (Array.isArray(value)) { for (const child of value) stack.push(child) }
      else if (value && typeof value === 'object') stack.push(value)
    }
  }
  return references
}

function resolveReference(file, reference) {
  const text = reference.specifier
  requireCondition(text.length > 0 && !/[\\%?#\u0000-\u0020\u007f:]/.test(text)
    && !text.startsWith('/') && (reference.kind !== 'module' || /^\.\.?\//.test(text)),
  `Generated ${reference.kind} must be an ordinary relative path in pkg: ${file} -> ${text}`)
  const target = posix.normalize(posix.join(posix.dirname(file), text))
  requireCondition(target.startsWith('pkg/') && target !== 'pkg/', `Generated reference escapes pkg: ${file} -> ${text}`)
  requireCondition(reference.kind !== 'module' || isJs(target), `Generated module must resolve to JavaScript: ${file} -> ${text}`)
  return target
}

/** Validate every generated JS file before any glue module is evaluated. */
export async function verifyGeneratedModuleClosure(outDir, inventory, parser) {
  const outputRoot = await realpath(outDir)
  requireCondition(Array.isArray(inventory?.files) && inventory.files.length <= GENERATED_MODULE_LIMITS.files,
    'Generated package file budget exceeded')
  const descriptors = new Map(inventory.files.map(file => [file.path, file]))
  requireCondition(descriptors.size === inventory.files.length && descriptors.has('pkg/container_host_web.js'),
    'Generated package closure needs one unique glue entry')
  let totalBytes = 0, totalReferences = 0
  const modules = []
  for (const descriptor of inventory.files) {
    requireCondition(typeof descriptor.path === 'string' && /^pkg\//.test(descriptor.path)
      && posix.normalize(descriptor.path) === descriptor.path && !descriptor.path.includes('\\'), 'Invalid generated package inventory path')
    // wasm-bindgen may emit declaration companions. They remain retained data,
    // never executable imports; runtime TypeScript/CommonJS are unsupported.
    const declaration = /\.d\.(?:ts|mts|cts)$/.test(descriptor.path)
    requireCondition(declaration || !/\.(?:cjs|ts|mts|cts)$/.test(descriptor.path),
      `Generated package has unsupported script type: ${descriptor.path}`)
    if (!isJs(descriptor.path)) continue
    const stat = await lstat(resolve(outputRoot, descriptor.path))
    requireCondition(stat.isFile() && await realpath(resolve(outputRoot, descriptor.path)) === resolve(outputRoot, descriptor.path)
      && stat.size <= GENERATED_MODULE_LIMITS.fileBytes, `Generated module is nonregular or exceeds byte budget: ${descriptor.path}`)
    requireCondition(descriptor.path !== 'pkg/container_host_web.js' || stat.size > 0, 'wasm-bindgen did not produce JavaScript glue')
    totalBytes += stat.size
    requireCondition(totalBytes <= GENERATED_MODULE_LIMITS.totalBytes, 'Generated JavaScript exceeds total byte budget')
    const bytes = await readFile(resolve(outputRoot, descriptor.path))
    requireCondition(bytes.length === descriptor.size && sha256(bytes) === descriptor.sha256,
      `Generated module changed before syntax validation: ${descriptor.path}`)
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const parsedReferences = generatedModuleReferences(source, descriptor.path, parser.parse)
    totalReferences += parsedReferences.length
    requireCondition(totalReferences <= GENERATED_MODULE_LIMITS.references, 'Generated package reference budget exceeded')
    const references = parsedReferences.map(reference => {
      const path = resolveReference(descriptor.path, reference)
      requireCondition(descriptors.has(path), `Generated module references an unretained file: ${descriptor.path} -> ${reference.specifier}`)
      return { ...reference, path }
    })
    modules.push({ path: descriptor.path, sha256: descriptor.sha256, size: descriptor.size, references })
  }
  const indexed = new Map(modules.map(module => [module.path, module])), pending = ['pkg/container_host_web.js'], reachable = new Set()
  while (pending.length) {
    const path = pending.pop()
    if (reachable.has(path)) continue
    reachable.add(path)
    const module = indexed.get(path)
    requireCondition(module, `Generated import resolves to an unparsed module: ${path}`)
    for (const reference of module.references) if (reference.kind === 'module') pending.push(reference.path)
  }
  return { schemaVersion: 1, status: 'passed', entry: 'pkg/container_host_web.js',
    parser: { name: parser.provenance.name, version: parser.provenance.version,
      sha256: GENERATED_MODULE_PARSER_PIN.files[1].sha256 },
    modules, reachable: [...reachable].sort(), totalJavaScriptBytes: totalBytes,
    limitations: ['Static ESM/import()/import.meta.url resource syntax only; this is not a security sandbox or proof of computed network behavior',
      'Actual default-entry browser, Worker, WebGL/GPU and performance evidence remain separate'] }
}
