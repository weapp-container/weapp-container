import type { BuildResult, PackOptions, Diagnostic, CapabilityOverrides, CapabilityStatus, JsonObject, Route, WxmlDocument, WxmlNode, WxmlDirectives, CssRule, CssDeclaration, ViewDocument, ViewExpression, ViewScript } from './types.ts';
import { errorInfo } from './types.ts';
export type { BuildResult, PackOptions, Diagnostic, Manifest, WxmlDocument, WxmlNode, CssRule, CapabilityOverrides } from './types.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseJavaScript } from '@babel/parser';
import { canonicalize, compareUtf8, sha256 } from './json-integrity.mjs';
import { buildRendererProfiles, RENDERING_MANIFEST_SCHEMA_VERSION } from './rendering.mjs';
import { extractWxsDependencySpecifiers } from './wxs-dependencies.ts';
import { compileWxsModule, compileWxmlExpression, WXS_COMPILER_NAME, WXS_COMPILER_VERSION, WXS_HELPER_ABI_VERSION } from './wxs-compiler.ts';
import { loadModernViewConfig, compileModernView } from './modern-view.ts';

export { canonicalize, sha256 } from './json-integrity.mjs';

/**
 * The portable manifest is deliberately kept independent of the Rust runtime.
 * This module is the reference packer used by CI and by the Rust loader's
 * golden tests. Do not use locale dependent sorting or JSON.stringify directly
 * when adding fields to the manifest.
 */

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_PROTOCOL_VERSION = '1.0';

const STATUS = new Set(['full', 'partial', 'unsupported']);
// Release matrix uses explicit desktop targets; `desktop` remains a CLI/surface
// alias elsewhere but is not a conformance host.
const HOSTS = ['web', 'macos', 'windows', 'linux', 'android', 'ios', 'harmony'];
const ENGINES = ['quickjs', 'v8'];
const PRESENTER_REQUIRED_CAPABILITIES = new Set([
  'wx.setTabBarBadge', 'wx.removeTabBarBadge', 'wx.showTabBarRedDot',
  'wx.hideTabBarRedDot', 'wx.setTabBarStyle',
]);

/**
 * Core API inventory. The manifest stores the compact status map while this
 * richer matrix is emitted as a separately versioned file for tooling and
 * wx.canIUse. Values are intentionally conservative until a host conformance
 * test promotes an API from partial to full.
 */
export const DEFAULT_CAPABILITIES: Readonly<Record<string, CapabilityStatus>> = Object.freeze({
  'wx.canIUse': 'full',
  'wx.getSystemInfoSync': 'partial',
  'wx.getSystemInfo': 'partial',
  'wx.getAppBaseInfo': 'partial',
  'wx.getDeviceInfo': 'partial',
  'wx.getWindowInfo': 'partial',
  'wx.getSystemSetting': 'partial',
  'wx.getMenuButtonBoundingClientRect': 'partial',
  // Account metadata is a complete portable provider snapshot. Native host
  // identity injection remains tracked in the host coverage matrix below.
  'wx.getAccountInfoSync': 'full',
  'wx.getExtConfigSync': 'partial',
  'wx.getExtConfig': 'partial',
  'wx.getRandomValues': 'full',
  'wx.getLaunchOptionsSync': 'partial',
  'wx.getEnterOptionsSync': 'partial',
  'wx.getBatteryInfo': 'partial',
  // The synchronous battery snapshot is exposed by the same typed provider
  // boundary. Hosts may lower it when a battery service is unavailable.
  'wx.getBatteryInfoSync': 'partial',
  'wx.getScreenBrightness': 'partial',
  'wx.setScreenBrightness': 'partial',
  'wx.authorize': 'partial',
  'wx.openSetting': 'partial',
  'wx.getSetting': 'partial',
  'wx.getAppAuthorizeSetting': 'partial',
  'wx.onAppShow': 'partial',
  'wx.onAppHide': 'partial',
  'wx.onError': 'partial',
  'wx.offError': 'partial',
  'wx.onPageNotFound': 'partial',
  'wx.onNetworkStatusChange': 'partial',
  'getCurrentPages': 'partial',
  // Session-owned component references; selector/export/host parity stays partial.
  'Page.selectComponent': 'partial',
  'Page.selectAllComponents': 'partial',
  'Component.selectComponent': 'partial',
  'Component.selectAllComponents': 'partial',
  'Component.selectOwnerComponent': 'partial',
  'Component.triggerEvent': 'partial',
  // Composed-tree relations and behavior identity have limited oracle coverage.
  'Component.relations': 'partial',
  'Component.getRelationNodes': 'partial',
  'Component.hasBehavior': 'partial',
  // The portable runtime provides a session-scoped memory store. Hosts may
  // lower this negotiated level when they do not expose persistence.
  'wx.setStorage': 'partial',
  'wx.setStorageSync': 'partial',
  'wx.getStorage': 'partial',
  'wx.getStorageSync': 'partial',
  'wx.getStorageInfo': 'partial',
  'wx.getStorageInfoSync': 'partial',
  'wx.removeStorage': 'partial',
  'wx.removeStorageSync': 'partial',
  'wx.clearStorage': 'partial',
  'wx.clearStorageSync': 'partial',
  // Timers are driven by the host event loop through Session::poll_timers.
  'wx.timer': 'partial',
  'wx.request': 'partial',
  'wx.uploadFile': 'partial',
  'wx.downloadFile': 'partial',
  // SocketTask uses a deterministic provider-backed state machine in the
  // portable runtime. Native hosts replace transport and inbound events;
  // keep the negotiated baseline partial until host conformance evidence.
  'wx.connectSocket': 'partial',
  'wx.getFileSystemManager': 'partial',
  // Legacy global file APIs remain available through the same provider
  // boundary as getFileSystemManager. Keep them explicit in new manifests;
  // the runtime also aliases them for older manifests.
  'wx.saveFile': 'partial',
  'wx.removeSavedFile': 'partial',
  'wx.getFileInfo': 'partial',
  'wx.getSavedFileInfo': 'partial',
  'wx.getSavedFileList': 'partial',
  // Selector geometry is available against the committed portable render
  // tree.  Hosts still need hit-test/layout conformance before promotion to
  // full, so the portable baseline remains partial.
  'wx.createSelectorQuery': 'partial',
  // Observer registration is implemented through the provider boundary. The
  // portable baseline reports partial until every host supplies real viewport
  // and layout conformance evidence.
  'wx.createIntersectionObserver': 'partial',
  'wx.onBeforeAppRoute': 'partial',
  'wx.offBeforeAppRoute': 'partial',
  'wx.onAppRoute': 'partial',
  'wx.offAppRoute': 'partial',
  'wx.rewriteRoute': 'partial',
  'wx.createMediaQueryObserver': 'partial',
  'wx.nextTick': 'partial',
  'wx.setNavigationBarTitle': 'partial',
  // Admit the runtime contract in default packs. This does not attach a host
  // presenter: every default SDK host still negotiates these to unsupported
  // until a real system tab-bar consumer explicitly opts in.
  'wx.setTabBarBadge': 'partial',
  'wx.removeTabBarBadge': 'partial',
  'wx.showTabBarRedDot': 'partial',
  'wx.hideTabBarRedDot': 'partial',
  'wx.setTabBarStyle': 'partial',
  'wx.navigateTo': 'partial',
  'wx.redirectTo': 'partial',
  'wx.reLaunch': 'partial',
  'wx.switchTab': 'partial',
  'wx.navigateBack': 'partial',
  'wx.preloadPage': 'partial',
  // Cross-mini-program navigation is provider-backed. The sandbox validates
  // the target and records an accepted handoff; native hosts may replace that
  // branch with their platform navigation surface.
  'wx.redirectToMiniProgram': 'partial',
  'wx.createCanvasContext': 'partial',
  'wx.canvas.draw': 'partial',
  'wx.createAnimation': 'partial',
  // Sandbox and native hosts share an isolated CanvasFrame surface contract.
  // Keep the status partial until GPU resource lifetime evidence is complete.
  'wx.createOffscreenCanvas': 'partial',
  'wx.createCameraContext': 'partial',
  'wx.cameraContext': 'partial',
  'wx.createVideoContext': 'partial',
  'wx.createAudioContext': 'partial',
  'wx.chooseImage': 'partial',
  'wx.chooseMedia': 'partial',
  'wx.getLocation': 'partial',
  'wx.startLocationUpdate': 'partial',
  'wx.stopLocationUpdate': 'partial',
  'wx.scanCode': 'partial',
  'wx.login': 'partial',
  'wx.checkSession': 'partial',
  'wx.getUserProfile': 'partial',
  'wx.requestPayment': 'partial',
  'wx.shareAppMessage': 'partial',
  'wx.shareTimeline': 'partial',
  'wx.vibrateShort': 'partial',
  'wx.vibrateLong': 'partial',
  'wx.setClipboardData': 'partial',
  'wx.getClipboardData': 'partial',
  'wx.setKeepScreenOn': 'partial',
  'wx.getNetworkType': 'partial',
  // Host-owned transient UI APIs. The sandbox records state and returns the
  // documented result shapes; native hosts replace the provider branch with
  // their overlay/dialog implementation.
  'wx.showToast': 'partial',
  'wx.hideToast': 'partial',
  'wx.showLoading': 'partial',
  'wx.hideLoading': 'partial',
  'wx.showModal': 'partial',
  'wx.showActionSheet': 'partial',
  'wx.pageScrollTo': 'partial',
  'wx.setNavigationBarColor': 'partial',
});

const DEFAULT_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  'wx.requestPayment': 'payments',
  'wx.getLocation': 'location',
  'wx.startLocationUpdate': 'location',
  'wx.chooseImage': 'photos',
  'wx.chooseMedia': 'photos/camera',
  'wx.createCameraContext': 'photos/camera',
  'wx.cameraContext': 'photos/camera',
  'wx.scanCode': 'camera',
  'wx.login': 'account',
  'wx.getUserProfile': 'profile',
  'wx.authorize': 'user-granted',
});

// Keep the aggregate status in DEFAULT_CAPABILITIES separate from evidence
// for native hosts. The sandbox and both engine facades implement the account
// snapshot end to end, while seven-host identity injection is still awaiting
// host evidence and therefore remains partial in the generated matrix.
const DEFAULT_COVERAGE_OVERRIDES: Readonly<Record<string, { hosts?: Record<string, string>; engines?: Record<string, string> }>> = Object.freeze({
  'wx.getAccountInfoSync': Object.freeze({
    hosts: Object.freeze(Object.fromEntries(HOSTS.map((host) => [host, 'partial']))),
    engines: Object.freeze({ quickjs: 'full', v8: 'full' }),
  }),
});

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.html': 'text/html',
});

function normalizeRelative(value: string) {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  const parts = normalized.split('/');
  if (parts.includes('..') || normalized.startsWith('/')) {
    throw new Error(`Path escapes the package root: ${value}`);
  }
  return parts.filter(Boolean).join('/');
}

function scopeFor(file: string) {
  const normalized = file.toLowerCase();
  if (normalized === 'app.js' || normalized === 'app.json' || normalized === 'app.wxss') return 'app';
  if (normalized.startsWith('components/') || normalized.includes('/components/')) return 'component';
  return 'page';
}

function formatFor(file: string, source: string) {
  const ext = path.posix.extname(file).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.mjs' || file.toLowerCase().endsWith('.esm.js')) return 'esm';
  if (ext === '.js') {
    const ast = parseJavaScript(source, {
      sourceType: 'unambiguous', allowReturnOutsideFunction: true, allowNewTargetOutsideFunction: true,
    });
    if (ast.program.body.some(node => node.type === 'ImportDeclaration'
      || node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'
      || node.type === 'ExportAllDeclaration')) return 'esm';
  }
  return 'commonjs';
}

const MODULE_SOURCE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.json']);

function isJsIdentifierStart(byte: string) {
  return byte === '_' || byte === '$' || /[A-Za-z]/.test(byte);
}

function isJsIdentifierPart(byte: string) {
  return isJsIdentifierStart(byte) || /[0-9]/.test(byte);
}

/**
 * Tokenize only the pieces needed for static module extraction. This is
 * intentionally a small lexical pass instead of a JavaScript parser: it
 * ignores comments, quoted strings and template literals while retaining
 * identifier/punctuation boundaries so text such as `// require('x')` or
 * `const value = "import('x')"` cannot create a dependency edge.
 */
function scanModuleTokens(source: string) {
  const tokens: { kind: string; value: string; start: number; end: number; lineBreakBefore: boolean }[] = [];
  let cursor = 0;
  let lineBreakBefore = false;
  const push = (kind: string, value: string, start: number, end: number) => {
    tokens.push({ kind, value, start, end, lineBreakBefore });
    lineBreakBefore = false;
  };
  while (cursor < source.length) {
    const byte = source[cursor];
    if (/\s/.test(byte)) {
      lineBreakBefore ||= byte === '\n' || byte === '\r';
      cursor += 1;
      continue;
    }
    if (source.startsWith('//', cursor)) {
      const end = source.indexOf('\n', cursor + 2);
      lineBreakBefore = true;
      cursor = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2);
      const comment = end < 0 ? source.slice(cursor + 2) : source.slice(cursor + 2, end);
      lineBreakBefore ||= /[\r\n]/.test(comment);
      cursor = end < 0 ? source.length : end + 2;
      continue;
    }
    if (byte === '"' || byte === "'") {
      const quote = byte;
      const start = cursor;
      let value = '';
      cursor += 1;
      while (cursor < source.length) {
        const next = source[cursor];
        if (next === quote) {
          cursor += 1;
          break;
        }
        if (next === '\\' && cursor + 1 < source.length) {
          const escaped = source[cursor + 1];
          value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' })[escaped] ?? escaped;
          cursor += 2;
        } else {
          value += next;
          cursor += 1;
        }
      }
      push('string', value, start, cursor);
      continue;
    }
    // Template literals may contain `${require('...')}` expressions, but
    // those are runtime-evaluated and are deliberately outside this static
    // dependency graph. Skip the complete literal as one token.
    if (byte === '`') {
      const start = cursor;
      cursor += 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        const closed = source[cursor] === '`';
        lineBreakBefore ||= source[cursor] === '\n' || source[cursor] === '\r';
        cursor += 1;
        if (closed) break;
      }
      push('template', '', start, cursor);
      continue;
    }
    if (isJsIdentifierStart(byte)) {
      const start = cursor;
      cursor += 1;
      while (cursor < source.length && isJsIdentifierPart(source[cursor])) cursor += 1;
      push('identifier', source.slice(start, cursor), start, cursor);
      continue;
    }
    const start = cursor;
    cursor += 1;
    push('punctuation', byte, start, cursor);
  }
  return tokens;
}

/** Return deterministic static import/require specifiers from JS source. */
export function extractStaticModuleSpecifiers(source: string) {
  const tokens = scanModuleTokens(source);
  const specifiers = new Set<string>();
  const addFrom = (index: number) => {
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token.value === ';') break;
      if (token.kind === 'identifier' && token.value === 'from' && tokens[cursor + 1]?.kind === 'string') {
        specifiers.add(tokens[cursor + 1].value);
        return;
      }
    }
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'identifier') continue;
    const next = tokens[index + 1];
    if (token.value === 'require' && next?.value === '(' && tokens[index + 2]?.kind === 'string' && tokens[index + 3]?.value === ')') {
      specifiers.add(tokens[index + 2].value);
    } else if (token.value === 'import') {
      if (next?.kind === 'string') specifiers.add(next.value);
      else if (next?.value !== '(' && next?.value !== '.') addFrom(index);
    } else if (token.value === 'export') {
      addFrom(index);
    }
  }
  return [...specifiers].sort(compareUtf8);
}

function moduleCandidates(base: string) {
  const normalized = normalizeRelative(base);
  const extension = path.posix.extname(normalized);
  if (extension) return [normalized];
  return [
    normalized,
    ...MODULE_SOURCE_EXTENSIONS.map((suffix) => `${normalized}${suffix}`),
    ...MODULE_SOURCE_EXTENSIONS.map((suffix) => `${normalized}/index${suffix}`),
  ];
}

/** Resolve a static specifier against files emitted into the package root. */
export function resolveModuleDependency(fromFile: string, specifier: string, files: Iterable<string>) {
  const fileSet = files instanceof Set ? files : new Set(files);
  const candidates: string[] = [];
  const pushCandidates = (base: string) => {
    try {
      candidates.push(...moduleCandidates(base));
    } catch {
      // Invalid/escaping paths are reported by the caller as undeclared.
    }
  };
  if (specifier.startsWith('.')) {
    pushCandidates(path.posix.join(path.posix.dirname(fromFile), specifier));
  } else if (specifier.startsWith('/')) {
    pushCandidates(specifier.slice(1));
  } else {
    // Built output may preserve npm dependencies under one of these roots.
    // Exact paths are checked first so a package can intentionally emit a
    // top-level module without requiring a node_modules directory.
    pushCandidates(specifier);
    pushCandidates(path.posix.join('miniprogram_npm', specifier));
    pushCandidates(path.posix.join('node_modules', specifier));
  }
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

const WXS_RESERVED_NAMES = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let',
  'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'await',
]);

function validWxsModuleName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
    && !WXS_RESERVED_NAMES.has(value);
}

function validWxsSourcePath(value: string, suffix = '.wxs') {
  return value.endsWith(suffix) && !/[\\#?:\x00-\x1f\x7f-\x9f]/.test(value)
    && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
}

function resolveWxsSource(fromFile: string, request: unknown, files: Set<string>, isRequire = false) {
  if (typeof request !== 'string' || !request.endsWith('.wxs')
    || /[\\#?:\x00-\x1f\x7f-\x9f]/.test(request)
    || (isRequire && ((!request.startsWith('./') && !request.startsWith('../'))
      || request.split('/').some(part => !part)))) return null;
  const resolved = request.startsWith('/')
    ? path.posix.normalize(request.slice(1))
    : path.posix.join(path.posix.dirname(fromFile), request);
  return validWxsSourcePath(resolved) && files.has(resolved) ? resolved : null;
}

/** Parse every lexical require reference without executing or rewriting WXS. */
function wxsDependencies(source: string, owner: string, files: Set<string>, diagnostics: Diagnostic[]) {
  const graph = extractWxsDependencySpecifiers(source);
  for (const issue of graph.diagnostics) {
    diagnostics.push(diagnostic('error', issue.code, issue.message, owner, issue.location));
  }
  const dependencies = new Set<string>();
  for (const specifier of graph.specifiers) {
    const resolved = resolveWxsSource(owner, specifier, files, true);
    if (!resolved) {
      diagnostics.push(diagnostic('error', 'ERR_INVALID_WXS_DEPENDENCY', `WXS require target must be a declared package-relative .wxs file: ${specifier}`, owner, { specifier }));
      continue;
    }
    dependencies.add(`wxs:${resolved}`);
  }
  return [...dependencies].sort(compareUtf8);
}

function collectWxsBindings(ast: WxmlDocument, owner: string, files: Set<string>, viewScripts: ViewScript[], blobs: Map<string, Buffer>, diagnostics: Diagnostic[]) {
  const bindings = new Map<string, string>();
  const visit = (nodes: WxmlNode[]) => {
    for (const node of nodes) {
      if (node.kind !== 'element') continue;
      if (node.tag !== 'wxs') { visit(node.children); continue; }
      const alias = node.attrs.module;
      if (!validWxsModuleName(alias) || bindings.has(alias)) {
        diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', `Invalid or duplicate WXS module alias: ${String(alias)}`, owner));
        continue;
      }
      if (!validWxsSourcePath(owner, '.wxml')) {
        diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', 'WXS declarations require a canonical WXML source path', owner));
        continue;
      }
      if (node.children.some(child => child.kind !== 'text')) {
        diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', 'Inline WXS source must be raw text', owner));
        continue;
      }
      const source = node.children.map(child => child.kind === 'text' ? child.value : '').join('');
      if (Object.hasOwn(node.attrs, 'src')) {
        const resolved = resolveWxsSource(owner, node.attrs.src, files);
        if (!resolved || source.trim()) {
          diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', `Invalid WXS source or mixed inline/external declaration: ${node.attrs.src}`, owner));
          continue;
        }
        bindings.set(alias, `wxs:${resolved}`);
      } else {
        const bytes = Buffer.from(source, 'utf8');
        const hash = sha256(bytes);
        blobs.set(hash, bytes);
        const id = `wxs:${owner}#${alias}`;
        viewScripts.push({ id, sha256: hash, dependencies: wxsDependencies(source, owner, files, diagnostics) });
        bindings.set(alias, id);
      }
    }
  };
  visit(ast.nodes);
  return Object.fromEntries([...bindings].sort(([left], [right]) => compareUtf8(left, right)));
}

function wxmlBindingsWithoutWxs(ast: WxmlDocument) {
  const bindings = new Set<string>();
  const visit = (nodes: WxmlNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'element' && node.tag === 'wxs') continue;
      for (const binding of node.bindings ?? []) bindings.add(binding);
      if (node.kind === 'element') visit(node.children);
    }
  };
  visit(ast.nodes);
  return [...bindings].sort(compareUtf8);
}

function mimeType(file: string) {
  const ext = path.posix.extname(file).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

function diagnostic(severity: Diagnostic['severity'], code: string, message: string, file?: string, details?: unknown): Diagnostic {
  return { severity, code, message, ...(file ? { path: file } : {}), ...(details ? { details } : {}) };
}

async function walk(root: string, current = ''): Promise<string[]> {
  const absolute = path.join(root, current);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => compareUtf8(a.name, b.name))) {
    // Build outputs may contain a previous pack directory. It must never be
    // folded back into the next manifest.
    if (entry.name === '.git' || entry.name === 'blobs' || entry.name === 'manifest.json' ||
      entry.name === 'capability-matrix.json' || entry.name === 'diagnostics.json') continue;
    const relative = normalizeRelative(path.posix.join(current.replaceAll('\\', '/'), entry.name));
    if (entry.isDirectory()) result.push(...await walk(root, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort(compareUtf8);
}

async function readJson(file: string, relative: string, diagnostics: Diagnostic[]): Promise<{ value: JsonObject | null; source: string }> {
  try {
    const source = await fs.readFile(file, 'utf8');
    // JSON.parse does not accept a UTF-8 BOM, while DevTools accepts one.
    return { value: JSON.parse(source.replace(/^\uFEFF/, '')), source };
  } catch (caught) { const error = errorInfo(caught);
    diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', `Invalid JSON: ${error.message}`, relative));
    return { value: null, source: '' };
  }
}

function validateAppJson(appJson: JsonObject | null, diagnostics: Diagnostic[]) {
  if (!appJson || typeof appJson !== 'object' || Array.isArray(appJson)) {
    diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', 'app.json must contain a JSON object', 'app.json'));
    return { pages: [], subpackages: [] };
  }
  const pages = Array.isArray(appJson.pages) ? appJson.pages : [];
  if (!Array.isArray(appJson.pages)) {
    diagnostics.push(diagnostic('warning', 'APP_PAGES_MISSING', 'app.json.pages is missing; no top-level routes were emitted', 'app.json'));
  }
  const validPages = pages.filter((page, index) => {
    if (typeof page !== 'string' || !page || page.startsWith('/') || page.includes('..')) {
      diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', `pages[${index}] must be a relative route string`, 'app.json'));
      return false;
    }
    return true;
  });
  const rawSubpackages = appJson.subpackages ?? appJson.subPackages ?? [];
  if (!Array.isArray(rawSubpackages)) {
    diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', 'subpackages must be an array', 'app.json'));
  }
  const subpackages = Array.isArray(rawSubpackages) ? rawSubpackages.filter((subpackage, index) => {
    if (!subpackage || typeof subpackage !== 'object' || typeof subpackage.root !== 'string' || !Array.isArray(subpackage.pages)) {
      diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', `subpackages[${index}] needs root and pages[]`, 'app.json'));
      return false;
    }
    return true;
  }) : [];
  return { pages: validPages, subpackages };
}

function tabPages(appJson: JsonObject | null) {
  const list = appJson?.tabBar?.list;
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((entry) => entry && typeof entry.pagePath === 'string').map((entry) => entry.pagePath));
}

function createRoute(id: string, route: string, kind: string, inputRoot: string, _diagnostics: Diagnostic[], _configPrefix = '') {
  const entryModule = `${route}.js`;
  const configPath = `${route}.json`;
  const absoluteConfig = path.join(inputRoot, configPath);
  const result: Route = { id, path: route, kind, entryModule };
  return fs.stat(absoluteConfig).then((stat) => {
    if (stat.isFile()) result.config = configPath;
    return result;
  }).catch(() => result);
}

async function routeRecords(appJson: JsonObject | null, inputRoot: string, diagnostics: Diagnostic[]) {
  const { pages, subpackages } = validateAppJson(appJson, diagnostics);
  const tabs = tabPages(appJson);
  const routes: Route[] = [];
  const seen = new Set();
  const add = async (route: string, kind: string) => {
    const normalized = normalizeRelative(route);
    if (seen.has(normalized)) {
      diagnostics.push(diagnostic('warning', 'DUPLICATE_ROUTE', `Route emitted more than once: ${normalized}`, 'app.json'));
      return;
    }
    seen.add(normalized);
    const record = await createRoute(`route:${normalized}`, normalized, kind, inputRoot, diagnostics);
    routes.push(record);
    try {
      const entry = await fs.stat(path.join(inputRoot, record.entryModule));
      if (!entry.isFile()) throw new Error('not a file');
    } catch {
      diagnostics.push(diagnostic('warning', 'ROUTE_ENTRY_MISSING', `Route entry module is missing: ${record.entryModule}`, 'app.json'));
    }
  };
  for (const page of pages) await add(page, tabs.has(page) ? 'tab' : 'page');
  for (const subpackage of subpackages) {
    let root;
    try {
      root = normalizeRelative(subpackage.root);
    } catch {
      diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', `Subpackage root must be a relative path: ${subpackage.root}`, 'app.json'));
      continue;
    }
    for (const page of subpackage.pages) {
      if (typeof page !== 'string' || !page || page.startsWith('/') || page.includes('..')) {
        diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', `Subpackage page must be a relative route string: ${page}`, 'app.json'));
        continue;
      }
      await add(path.posix.join(root, page), 'subpage');
    }
  }
  return routes;
}

function pointer(hash: string) {
  return `sha256:${hash}`;
}

function componentTarget(owner: string, target: string) {
  if (typeof target !== 'string' || target.length === 0) return target;
  // Root-relative component paths are common in app.json; preserve plugin and
  // npm component specifiers because they are resolved by the runtime host.
  if (target.startsWith('plugin://') || target.startsWith('npm:')) return target;
  const relative = target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(owner), target);
  return normalizeRelative(relative);
}

export const WXML_IR_VERSION = 1;
export const WXSS_IR_VERSION = 2;

function markupWhitespace(value: string) {
  return value === ' ' || value === '\n' || value === '\r' || value === '\t';
}

function interpolationExpressions(value: string, metadataOnly = false) {
  const bindings = [];
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf('{{', cursor);
    if (start < 0) break;
    let quote = '', escaped = false, braces = 0, end = -1;
    for (let index = start + 2; index < value.length; index++) {
      const character = value[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
      } else if (character === "'" || character === '"' || character === '`') quote = character;
      else if (character === '{') braces++;
      else if (character === '}' && braces) braces--;
      else if (character === '}' && value[index + 1] === '}') { end = index; break; }
    }
    if (end < 0) {
      if (metadataOnly) break;
      throw new Error('Unterminated WXML expression');
    }
    const expression = value.slice(start + 2, end).trim();
    if (!expression && !metadataOnly) throw new Error('Empty WXML expression');
    if (expression) bindings.push(expression);
    cursor = end + 2;
  }
  return bindings;
}

function bindingsIn(value: string) {
  return [...new Set(interpolationExpressions(value, true))].sort(compareUtf8);
}

function viewExpressions(ast: WxmlDocument) {
  const result = new Map<string, ViewExpression>();
  const add = (source: string | undefined, shorthand = false) => {
    if (source) result.set(JSON.stringify([source, shorthand]), { source, shorthand });
  };
  const interpolate = (value: string) => interpolationExpressions(value).forEach(source => add(source));
  const visit = (nodes: WxmlNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'text') interpolate(node.value);
      if (node.kind !== 'element' || node.tag === 'wxs') continue;
      for (const name of (['ifExpr', 'elifExpr', 'forExpr'] as const)) add(node.directives?.[name]);
      const key = node.directives?.forKey;
      // wx:key names an item property, not a JavaScript expression. Keywords
      // and punctuation in a bare name must stay lossless literal metadata.
      // Keep the existing dotted loop-scope expression extension aligned with
      // View validation/evaluation; it remains separate from official parity.
      if (key && key !== '*this' && key.includes('.')) add(key);
      for (const [name, value] of Object.entries(node.attrs)) {
        if (name.startsWith('wx:') || Object.hasOwn(node.boundValues ?? {}, name)) continue;
        if (node.tag === 'template' && name === 'data') {
          const trimmed = value.trim();
          add(trimmed.startsWith('{{') && trimmed.endsWith('}}') ? trimmed.slice(2, -2).trim() : trimmed, true);
        } else interpolate(value);
      }
      visit(node.children);
    }
  };
  visit(ast.nodes);
  return [...result.values()].sort((a, b) => compareUtf8(a.source, b.source) || Number(a.shorthand) - Number(b.shorthand));
}

// Keep this wire view aligned with WxmlDirectives::from_attrs in container-ir.
// Attributes remain lossless; runtime control flow reads the normalized view.
function wxmlDirectives(attrs: Record<string, string>): WxmlDirectives {
  const directives: WxmlDirectives = {};
  const trimmed = (value: string) => value.trim() || undefined;
  const unwrapped = (value: string) => {
    const source = value.trim();
    return trimmed(source.startsWith('{{') && source.endsWith('}}') ? source.slice(2, -2) : source);
  };
  const expressions: Record<string, 'ifExpr' | 'elifExpr' | 'forExpr' | 'forKey'> = { 'wx:if': 'ifExpr', 'wx:elif': 'elifExpr', 'wx:for': 'forExpr', 'wx:key': 'forKey' };
  const names: Record<string, 'forItem' | 'forIndex'> = { 'wx:for-item': 'forItem', 'wx:for-index': 'forIndex' };
  for (const [name, value] of Object.entries(attrs)) {
    const expression = Object.hasOwn(expressions, name);
    const field = expression ? expressions[name] : Object.hasOwn(names, name) ? names[name] : undefined;
    if (field) {
      const normalized = expression ? unwrapped(value) : trimmed(value);
      if (normalized !== undefined) directives[field] = normalized;
    } else if (name === 'wx:else') directives.elseBranch = true;
    else if (['bind', 'catch', 'capture-bind', 'capture-catch'].some(prefix => name.startsWith(prefix))) {
      (directives.events ??= {})[name] = value;
    }
  }
  return directives;
}

class WxmlParser {
  source: string;
  pos: number;
  constructor(source: string) {
    this.source = source;
    this.pos = 0;
  }

  parseNodes(closing: string | null = null): WxmlNode[] {
    const nodes: WxmlNode[] = [];
    while (this.pos < this.source.length) {
      if (this.source.startsWith('</', this.pos)) {
        const close = this.parseCloseTag();
        if (closing === null) throw new Error(`unexpected closing tag </${close.name}>`);
        if (close.name !== closing) throw new Error(`mismatched closing tag: expected </${closing}>, got </${close.name}>`);
        this.pos = close.end;
        return nodes;
      }
      if (this.source[this.pos] !== '<') {
        const start = this.pos;
        const next = this.source.indexOf('<', start);
        this.pos = next < 0 ? this.source.length : next;
        const value = this.source.slice(start, this.pos);
        if (value) nodes.push({ kind: 'text', value, bindings: bindingsIn(value) });
        continue;
      }
      if (this.source.startsWith('<!--', this.pos)) {
        const start = this.pos + 4;
        const end = this.source.indexOf('-->', start);
        if (end < 0) throw new Error('unterminated WXML comment');
        nodes.push({ kind: 'comment', value: this.source.slice(start, end) });
        this.pos = end + 3;
        continue;
      }
      const open = this.parseOpenTag();
      this.pos = open.end;
      const values = Object.values(open.attrs).flatMap((value) => bindingsIn(value));
      const bindings = [...new Set(values)].sort(compareUtf8);
      const children = open.selfClosing || isVoidWxmlTag(open.tag) ? []
        : open.tag === 'wxs' ? this.parseRawText(open.tag) : this.parseNodes(open.tag);
      const directives = wxmlDirectives(open.attrs);
      nodes.push({ kind: 'element', tag: open.tag, attrs: open.attrs, bindings,
        ...(Object.keys(directives).length ? { directives } : {}), children });
    }
    if (closing !== null) throw new Error(`unexpected end of input while parsing WXML element </${closing}>`);
    return nodes;
  }

  parseRawText(closing: string): WxmlNode[] {
    const start = this.pos;
    let search = start;
    for (;;) {
      const end = this.source.indexOf('</', search);
      if (end < 0) throw new Error(`unexpected end of input while parsing WXML raw text element </${closing}>`);
      let cursor = end + 2;
      while (cursor < this.source.length && markupWhitespace(this.source[cursor])) cursor += 1;
      if (this.source.startsWith(closing, cursor)) {
        cursor += closing.length;
        while (cursor < this.source.length && markupWhitespace(this.source[cursor])) cursor += 1;
        if (this.source[cursor] === '>') {
          // Preserve script bytes; tags and moustache inside WXS are not WXML.
          const value = this.source.slice(start, end);
          this.pos = cursor + 1;
          return value ? [{ kind: 'text', value, bindings: [] }] : [];
        }
      }
      search = end + 2;
    }
  }

  parseOpenTag() {
    const source = this.source;
    let cursor = this.pos + 1;
    while (cursor < source.length && markupWhitespace(source[cursor])) cursor += 1;
    const nameStart = cursor;
    while (cursor < source.length && !markupWhitespace(source[cursor]) && !['/', '>'].includes(source[cursor])) cursor += 1;
    if (cursor === nameStart) throw new Error(`missing WXML tag name at ${this.pos}`);
    const tag = source.slice(nameStart, cursor);
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    while (cursor < source.length) {
      while (cursor < source.length && markupWhitespace(source[cursor])) cursor += 1;
      if (cursor >= source.length) throw new Error('unterminated WXML opening tag');
      if (source[cursor] === '>') {
        cursor += 1;
        break;
      }
      if (source.startsWith('/>', cursor)) {
        cursor += 2;
        selfClosing = true;
        break;
      }
      const attrStart = cursor;
      while (cursor < source.length && !markupWhitespace(source[cursor]) && !['=', '/', '>'].includes(source[cursor])) cursor += 1;
      if (cursor === attrStart) throw new Error(`invalid WXML attribute at ${cursor}`);
      const name = source.slice(attrStart, cursor);
      while (cursor < source.length && markupWhitespace(source[cursor])) cursor += 1;
      let value = '';
      if (source[cursor] === '=') {
        cursor += 1;
        while (cursor < source.length && markupWhitespace(source[cursor])) cursor += 1;
        if (cursor >= source.length) throw new Error('unterminated WXML attribute value');
        const quote = source[cursor];
        if (quote === '"' || quote === "'") {
          cursor += 1;
          const valueStart = cursor;
          while (cursor < source.length && source[cursor] !== quote) cursor += 1;
          if (cursor >= source.length) throw new Error('unterminated WXML quoted attribute');
          value = source.slice(valueStart, cursor);
          cursor += 1;
        } else {
          const valueStart = cursor;
          while (cursor < source.length && !markupWhitespace(source[cursor]) && source[cursor] !== '>') cursor += 1;
          value = source.slice(valueStart, cursor);
        }
      }
      if (Object.hasOwn(attrs, name)) throw new Error(`duplicate WXML attribute: ${name}`);
      attrs[name] = value;
    }
    if (cursor > source.length || source[cursor - 1] !== '>') throw new Error('unterminated WXML opening tag');
    return { tag, attrs, selfClosing, end: cursor };
  }

  parseCloseTag() {
    const source = this.source;
    let cursor = this.pos + 2;
    while (cursor < source.length && markupWhitespace(source[cursor])) cursor += 1;
    const start = cursor;
    while (cursor < source.length && source[cursor] !== '>' && !markupWhitespace(source[cursor])) cursor += 1;
    if (cursor === start) throw new Error('missing WXML closing tag name');
    const name = source.slice(start, cursor);
    while (cursor < source.length && source[cursor] !== '>') cursor += 1;
    if (cursor >= source.length) throw new Error('unterminated WXML closing tag');
    return { name, end: cursor + 1 };
  }
}

function isVoidWxmlTag(tag: string) {
  // Keep this set aligned with container-ir's is_void_wxml_tag. A button is
  // a container: its label, nested elements, bindings and events must survive.
  return new Set(['input', 'image', 'icon', 'progress', 'checkbox', 'radio', 'switch', 'slider', 'camera', 'live-player', 'live-pusher']).has(tag);
}

/** Parse WXML into the versioned blob representation used by container-ir. */
export function parseWxml(source: string): WxmlDocument {
  const parser = new WxmlParser(source);
  return { version: WXML_IR_VERSION, nodes: parser.parseNodes() };
}

function stripCssComments(source: string) {
  let result = '';
  let quote = null;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const byte = source[cursor];
    if (quote) {
      result += byte;
      if (byte === '\\' && cursor + 1 < source.length) result += source[++cursor];
      else if (byte === quote) quote = null;
      continue;
    }
    if (byte === '"' || byte === "'") {
      quote = byte;
      result += byte;
    } else if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2);
      if (end < 0) throw new Error('unterminated WXSS comment');
      result += ' ';
      cursor = end + 1;
    } else {
      result += byte;
    }
  }
  return result;
}

function findTopLevel(source: string, start: number, delimiters: string[]) {
  let quote = null;
  let parens = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const byte = source[cursor];
    if (quote) {
      if (byte === '\\') cursor += 1;
      else if (byte === quote) quote = null;
    } else if (byte === '"' || byte === "'") quote = byte;
    else if (byte === '(') parens += 1;
    else if (byte === ')') parens = Math.max(0, parens - 1);
    else if (parens === 0 && delimiters.includes(byte)) return { byte, index: cursor };
  }
  return null;
}

function findMatchingBrace(source: string, start: number) {
  let depth = 1;
  let quote = null;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const byte = source[cursor];
    if (quote) {
      if (byte === '\\') cursor += 1;
      else if (byte === quote) quote = null;
    } else if (byte === '"' || byte === "'") quote = byte;
    else if (byte === '{') depth += 1;
    else if (byte === '}' && --depth === 0) return cursor;
  }
  throw new Error('unterminated WXSS block');
}

function splitSelectors(prelude: string) {
  const selectors = [];
  let start = 0;
  let quote = null;
  let parens = 0;
  for (let cursor = 0; cursor < prelude.length; cursor += 1) {
    const byte = prelude[cursor];
    if (quote) {
      if (byte === quote) quote = null;
    } else if (byte === '"' || byte === "'") quote = byte;
    else if (byte === '(') parens += 1;
    else if (byte === ')') parens = Math.max(0, parens - 1);
    else if (byte === ',' && parens === 0) {
      const selector = prelude.slice(start, cursor).trim();
      if (selector) selectors.push(selector);
      start = cursor + 1;
    }
  }
  const selector = prelude.slice(start).trim();
  if (selector) selectors.push(selector);
  return selectors;
}

function parseDeclarations(source: string) {
  const declarations: CssDeclaration[] = [];
  let start = 0;
  let quote = null;
  let parens = 0;
  const push = (chunk: string) => {
    const value = chunk.trim();
    if (!value) return;
    const colon = value.indexOf(':');
    if (colon < 0) throw new Error(`WXSS declaration has no colon: ${value}`);
    const property = value.slice(0, colon).trim();
    let declarationValue = value.slice(colon + 1).trim();
    if (!property || !declarationValue) throw new Error('WXSS declaration requires property and value');
    const important = /!important$/i.test(declarationValue);
    if (important) declarationValue = declarationValue.replace(/\s*!important$/i, '').trimEnd();
    declarations.push({ property, value: declarationValue, important });
  };
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const byte = source[cursor];
    if (quote) {
      if (byte === '\\') cursor += 1;
      else if (byte === quote) quote = null;
    } else if (byte === '"' || byte === "'") quote = byte;
    else if (byte === '(') parens += 1;
    else if (byte === ')') parens = Math.max(0, parens - 1);
    else if (byte === ';' && parens === 0) {
      push(source.slice(start, cursor));
      start = cursor + 1;
    }
  }
  push(source.slice(start));
  return declarations;
}

function hasTopLevelBrace(source: string) {
  const found = findTopLevel(source, 0, ['{']);
  return found !== null;
}

function parseCssRules(source: string): { rules: CssRule[] } {
  const rules: CssRule[] = [];
  let pos = 0;
  while (pos < source.length) {
    while (pos < source.length && /\s/.test(source[pos])) pos += 1;
    if (pos >= source.length) break;
    const start = pos;
    const found = findTopLevel(source, pos, ['{', ';', '}']);
    if (!found) throw new Error('unterminated WXSS rule');
    const prelude = source.slice(start, found.index).trim();
    pos = found.index + 1;
    if (found.byte === '}') throw new Error('unexpected WXSS closing brace');
    if (found.byte === ';') {
      if (!prelude) continue;
      const keyword = /^@([a-z_-][a-z0-9_-]*)/i.exec(prelude)?.[1].toLowerCase();
      if (!keyword) throw new Error(`unsupported top-level WXSS statement: ${prelude}`);
      if (keyword === 'import' && !prelude.slice(7).trim()) throw new Error('WXSS @import requires a prelude');
      // Imports are rules in v2: preserve their source position and enclosing
      // group, including invalid placements for runtime diagnostics.
      rules.push({ selectors: [], declarations: [], nested: [], atRule: prelude });
      continue;
    }
    const blockEnd = findMatchingBrace(source, pos);
    const body = source.slice(pos, blockEnd);
    if (prelude.startsWith('@')) {
      const keyword = /^@([a-z_-][a-z0-9_-]*)/i.exec(prelude)?.[1].toLowerCase();
      if (!keyword) throw new Error(`invalid WXSS at-rule: ${prelude}`);
      if (keyword === 'import') throw new Error('WXSS @import cannot have a block');
      const groups = new Set(['media', 'supports', 'container', 'layer', 'document', 'scope', 'keyframes', '-webkit-keyframes', 'starting-style']);
      const isGroup = groups.has(keyword) || hasTopLevelBrace(body) || body.trimStart().startsWith('@');
      const nested = isGroup ? parseCssRules(body) : { rules: [] };
      const declarations = isGroup ? [] : parseDeclarations(body);
      rules.push({ selectors: [], declarations, nested: nested.rules, atRule: prelude });
    } else {
      rules.push({ selectors: splitSelectors(prelude), declarations: parseDeclarations(body), nested: [] });
    }
    pos = blockEnd + 1;
  }
  return { rules };
}

/** Parse WXSS into the versioned blob representation used by container-ir. */
export function parseWxss(source: string) {
  const parsed = parseCssRules(stripCssComments(source));
  return { version: WXSS_IR_VERSION, imports: [], rules: parsed.rules };
}

function bindingsFor(source: string) {
  const ast = parseWxml(source);
  const bindings = new Set<string>();
  const visit = (node: WxmlNode) => {
    for (const binding of node.bindings ?? []) bindings.add(binding);
    for (const child of (node.kind === 'element' ? node.children : [])) visit(child);
  };
  ast.nodes.forEach(visit);
  return [...bindings].sort(compareUtf8);
}

/**
 * Read the static `options.multipleSlots` flag from a component registration.
 * Component options commonly live in the JavaScript `Component({ ... })`
 * module rather than in the adjacent JSON config.  Reuse the module lexer so
 * comments and quoted strings cannot accidentally advertise the capability.
 */
function extractStaticMultipleSlots(source: string) {
  const tokens = scanModuleTokens(source);
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (tokens[index].kind !== 'identifier' || tokens[index].value !== 'multipleSlots') continue;
    if (tokens[index + 1].value !== ':' || tokens[index + 2].kind !== 'identifier') continue;
    if (tokens[index + 2].value === 'true') return true;
    if (tokens[index + 2].value === 'false') return false;
  }
  return undefined;
}

function classifyFiles(files: string[]) {
  const modules = [];
  const viewScripts: string[] = [];
  const templates = [];
  const styles = [];
  const assets = [];
  for (const file of files) {
    const ext = path.posix.extname(file).toLowerCase();
    if (ext === '.wxs') viewScripts.push(file);
    else if (['.js', '.mjs', '.cjs', '.json'].includes(ext)) modules.push(file);
    else if (ext === '.wxml') templates.push(file);
    else if (['.wxss', '.css'].includes(ext)) styles.push(file);
    else assets.push(file);
  }
  return { modules, viewScripts, templates, styles, assets };
}

function applyCapabilities(overrides?: CapabilityOverrides): Record<string, CapabilityStatus> {
  const values: Record<string, CapabilityStatus> = { ...DEFAULT_CAPABILITIES };
  if (!overrides) return values;
  const records = overrides.capabilities && typeof overrides.capabilities === 'object' && !Array.isArray(overrides.capabilities)
    ? overrides.capabilities : overrides;
  for (const [name, value] of Object.entries(records)) {
    if (!/^(wx\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*|(?:Page|Component)\.[A-Za-z_$][A-Za-z0-9_$]*|object:[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*|component:[A-Za-z_$][A-Za-z0-9_$]*(?:-[A-Za-z_$][A-Za-z0-9_$]*)*(?:\.[A-Za-z_$][A-Za-z0-9_$]*(?:-[A-Za-z_$][A-Za-z0-9_$]*)*)*|weappContainer\.[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*|[A-Za-z_$][A-Za-z0-9_$]*)$/.test(name)) {
      throw new Error(`Invalid capability name: ${name}`);
    }
    const status = typeof value === 'string' ? value : value?.status;
    if (!STATUS.has(status)) throw new Error(`Invalid capability status for ${name}: ${status}`);
    values[name] = status;
  }
  return values;
}

export function capabilityMatrix(capabilities: CapabilityOverrides = DEFAULT_CAPABILITIES) {
  const map = applyCapabilities(capabilities);
  // Coverage overrides describe the evidence behind an aggregate `full`
  // status. If a caller explicitly lowers a capability, its host/engine
  // records must lower with it rather than retaining the default evidence.
  const coverageFor = (name: string) => map[name] === 'full' ? DEFAULT_COVERAGE_OVERRIDES[name] : undefined;
  return {
    schemaVersion: 1,
    protocolVersion: MANIFEST_PROTOCOL_VERSION,
    hosts: HOSTS,
    engines: ENGINES,
    capabilities: Object.fromEntries(Object.keys(map).sort(compareUtf8).map((name) => [name, {
      status: map[name],
      hosts: Object.fromEntries(HOSTS.map((host) => [
        host,
        // The manifest admits candidate operations, while this diagnostic
        // matrix describes default hosts without a presenter. Opt-in is an
        // actual consumer decision, never inferred from a platform name.
        PRESENTER_REQUIRED_CAPABILITIES.has(name)
          ? 'unsupported' : coverageFor(name)?.hosts?.[host] ?? map[name],
      ])),
      // The V8 adapter is an explicit host-supplied boundary until a pinned
      // provider is linked. Never advertise a manifest capability as V8-ready
      // merely because the portable API itself is available.
      engines: Object.fromEntries(ENGINES.map((engine) => [
        engine,
        coverageFor(name)?.engines?.[engine]
          ?? (engine === 'v8' ? 'unsupported' : map[name]),
      ])),
      ...(DEFAULT_PERMISSIONS[name] ? { permission: DEFAULT_PERMISSIONS[name] } : {}),
      minManifestVersion: 1,
      minProtocolVersion: MANIFEST_PROTOCOL_VERSION,
      conformance: [`capability/${name}`],
    }])),
  };
}

/**
 * Build an in-memory manifest and its content-addressed blobs. No files are
 * written by this function, making it suitable for tests and Rust FFI callers.
 */
export async function buildManifest(inputRoot: string, options: PackOptions = {}): Promise<BuildResult> {
  const root = path.resolve(inputRoot);
  const diagnostics: Diagnostic[] = [];
  const compilerCommit = options.compilerCommit ?? 'unknown';
  const platform = options.platform ?? 'weapp';
  let modernConfig;
  try { modernConfig = await loadModernViewConfig(options); }
  catch (caught) { const error = errorInfo(caught); diagnostics.push(diagnostic('error', error.code ?? 'ERR_MODERN_VIEW_CONFIG', error.message, error.path, error.location)); }
  if (platform !== 'weapp') {
    diagnostics.push(diagnostic('error', 'ERR_UNSUPPORTED_PLATFORM', `Portable IR currently accepts only the weapp output platform, got ${platform}`));
  }
  let files;
  try {
    files = await walk(root);
  } catch (caught) { const error = errorInfo(caught);
    diagnostics.push(diagnostic('error', 'ERR_INPUT_NOT_FOUND', `Cannot scan input directory: ${error.message}`));
    return { manifest: null, blobs: new Map(), diagnostics };
  }
  const appJsonFile = path.join(root, 'app.json');
  let appJson;
  let appJsonSource = '';
  try {
    const result = await readJson(appJsonFile, 'app.json', diagnostics);
    appJson = result.value;
    appJsonSource = result.source;
  } catch (caught) { const error = errorInfo(caught);
    diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', `Cannot read app.json: ${error.message}`, 'app.json'));
    appJson = null;
  }
  if (!files.includes('app.json')) diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', '微信产物缺少 app.json', 'app.json'));
  const routeList = await routeRecords(appJson, root, diagnostics);
  const classified = classifyFiles(files);
  const blobs = new Map<string, Buffer>();
  const contentFor = async (file: string) => {
    const bytes = await fs.readFile(path.join(root, file));
    const hash = sha256(bytes);
    if (!blobs.has(hash)) blobs.set(hash, bytes);
    return { bytes, hash };
  };
  const irContentFor = (value: unknown) => {
    const bytes = Buffer.from(canonicalize(value), 'utf8');
    const hash = sha256(bytes);
    if (!blobs.has(hash)) blobs.set(hash, bytes);
    return { bytes, hash };
  };
  const modules = [];
  for (const file of classified.modules) {
    const { bytes, hash } = await contentFor(file);
    const source = bytes.toString('utf8');
    let format;
    try {
      format = formatFor(file, source);
    } catch (caught) { const error = errorInfo(caught);
      diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', `Cannot classify AppService module: ${error.message}`, file));
      continue;
    }
    const dependencies = [];
    if (format !== 'json') {
      for (const specifier of extractStaticModuleSpecifiers(source)) {
        const resolved = resolveModuleDependency(file, specifier, classified.modules);
        if (!resolved) {
          diagnostics.push(diagnostic(
            'error',
            'ERR_UNDECLARED_MODULE_DEPENDENCY',
            `Static dependency ${specifier} from ${file} is not declared in the package output`,
            file,
            { specifier },
          ));
          continue;
        }
        dependencies.push(`module:${resolved}`);
      }
    }
    modules.push({
      id: `module:${file}`,
      sha256: hash,
      format,
      scope: scopeFor(file),
      ...(dependencies.length ? { dependencies: [...new Set(dependencies)].sort(compareUtf8) } : {}),
    });
  }
  const templates = [];
  const viewDocuments: ViewDocument[] = [];
  const viewScripts: ViewScript[] = [];
  const wxsFiles = new Set(classified.viewScripts);
  for (const file of classified.viewScripts) {
    if (!validWxsSourcePath(file)) {
      diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', 'WXS source path must use a canonical package-relative .wxs extension', file));
      continue;
    }
    const { bytes, hash } = await contentFor(file);
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch {
      diagnostics.push(diagnostic('error', 'ERR_INVALID_WXS_SOURCE', 'WXS source must be valid UTF-8', file));
      continue;
    }
    viewScripts.push({ id: `wxs:${file}`, sha256: hash, dependencies: wxsDependencies(source, file, wxsFiles, diagnostics) });
  }
  for (const file of classified.templates) {
    const bytes = await fs.readFile(path.join(root, file));
    try {
      const ast = parseWxml(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const wxsModules = modernConfig?.documents.has(file) ? {}
        : collectWxsBindings(ast, file, wxsFiles, viewScripts, blobs, diagnostics);
      const { hash } = irContentFor(ast);
      templates.push({ id: `template:${file}`, wxmlAst: pointer(hash), bindings: Object.keys(wxsModules).length
        ? wxmlBindingsWithoutWxs(ast) : bindingsFor(bytes.toString('utf8')),
        ...(Object.keys(wxsModules).length ? { wxsModules } : {}),
      });
      viewDocuments.push({ documentId: file, wxmlAst: pointer(hash), ast, expressions: viewExpressions(ast) });
    } catch (caught) { const error = errorInfo(caught);
      diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', `Invalid WXML: ${error.message}`, file));
    }
  }
  const executableFor = ({ code, helper }: { code: string; helper: string }) => {
    const bytes = Buffer.from(code, 'utf8');
    const executableSha256 = sha256(bytes);
    blobs.set(executableSha256, bytes);
    return { executableSha256, helper };
  };
  const compiledModules = [];
  const compiledDocuments = [];
  let modernView;
  try { modernView = await compileModernView(viewDocuments, modernConfig, blobs); }
  catch (caught) { const error = errorInfo(caught); diagnostics.push(diagnostic('error', error.code ?? 'ERR_MODERN_VIEW_DEPENDENCY', error.message, error.path, error.location)); }
  for (const module of viewScripts) {
    try {
      const source = blobs.get(module.sha256)!.toString('utf8');
      compiledModules.push({ id: module.id, sourceSha256: module.sha256, ...executableFor(compileWxsModule(source)) });
    } catch (caught) { const error = errorInfo(caught);
      diagnostics.push(diagnostic('error', error.code ?? 'ERR_UNSUPPORTED_WXS_SYNTAX', `Cannot compile WXS: ${error.message}`, module.id));
    }
  }
  for (const document of viewDocuments) {
    if (modernConfig?.documents.has(document.documentId)) continue;
    try {
      const expressions = viewExpressions(document.ast).map(({ source, shorthand }) => ({
        source, shorthand, ...executableFor(compileWxmlExpression(source, { shorthand })),
      }));
      compiledDocuments.push({ documentId: document.documentId, wxmlAst: document.wxmlAst, expressions });
    } catch (caught) { const error = errorInfo(caught);
      diagnostics.push(diagnostic('error', error.code ?? 'ERR_UNSUPPORTED_WXS_SYNTAX', `Cannot compile WXML expression: ${error.message}`, document.documentId));
    }
  }
  const viewCompilation = compiledModules.length || compiledDocuments.some(document => document.expressions.length)
    ? { compiler: WXS_COMPILER_NAME, version: WXS_COMPILER_VERSION, abi: WXS_HELPER_ABI_VERSION,
      modules: compiledModules.sort((a, b) => compareUtf8(a.id, b.id)),
      documents: compiledDocuments.sort((a, b) => compareUtf8(a.documentId, b.documentId)) } : undefined;
  const styles = [];
  for (const file of classified.styles) {
    const bytes = await fs.readFile(path.join(root, file));
    try {
      const ir = parseWxss(bytes.toString('utf8'));
      const { hash } = irContentFor(ir);
      styles.push({ id: `style:${file}`, wxssIr: pointer(hash), scope: scopeFor(file) });
    } catch (caught) { const error = errorInfo(caught);
      diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', `Invalid WXSS: ${error.message}`, file));
    }
  }
  const assets = [];
  for (const file of classified.assets) {
    const { bytes, hash } = await contentFor(file);
    assets.push({ path: file, sha256: hash, mime: mimeType(file), size: bytes.byteLength });
  }
  const components = [];
  const sourceConfigs = new Map<string, JsonObject>();
  // Preserve usingComponents declarations as an explicit relation table. The
  // original JSON remains a content-addressed module; this table is the
  // normalized index used by hosts to resolve component templates.
  const jsonFiles = ['app.json', ...classified.modules.filter((file) => file.endsWith('.json') && file !== 'app.json')];
  for (const file of jsonFiles.sort(compareUtf8)) {
    let config;
    if (file === 'app.json') config = appJson;
    else {
      const result = await readJson(path.join(root, file), file, diagnostics);
      config = result.value;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    sourceConfigs.set(file, config);
    const hasUsingComponents = config.usingComponents
      && typeof config.usingComponents === 'object'
      && !Array.isArray(config.usingComponents);
    let multipleSlots = config.options?.multipleSlots ?? config.multipleSlots;
    if (typeof multipleSlots !== 'boolean') {
      const jsFile = file.endsWith('.json') ? file.slice(0, -'.json'.length) + '.js' : null;
      if (jsFile && files.includes(jsFile)) {
        try {
          multipleSlots = extractStaticMultipleSlots(
            (await fs.readFile(path.join(root, jsFile))).toString('utf8'),
          );
        } catch {
          // The JS module is optional for malformed/incomplete fixtures; its
          // diagnostics are reported by the regular module scan.
        }
      }
    }
    if (!hasUsingComponents && typeof multipleSlots !== 'boolean') continue;
    const entries = Object.entries(hasUsingComponents ? config.usingComponents : {})
      .filter(([name, target]) => typeof name === 'string' && name.length > 0 && typeof target === 'string')
      .sort(([left], [right]) => compareUtf8(left, right));
    const resolvedEntries = entries.map(([name, target]) => {
      try {
        return [name, componentTarget(file, target as string)];
      } catch {
        diagnostics.push(diagnostic('error', 'ERR_INVALID_MANIFEST', `Component path escapes package root: ${target}`, file));
        return [name, target];
      }
    });
    components.push({
      id: `components:${file}`,
      owner: file,
      usingComponents: Object.fromEntries(resolvedEntries),
      ...(typeof multipleSlots === 'boolean' ? { multipleSlots } : {}),
    });
  }
  let capabilities;
  try {
    capabilities = applyCapabilities(options.capabilities);
  } catch (caught) { const error = errorInfo(caught);
    diagnostics.push(diagnostic('error', 'ERR_INVALID_CAPABILITY', error.message));
    return { manifest: null, blobs, diagnostics, appJsonSource };
  }
  let rendering;
  try { rendering = buildRendererProfiles(routeList, appJson, sourceConfigs, modernConfig); }
  catch (caught) { const error = errorInfo(caught); diagnostics.push(diagnostic('error', error.code ?? 'ERR_RENDERER_CONFIG', error.message, error.path)); }
  const manifest = {
    schemaVersion: rendering ? RENDERING_MANIFEST_SCHEMA_VERSION : modernView ? 2 : MANIFEST_SCHEMA_VERSION,
    protocolVersion: MANIFEST_PROTOCOL_VERSION,
    compiler: { name: 'weapp-vite', commit: compilerCommit, platform },
    app: { appJson: 'app.json', entryModule: 'app.js' },
    routes: routeList,
    modules: modules.sort((a, b) => compareUtf8(a.id, b.id)),
    ...(viewScripts.length ? { viewScripts: viewScripts.sort((a, b) => compareUtf8(a.id, b.id)) } : {}),
    ...(viewCompilation ? { viewCompilation } : {}),
    ...(modernView ? { modernView } : {}),
    ...(rendering ? { rendering } : {}),
    templates: templates.sort((a, b) => compareUtf8(a.id, b.id)),
    styles: styles.sort((a, b) => compareUtf8(a.id, b.id)),
    components: components.sort((a, b) => compareUtf8(a.id, b.id)),
    assets: assets.sort((a, b) => compareUtf8(a.path, b.path)),
    capabilities: Object.fromEntries(Object.keys(capabilities).sort(compareUtf8).map((name) => [name, capabilities[name]])),
    integrity: { algorithm: 'sha256', root: '' },
  };
  if (!files.includes('app.js')) diagnostics.push(diagnostic('warning', 'APP_ENTRY_MISSING', '微信产物缺少 app.js; the manifest still reserves app.js as the entry module', 'app.js'));
  const rootInput = { ...manifest, integrity: { algorithm: 'sha256', root: '' } };
  manifest.integrity.root = sha256(Buffer.from(canonicalize(rootInput), 'utf8'));
  return { manifest, blobs, diagnostics, appJsonSource,
    ...(modernConfig ? { watchDependencies: [...modernConfig.watchDependencies.entries()]
      .sort(([a], [b]) => compareUtf8(a, b)).map(([file, hash]) => ({ path: file, sha256: hash })) } : {}),
  };
}

export async function writePack(result: BuildResult, outputRoot: string, _options: PackOptions = {}) {
  const output = path.resolve(outputRoot);
  const errors = result.diagnostics.filter((entry) => entry.severity === 'error');
  if (!result.manifest || errors.length > 0) {
    const error = errorInfo(new Error(`Cannot write an invalid manifest (${errors.length} error${errors.length === 1 ? '' : 's'})`));
    error.code = 'ERR_INVALID_MANIFEST';
    error.diagnostics = result.diagnostics;
    throw error;
  }
  await fs.mkdir(path.join(output, 'blobs', 'sha256'), { recursive: true });
  // A pack directory is owned by this command. Remove only old digest-named
  // blobs so a second pack cannot leave unreachable bytes behind while any
  // user-created files beside the output remain untouched.
  const blobRoot = path.join(output, 'blobs', 'sha256');
  const expectedBlobs = new Set(result.blobs.keys());
  const existingBlobs = await fs.readdir(blobRoot, { withFileTypes: true });
  await Promise.all(existingBlobs
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name) && !expectedBlobs.has(entry.name))
    .map((entry) => fs.unlink(path.join(blobRoot, entry.name))));
  const writes = [];
  for (const [hash, bytes] of [...result.blobs.entries()].sort(([a], [b]) => compareUtf8(a, b))) {
    const target = path.join(output, 'blobs', 'sha256', hash);
    writes.push(fs.writeFile(target, bytes));
  }
  writes.push(fs.writeFile(path.join(output, 'manifest.json'), `${canonicalize(result.manifest)}\n`, 'utf8'));
  const matrix = capabilityMatrix(result.manifest.capabilities);
  writes.push(fs.writeFile(path.join(output, 'capability-matrix.json'), `${canonicalize(matrix)}\n`, 'utf8'));
  const report = { schemaVersion: 1, diagnostics: result.diagnostics };
  writes.push(fs.writeFile(path.join(output, 'diagnostics.json'), `${canonicalize(report)}\n`, 'utf8'));
  await Promise.all(writes);
  return { output, manifestPath: path.join(output, 'manifest.json'), blobCount: result.blobs.size };
}

export async function packContainer(inputRoot: string, outputRoot: string, options: PackOptions = {}) {
  const result = await buildManifest(inputRoot, options);
  const written = await writePack(result, outputRoot, options);
  return { ...result, ...written };
}

