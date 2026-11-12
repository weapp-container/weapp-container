// Read-only source-map v3 diagnostics. The caller supplies verified CAS bytes;
// this module has no filesystem/network access and never evaluates source text.
import path from 'node:path';

export const SOURCE_MAP_LIMITS = Object.freeze({
  mapBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, maps: 128,
  segments: 100000, lines: 100000, sources: 4096, names: 16384,
  stackBytes: 16384, frames: 64,
});
const HASH = /^[a-f0-9]{64}$/;
const MAX_POSITION = 0x7fffffff;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const invalid = reason => Object.assign(new Error(reason), { reason });
const safeLabel = value => typeof value === 'string' && value.length > 0 && value.length <= 512 &&
  !/[\x00-\x20\x7f\\?#%]/.test(value) && !value.startsWith('/') &&
  !value.split('/').includes('..') && !value.split('/').includes('.') &&
  (!value.includes(':') || (value.indexOf(':') === value.lastIndexOf(':') && /^npm:(?:@[\w.-]+\/)?[\w.-]+@[\w.+-]+\//.test(value)) || /^virtual:[a-f0-9]{64}$/.test(value));
const artifactPath = value => safeLabel(value) && !value.includes(':');
const add = (a, b) => {
  const value = a + b;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_POSITION) throw invalid('invalid-position');
  return value;
};

function vlq(segment) {
  const fields = []; let value = 0, shift = 0;
  for (const char of segment) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0 || shift > 30) throw invalid('invalid-vlq');
    value += (digit & 31) * 2 ** shift;
    if (!Number.isSafeInteger(value) || value > 2 * MAX_POSITION + 1) throw invalid('invalid-vlq');
    if (digit & 32) shift += 5;
    else {
      fields.push(value % 2 ? -Math.floor(value / 2) : value / 2);
      if (fields.length > 5) throw invalid('invalid-segment');
      value = 0; shift = 0;
    }
  }
  if (shift || ![1, 4, 5].includes(fields.length)) throw invalid('invalid-segment');
  return fields;
}

function parseMap(bytes, { allowedSources, directory = '', budget }) {
  let wire;
  try { wire = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid('invalid-json'); }
  if (!wire || wire.version !== 3 || wire.sections !== undefined ||
      (wire.sourceRoot !== undefined && wire.sourceRoot !== '') ||
      !Array.isArray(wire.sources) || wire.sources.length > SOURCE_MAP_LIMITS.sources ||
      !Array.isArray(wire.names) || wire.names.length > SOURCE_MAP_LIMITS.names ||
      wire.names.some(value => typeof value !== 'string' || value.length > 512) ||
      typeof wire.mappings !== 'string') throw invalid('unsupported-map');
  const sources = wire.sources.map(value => {
    if (typeof value !== 'string') throw invalid('unsafe-source');
    if (allowedSources) {
      if (!safeLabel(value) || (!allowedSources.has(value) && !/^virtual:[a-f0-9]{64}$/.test(value))) throw invalid('unsafe-source');
      return value;
    }
    // Resolve labels within the artifact namespace, never against a disk path.
    if (!value.length || value.length > 512 || /[\x00-\x20\x7f\\:?#%]/.test(value) || value.startsWith('/')) throw invalid('unsafe-source');
    const resolved = path.posix.normalize(path.posix.join(directory, value));
    if (!artifactPath(resolved)) throw invalid('unsafe-source');
    return resolved;
  });
  const rawLines = wire.mappings.split(';');
  if (rawLines.length > budget.lines) throw invalid('map-budget');
  budget.lines -= rawLines.length;
  let source = 0, originalLine = 0, originalColumn = 0, name = 0;
  const lines = rawLines.map(line => {
    let column = 0;
    if (!line) return [];
    return line.split(',').map(segment => {
      if (--budget.segments < 0) throw invalid('map-budget');
      const fields = vlq(segment), previous = column;
      column = add(column, fields[0]);
      if (column < previous) throw invalid('unordered-columns');
      if (fields.length === 1) return [column];
      source = add(source, fields[1]); originalLine = add(originalLine, fields[2]); originalColumn = add(originalColumn, fields[3]);
      if (source >= sources.length) throw invalid('invalid-source');
      if (fields.length === 5) { name = add(name, fields[4]); if (name >= wire.names.length) throw invalid('invalid-name'); }
      return [column, source, originalLine, originalColumn];
    });
  });
  // names, file and sourcesContent are intentionally discarded, not exposed.
  return { sources, lines };
}

function lookup(entry, line, column) {
  const segments = entry.map.lines[line - entry.offset - 1];
  if (!segments?.length) return null;
  let segment;
  if (column === undefined) segment = segments.find(value => value.length === 4);
  else {
    let low = 0, high = segments.length;
    while (low < high) { const middle = (low + high) >>> 1; if (segments[middle][0] <= column - 1) low = middle + 1; else high = middle; }
    segment = segments[low - 1];
  }
  if (!segment || segment.length !== 4) return null;
  return { file: entry.map.sources[segment[1]], line: segment[2] + 1, column: segment[3] + 1 };
}

export async function createSourceMapIndex(manifest, readBlob) {
  const entries = new Map(), assets = new Map(), budget = { bytes: SOURCE_MAP_LIMITS.totalBytes, lines: SOURCE_MAP_LIMITS.lines, segments: SOURCE_MAP_LIMITS.segments };
  const candidates = []; let exhausted = false;
  const candidate = value => { if (candidates.length < SOURCE_MAP_LIMITS.maps) candidates.push(value); else exhausted = true; };
  for (const asset of Array.isArray(manifest.assets) ? manifest.assets : []) if (asset && artifactPath(asset.path) && HASH.test(asset.sha256)) assets.set(asset.path, asset);
  for (const module of Array.isArray(manifest.modules) ? manifest.modules : []) {
    if (!module) continue;
    const file = typeof module.id === 'string' ? module.id.replace(/^module:/, '') : '';
    if (!artifactPath(file)) continue;
    const asset = assets.get(`${file}.map`);
    if (asset) candidate({ aliases: [module.id, file], hash: asset.sha256, directory: path.posix.dirname(file), offset: 0 });
  }
  for (const unit of Array.isArray(manifest.modernView?.units) ? manifest.modernView.units : []) {
    if (!unit) continue;
    if (typeof unit.id !== 'string' || !/^modern:[a-f0-9]{64}$/.test(unit.id)) continue;
    candidate({ aliases: [`weapp-view:///${unit.id}.js`], hash: unit.sourceMapSha256,
      allowedSources: new Set((Array.isArray(unit.sources) ? unit.sources : []).map(value => value?.path)), offset: 3 });
  }
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]; let entry;
    try {
      if (index >= SOURCE_MAP_LIMITS.maps || budget.bytes <= 0) throw invalid('map-budget');
      if (!HASH.test(candidate.hash)) throw invalid('missing-map');
      const bytes = await readBlob(candidate.hash, Math.min(SOURCE_MAP_LIMITS.mapBytes, budget.bytes));
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > Math.min(SOURCE_MAP_LIMITS.mapBytes, budget.bytes)) throw invalid('map-budget');
      budget.bytes -= bytes.byteLength;
      entry = { map: parseMap(bytes, { ...candidate, budget }), offset: candidate.offset };
    } catch (error) { entry = { reason: error.reason ?? 'unavailable-map' }; }
    for (const alias of new Set(candidate.aliases)) {
      // Ambiguous aliases never choose a map by iteration order.
      entries.set(alias, entries.has(alias) ? { reason: 'ambiguous-map' } : entry);
    }
  }
  return Object.freeze({ resolve(details) { return resolve(entries, details, exhausted); } });
}

export function unmappedSourceDiagnostic(reason) {
  return { version: '1.0', status: 'unmapped', frames: [], reason };
}

function resolve(entries, details, exhausted) {
  const stack = typeof details?.stack === 'string' ? details.stack : details?.error?.stack;
  if (typeof stack === 'string' && Buffer.byteLength(stack) > SOURCE_MAP_LIMITS.stackBytes) return unmappedSourceDiagnostic('stack-budget');
  const locations = [];
  if (typeof stack === 'string') {
    const pattern = /([^\s()[\]{}"'<>]+?):([1-9][0-9]{0,8})(?::([1-9][0-9]{0,8}))?(?=$|[\s()[\]{}"',])/g;
    for (const match of stack.matchAll(pattern)) {
      if (locations.length === SOURCE_MAP_LIMITS.frames) return unmappedSourceDiagnostic('frame-budget');
      locations.push({ file: match[1], line: Number(match[2]), ...(match[3] ? { column: Number(match[3]) } : {}),
        start: match.index, end: match.index + match[0].length, alreadyMapped: stack.slice(Math.max(0, match.index - 11), match.index) === '[generated ' });
    }
  } else if (details?.error && typeof details.error.file === 'string' && details.error.file.length <= 1024 &&
      Number.isSafeInteger(details.error.line) && details.error.line > 0 && details.error.line <= MAX_POSITION &&
      (details.error.column === undefined || (Number.isSafeInteger(details.error.column) && details.error.column > 0 && details.error.column <= MAX_POSITION))) {
    locations.push({ file: details.error.file, line: details.error.line, ...(details.error.column === undefined ? {} : { column: details.error.column }) });
  }
  if (!locations.length) return unmappedSourceDiagnostic('no-location');
  let mappedStack = stack, mapped = 0;
  const frames = locations.map(location => {
    const { file, line, column } = location, generated = { file, line, ...(column === undefined ? {} : { column }) }, entry = entries.get(file);
    if (!entry?.map) return { generated, status: 'unmapped', reason: entry?.reason ?? (exhausted ? 'map-budget' : 'unindexed-location') };
    const original = lookup(entry, line, column);
    if (!original) return { generated, status: 'unmapped', reason: 'unmapped-segment' };
    mapped++;
    return { generated, original, status: 'mapped', ...(location.alreadyMapped ? { alreadyMapped: true } : {}) };
  });
  if (typeof stack === 'string') for (let i = locations.length - 1; i >= 0; i--) {
    const location = locations[i], frame = frames[i];
    if (frame.status !== 'mapped' || location.alreadyMapped) continue;
    const { file, line, column } = frame.original;
    mappedStack = mappedStack.slice(0, location.start) + `${file}:${line}:${column} [generated ${stack.slice(location.start, location.end)}]` + mappedStack.slice(location.end);
  }
  return { version: '1.0', status: mapped === frames.length ? 'mapped' : mapped ? 'partial' : 'unmapped',
    ...(typeof mappedStack === 'string' ? { mappedStack } : {}), frames, ...(mapped ? {} : { reason: 'no-mapped-location' }) };
}
