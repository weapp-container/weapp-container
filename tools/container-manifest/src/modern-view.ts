import type { JsonObject, PackOptions, ViewDocument, WxmlNode, ViewExpression } from './types.ts';
import { errorInfo } from './types.ts';
import type { Node as BabelNode } from '@babel/types';
import type { ParseResult } from '@babel/parser';
import type { File } from '@babel/types';
export interface ModernViewConfig { project: string; resolveRoot: string; configFile: string; configPath: string; bytes: Buffer; documents: Map<string, Record<string, string>>; watchDependencies: Map<string, string> }
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

export const MODERN_VIEW_COMPILER = 'weapp-container-modern-view';
export const MODERN_VIEW_VERSION = '1.0.0';
export const MODERN_VIEW_ABI = '1.0';
export const MODERN_VIEW_TARGET = 'es2022';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort(compare).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const record = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const builtin = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/, ''), `node:${name.replace(/^node:/, '')}`]));
const forbiddenGlobals = new Set([
  'Promise', 'queueMicrotask', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'Worker', 'SharedWorker', 'ServiceWorker', 'navigator', 'document', 'window', 'self',
  'localStorage', 'sessionStorage', 'indexedDB', 'location', 'history', 'screen',
  'process', 'Buffer', '__dirname', '__filename', 'global', 'globalThis', 'Deno', 'Bun',
  'wx', 'App', 'Page', 'Component', 'Behavior', 'getApp', 'getCurrentPages',
  'eval', 'Function', 'WebAssembly', 'Atomics', 'SharedArrayBuffer',
]);
const reserved = new Set(('await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield').split(' '));
const canonicalPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\\#?:\x00-\x1f\x7f-\x9f]/.test(value)
  && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export class ModernViewError extends Error {
  code: string;
  path: string | undefined;
  location: unknown;
  constructor(code: string, message: string, file?: string, location?: unknown) {
    super(message);
    this.code = code;
    this.path = file;
    this.location = location;
  }
}

function fail(code: string, message: string, file?: string, location?: unknown): never { throw new ModernViewError(code, message, file, location); }

/** Only an explicit project enables container-only authoring. Raw wv output is never edited. */
export async function loadModernViewConfig(options: PackOptions = {}): Promise<ModernViewConfig | null> {
  if (!options.project) {
    if (options.configFile || options.resolveRoot) fail('ERR_MODERN_VIEW_CONFIG', '--config/--resolve-root requires --project');
    return null;
  }
  let project;
  try { project = await fs.realpath(path.resolve(options.project)); }
  catch (caught) { const error = errorInfo(caught); fail('ERR_MODERN_VIEW_CONFIG', `Cannot read source project: ${error.message}`, options.project); }
  const configFile = path.resolve(project, options.configFile ?? 'container.config.json');
  if (!inside(project, configFile)) fail('ERR_MODERN_VIEW_CONFIG', 'Container config must be inside the project', options.configFile);
  let bytes;
  try { bytes = await fs.readFile(configFile); }
  catch (caught) { const error = errorInfo(caught);
    if (error.code === 'ENOENT' && !options.configFile) return null;
    fail('ERR_MODERN_VIEW_CONFIG', `Cannot read container config: ${error.message}`, configFile);
  }
  if (!inside(project, await fs.realpath(configFile))) fail('ERR_MODERN_VIEW_CONFIG', 'Container config symlink escapes the project', configFile);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (caught) { const error = errorInfo(caught); fail('ERR_MODERN_VIEW_CONFIG', `Invalid UTF-8 JSON container config: ${error.message}`, configFile); }
  if (!record(value) || (value.view !== undefined && !record(value.view))) fail('ERR_MODERN_VIEW_CONFIG', 'Container config must contain an object view.documents map', configFile);
  const declarations = value.view?.documents ?? {};
  if (!record(declarations)) fail('ERR_MODERN_VIEW_CONFIG', 'view.documents must be an object', configFile);
  const documents = new Map<string, Record<string, string>>();
  for (const documentId of Object.keys(declarations).sort(compare)) {
    const entry = declarations[documentId];
    if (!canonicalPath(documentId) || !documentId.endsWith('.wxml')) fail('ERR_MODERN_VIEW_CONFIG', `Invalid emitted WXML document path: ${documentId}`, configFile);
    if (!record(entry) || entry.mode !== 'modern' || !record(entry.modules)
      || Object.keys(entry).some(key => !['mode', 'modules'].includes(key))) {
      fail('ERR_MODERN_VIEW_CONFIG', `Document ${documentId} requires {mode:"modern",modules:{alias:source}}`, configFile);
    }
    const modules: Record<string, string> = Object.create(null);
    for (const alias of Object.keys(entry.modules).sort(compare)) {
      const configuredSource = entry.modules[alias];
      const source = typeof configuredSource === 'string' ? configuredSource.replace(/^\.\//, '') : configuredSource;
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(alias) || reserved.has(alias)) fail('ERR_MODERN_VIEW_CONFIG', `Invalid modern module alias: ${alias}`, configFile);
      if (!canonicalPath(source) || !/\.view\.(?:ts|js)$/.test(source)) fail('ERR_MODERN_VIEW_CONFIG', `Modern entry must be a project-relative .view.ts/.view.js file: ${source}`, configFile);
      modules[alias] = source;
    }
    documents.set(documentId, modules);
  }
  return { project, resolveRoot: path.resolve(options.resolveRoot ?? project), configFile,
    watchDependencies: new Map([[await fs.realpath(configFile), digest(bytes)]]),
    configPath: path.relative(project, configFile).split(path.sep).join('/'), bytes, documents };
}

function templateEdges(document: ViewDocument, available: Map<string, ViewDocument>) {
  const edges = new Set<string>();
  const walk = (nodes: WxmlNode[]) => {
    for (const node of nodes) {
      if (node.kind !== 'element') continue;
      if (node.tag === 'wxs') fail('ERR_MODERN_VIEW_CONFIG', 'A modern document cannot declare legacy WXS', document.documentId);
      if (node.tag === 'import' || node.tag === 'include') {
        const source = node.attrs.src;
        if (typeof source !== 'string' || !source.endsWith('.wxml') || /[\\#?:\x00-\x1f]/.test(source)) {
          fail('ERR_MODERN_VIEW_CONFIG', 'Modern import/include requires a static .wxml path', document.documentId);
        }
        const target = source.startsWith('/') ? path.posix.normalize(source.slice(1))
          : path.posix.join(path.posix.dirname(document.documentId), source);
        if (!canonicalPath(target) || !available.has(target)) fail('ERR_MODERN_VIEW_CONFIG', `Missing import/include document: ${source}`, document.documentId);
        edges.add(target);
      }
      walk(node.children);
    }
  };
  walk(document.ast.nodes);
  return edges;
}

/** Select connected template scopes before compiling; a graph never crosses language modes. */
function modernGroups(documents: ViewDocument[], config: ModernViewConfig) {
  const byId = new Map(documents.map(document => [document.documentId, document]));
  for (const id of config.documents.keys()) {
    if (!byId.has(id)) fail('ERR_MODERN_VIEW_CONFIG', `Configured document is absent from compiler output: ${id}`, config.configPath);
  }
  const neighbors = new Map([...config.documents.keys()].map(id => [id, new Set<string>()]));
  for (const document of documents) {
    const modern = config.documents.has(document.documentId);
    // Legacy parsing is unchanged. Only inspect its import/include edges when
    // necessary to reject an incoming edge into the modern realm.
    const visit = (nodes: WxmlNode[]) => {
      for (const node of nodes) {
        if (node.kind !== 'element') continue;
        if (node.tag === 'import' || node.tag === 'include') {
          const source = node.attrs.src;
          if (typeof source === 'string') {
            const target = source.startsWith('/') ? path.posix.normalize(source.slice(1))
              : path.posix.join(path.posix.dirname(document.documentId), source);
            if (modern !== config.documents.has(target)) fail('ERR_MODERN_VIEW_CONFIG', `import/include cannot cross legacy/modern modes: ${document.documentId} → ${target}`, document.documentId);
          }
        }
        visit(node.children);
      }
    };
    visit(document.ast.nodes);
    if (!modern) continue;
    for (const target of templateEdges(document, byId)) {
      neighbors.get(document.documentId)!.add(target);
      neighbors.get(target)!.add(document.documentId);
    }
  }
  const pending = new Set(neighbors.keys());
  const groups = [];
  while (pending.size) {
    const stack = [pending.values().next().value!];
    const group = [];
    while (stack.length) {
      const id = stack.pop()!;
      if (!pending.delete(id)) continue;
      group.push(id);
      stack.push(...neighbors.get(id)!);
    }
    groups.push(group.sort(compare));
  }
  return groups;
}

function validateSource(source: string, id: string, parser: typeof import('@babel/parser'), traverse: typeof import('@babel/traverse').default, expression?: ViewExpression) {
  let ast: ParseResult<File>;
  const parse = (code: string) => parser.parse(code, { sourceType: 'unambiguous', createImportExpressions: true,
    plugins: !expression && /\.(?:ts|mts|cts)$/.test(id) ? ['typescript'] : [] });
  try {
    if (!expression) ast = parse(source);
    else {
      try { ast = parse(`(${source}\n)`); }
      catch (caught) { const error = errorInfo(caught);
        if (!expression.shorthand) throw error;
        ast = parse(`({${source}\n})`);
      }
      if (ast.program.body.length !== 1 || ast.program.body[0].type !== 'ExpressionStatement') throw new Error('WXML requires one expression');
    }
  }
  catch (caught) { const error = errorInfo(caught); fail('ERR_UNSUPPORTED_MODERN_VIEW_SYNTAX', error.message, id, error.loc); }
  const reject = (node: BabelNode, message: string) => fail('ERR_UNSUPPORTED_MODERN_VIEW_SYNTAX', message, id, node.loc?.start);
  traverse(ast, {
    // Type positions disappear before execution. Do not mistake a type-only
    // reference to Promise/globalThis for a synchronous runtime dependency.
    TSType(p) { p.skip(); },
    TSInterfaceDeclaration(p) { p.skip(); },
    TSTypeAliasDeclaration(p) { p.skip(); },
    TSDeclareFunction(p) { p.skip(); },
    TSModuleDeclaration(p) { reject(p.node, 'TypeScript namespace is outside modern View execution'); },
    Function(p) { if (p.node.async) reject(p.node, 'Async functions are outside synchronous modern View execution'); },
    AwaitExpression(p) { reject(p.node, 'await is outside synchronous modern View execution'); },
    ForOfStatement(p) { if (p.node.await) reject(p.node, 'for-await is outside synchronous modern View execution'); },
    ImportExpression(p) { reject(p.node, 'Dynamic import is outside the static modern View graph'); },
    MetaProperty(p) { if (p.node.meta.name === 'import') reject(p.node, 'import.meta host metadata is not available in modern View'); },
    ReferencedIdentifier(p) {
      if (forbiddenGlobals.has(p.node.name) && !p.scope.getBinding(p.node.name)) reject(p.node, `Global ${p.node.name} is not available in synchronous modern View`);
      if (p.node.name === 'require' && !p.scope.getBinding('require')) {
        if (expression) reject(p.node, 'Template expressions cannot load modules; use a configured modern alias');
        const call = p.parentPath;
        if (!call.isCallExpression() || call.node.callee !== p.node || call.node.arguments.length !== 1 || call.node.arguments[0].type !== 'StringLiteral') {
          reject(p.node, 'CommonJS dependencies must use direct static require("specifier")');
        }
      }
    },
  });
}

async function sourceIdentity(id: string, project: string): Promise<string> {
  if (inside(project, id) && !id.split(path.sep).includes('node_modules')) return path.relative(project, id).split(path.sep).join('/');
  // pnpm and other package managers may resolve symlinks outside the source
  // snapshot. Package name/version, not the machine's store path, is provenance.
  let directory = path.dirname(id);
  while (true) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (typeof pkg.name === 'string' && typeof pkg.version === 'string'
        && id.split(path.sep).includes('node_modules')) {
        return `npm:${pkg.name}@${pkg.version}/${path.relative(directory, id).split(path.sep).join('/')}`;
      }
    } catch { /* Ascend only for package provenance; source reads still fail closed. */ }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  fail('ERR_MODERN_VIEW_DEPENDENCY', 'Modern dependency escapes the project and is not a versioned npm package', id);
}

/** Public Rolldown owns TS lowering, static module linking, tree shaking and emission. */
async function compileUnit(group: string[], config: ModernViewConfig, blobs: Map<string, Buffer>) {
  const [{ rolldown }, parser, traverseModule] = await Promise.all([import('rolldown'), import('@babel/parser'), import('@babel/traverse')]);
  const traverse = traverseModule.default;
  const declarations = group.map(documentId => ({ documentId, aliases: Object.keys(config.documents.get(documentId)!) }));
  const unitHash = digest(canonical(group.map(id => [id, config.documents.get(id)])));
  const id = `modern:${unitHash}`;
  // Rolldown deliberately omits NUL-prefixed virtual IDs from source maps.
  // These stable IDs remain plugin-owned while retaining useful mappings.
  const virtualId = `weapp-container-modern-view:${unitHash}`;
  const aliases: string[] = [];
  const imports: string[] = [];
  const rootEntrypoints = new Map<string, string>();
  let counter = 0;
  for (const documentId of group) {
    const entries = [];
    for (const [alias, source] of Object.entries(config.documents.get(documentId)!)) {
      const file = path.resolve(config.project, source);
      let real;
      try { real = await fs.realpath(file); }
      catch (caught) { const error = errorInfo(caught); fail('ERR_MODERN_VIEW_DEPENDENCY', `Cannot read modern entry ${source}: ${error.message}`, source); }
      if (!inside(config.project, real)) fail('ERR_MODERN_VIEW_CONFIG', `Modern entry symlink escapes project: ${source}`, config.configPath);
      const rootId = `weapp-container-entry:${counter}`;
      const local = `__view${counter++}`;
      rootEntrypoints.set(rootId, real);
      imports.push(`import * as ${local} from ${JSON.stringify(rootId)};`);
      entries.push(`[${JSON.stringify(alias)}]:${local}`);
    }
    aliases.push(`[${JSON.stringify(documentId)}]:{${entries.join(',')}}`);
  }
  const entry = `${imports.join('\n')}\nexport default {${aliases.join(',')}};\n`;
  const sources = new Map([[config.configPath, { path: config.configPath, sha256: digest(config.bytes) }]]);
  const identities = new Map<string, string>();
  const realSources = new Map<string, string>();
  blobs.set(digest(config.bytes), config.bytes);
  const readSource = async (file: string) => {
    const identity = await sourceIdentity(file, config.project);
    let bytes;
    let source;
    try {
      bytes = await fs.readFile(file);
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (caught) { const error = errorInfo(caught); fail('ERR_MODERN_VIEW_DEPENDENCY', `Cannot read UTF-8 modern source: ${error.message}`, identity); }
    const hash = digest(bytes);
    const existing = sources.get(identity);
    if (existing && existing.sha256 !== hash) fail('ERR_MODERN_VIEW_DEPENDENCY', `Conflicting bytes for modern source identity ${identity}`, identity);
    sources.set(identity, { path: identity, sha256: hash });
    config.watchDependencies.set(file, hash);
    identities.set(file, identity);
    blobs.set(hash, bytes);
    return source;
  };
  const outputFile = path.join(config.project, '.weapp-container/modern-view', `${unitHash}.cjs`);
  let build;
  let pluginFailure;
  const runPlugin = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); }
    catch (caught) { const error = errorInfo(caught);
      // Native bundler diagnostics can flatten JS exceptions into messages.
      // Preserve the original location and code for the simulator overlay.
      if (error instanceof ModernViewError) pluginFailure ??= new ModernViewError(error.code, error.message, error.path, error.location);
      throw error;
    }
  };
  try {
    build = await rolldown({
      input: virtualId,
      cwd: config.project,
      platform: 'neutral',
      // View compilation has an explicit ES2022 contract and a separate type
      // check. Do not inherit AppService tsconfig references into disposable
      // source snapshots, where generated .weapp-vite configs are absent.
      tsconfig: false,
      resolve: { mainFields: ['module', 'main'], modules: [path.join(config.resolveRoot, 'node_modules'), 'node_modules'] },
      transform: { target: MODERN_VIEW_TARGET },
      treeshake: true,
      onwarn(warning) {
        if (warning.code === 'CIRCULAR_DEPENDENCY') return;
        fail('ERR_MODERN_VIEW_DEPENDENCY', warning.message, warning.id);
      },
      plugins: [{
        name: 'weapp-container:modern-view-input',
        async resolveId(source, importer, options) {
          return runPlugin(async () => {
            if (source === virtualId) return source;
            if (builtin.has(source) || /^(?:node:|https?:|data:|file:)/.test(source) || /\.wxs(?:$|[?#])/.test(source)) {
              fail('ERR_MODERN_VIEW_DEPENDENCY', `Unsupported modern View dependency: ${source}`);
            }
            const resolved = await this.resolve(rootEntrypoints.get(source) ?? source,
              (importer === undefined ? undefined : realSources.get(importer)) ?? (importer === virtualId ? undefined : importer),
              { skipSelf: true, kind: options.kind });
            if (!resolved || resolved.external) fail('ERR_MODERN_VIEW_DEPENDENCY', `Modern View dependency cannot be linked: ${source}`, importer);
            const identity = await sourceIdentity(resolved.id, config.project);
            // Stable module IDs keep emitted code and source maps independent of
            // machine paths and the source snapshot directory chosen by dev mode.
            const stableId = `weapp-container-source:${identity}`;
            realSources.set(stableId, resolved.id);
            identities.set(stableId, identity);
            return stableId;
          });
        },
        async load(moduleId) {
          return runPlugin(async () => {
            if (moduleId === virtualId) return entry;
            const file = realSources.get(moduleId);
            if (!file) fail('ERR_MODERN_VIEW_DEPENDENCY', 'Unexpected virtual dependency in modern View', moduleId);
            if (!/\.(?:[cm]?[jt]s|json)$/.test(file)) fail('ERR_MODERN_VIEW_DEPENDENCY', 'Modern View accepts only JavaScript, TypeScript and JSON dependencies', file);
            const source = await readSource(file);
            if (file.endsWith('.json')) {
              try { JSON.parse(source); } catch (caught) { const error = errorInfo(caught); fail('ERR_MODERN_VIEW_DEPENDENCY', `Invalid JSON dependency: ${error.message}`, file); }
              return { code: source, moduleType: 'json' };
            }
            validateSource(source, identities.get(file)!, parser, traverse);
            return { code: source, moduleType: /\.(?:ts|mts|cts)$/.test(file) ? 'ts' : 'js' };
          });
        },
      }],
    });
    const result = await build.generate({ format: 'cjs', exports: 'default', file: outputFile, sourcemap: 'hidden',
      sourcemapPathTransform(source) {
        if (identities.has(source)) return identities.get(source)!;
        if (source.includes('weapp-container-source:')) return source.slice(source.indexOf('weapp-container-source:') + 'weapp-container-source:'.length);
        const resolved = path.resolve(path.dirname(outputFile), source);
        return identities.get(resolved) ?? (source.includes('weapp-container-modern-view:') ? `virtual:${unitHash}` : source.replaceAll('\\', '/'));
      },
    });
    const chunks = result.output.filter(item => item.type === 'chunk');
    if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length) fail('ERR_MODERN_VIEW_DEPENDENCY', 'Modern View must link to one self-contained synchronous unit', id);
    const chunk = chunks[0];
    if (!chunk.map) fail('ERR_MODERN_VIEW_DEPENDENCY', 'Modern View compilation did not produce a source map', id);
    const executable = Buffer.from(chunk.code, 'utf8');
    const sourceMap = Buffer.from(canonical(JSON.parse(chunk.map.toString())), 'utf8');
    const executableSha256 = digest(executable);
    const sourceMapSha256 = digest(sourceMap);
    blobs.set(executableSha256, executable);
    blobs.set(sourceMapSha256, sourceMap);
    return { id, executableSha256, sourceMapSha256,
      sources: [...sources.values()].sort((a, b) => compare(a.path, b.path)), documents: declarations };
  } catch (caught) { const error = errorInfo(caught);
    if (pluginFailure) throw pluginFailure;
    if (error instanceof ModernViewError) throw error;
    // Plugin exceptions may be wrapped by the bundler; retain the structured
    // cause when available and otherwise report a stable dependency failure.
    if (error.cause instanceof ModernViewError) throw error.cause;
    fail('ERR_MODERN_VIEW_DEPENDENCY', `Cannot compile modern View: ${error.message}`, id);
  } finally { await build?.close(); }
}

export async function compileModernView(documents: ViewDocument[], config: ModernViewConfig | null | undefined, blobs: Map<string, Buffer>) {
  if (!config || config.documents.size === 0) return undefined;
  const groups = modernGroups(documents, config);
  const [parser, traverseModule] = await Promise.all([import('@babel/parser'), import('@babel/traverse')]);
  for (const document of documents) {
    if (!config.documents.has(document.documentId)) continue;
    for (const expression of document.expressions ?? []) {
      validateSource(expression.source, document.documentId, parser, traverseModule.default, expression);
    }
  }
  const units = [];
  // Each connected template graph is one module realm. Compiling aliases
  // independently would duplicate shared ESM dependency state and cycles.
  for (const group of groups) units.push(await compileUnit(group, config, blobs));
  return { compiler: MODERN_VIEW_COMPILER, version: MODERN_VIEW_VERSION, abi: MODERN_VIEW_ABI,
    target: MODERN_VIEW_TARGET, units: units.sort((a, b) => compare(a.id, b.id)) };
}
