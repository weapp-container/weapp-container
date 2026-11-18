import { copyAnimationRequest, copyAnimationStyles, computedAnimationBaseline, stageAnimationStyles, sameAnimationKey } from './dom-animation-sample.mjs'
/** Evaluated ViewDocument -> isolated browser layout. No Rust rectangles,
 * template evaluation, raw HTML, application scripts or implicit resource URLs.
 * This is a deliberately bounded DOM profile, not a claim of WeChat parity.
 */
export class DomViewError extends Error {
  constructor(code, message, occurrenceId = null) {
    super(`${code}: ${message}`); this.name = 'DomViewError'; this.code = code; this.occurrenceId = occurrenceId;
  }
  toJSON() { return { code: this.code, message: this.message, occurrenceId: this.occurrenceId }; }
}
const fail = message => { throw new DomViewError('ERR_RENDER', message); };
const unsupported = message => { throw new DomViewError('ERR_UNSUPPORTED_CAPABILITY', message); };
const cancelled = () => new DomViewError('ERR_CANCELLED', 'DOM candidate superseded or disposed');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const decimal = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 18446744073709551615n;
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const canonical = value => nonempty(value) && !/[\\#?:\x00-\x1f\x7f-\x9f]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const textControls = new Set(['input', 'textarea']);
const builtins = new Set(['view', 'text', 'image', 'scroll-view', 'input', 'textarea', 'button', 'camera', 'video']);
const domTag = tag => tag === 'image' ? 'img' : ['input', 'textarea', 'button'].includes(tag) ? tag : builtins.has(tag) || tag === 'page' ? `wx-${tag}` : 'wx-component';
const supportedEvents = new Set(['tap', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'scroll', 'input', 'focus', 'blur', 'confirm', 'getphonenumber', 'initdone', 'error', 'stop', 'scancode', 'play', 'pause', 'ended', 'timeupdate', 'fullscreenchange', 'waiting', 'loadedmetadata', 'progress']);
const touchEvents = new Set(['touchstart', 'touchmove', 'touchend', 'touchcancel']);
const buttonInteractions = new Set(['tap', ...touchEvents, 'confirm']);
const buttonEvents = new Set(['tap', ...touchEvents, 'focus', 'blur', 'getphonenumber']);
const maxEventBatch = 256;
const editAttributes = ['value', 'placeholder', 'disabled', 'maxlength', 'focus', 'cursor', 'selection-start', 'selection-end'];
// ViewDocument already contains the selected branches and expanded repeats.
// These exact WXML controls remain source metadata, never browser attributes.
const evaluatedStructuralAttributes = new Set(['wx:if', 'wx:elif', 'wx:else', 'wx:for', 'wx:for-item', 'wx:for-index', 'wx:key']);
const nativeAttributes = new Map([['text', ['selectable']], ['image', ['mode']], ['scroll-view', ['scroll-x', 'scroll-y']], ['input', ['value', 'placeholder', 'disabled', 'maxlength']], ['textarea', ['value', 'placeholder', 'disabled', 'maxlength']], ['button', ['size', 'plain', 'loading']]]);
const tagAttributes = new Map([['text', ['selectable']], ['image', ['src', 'mode', 'alt']], ['scroll-view', ['scroll-x', 'scroll-y', 'scroll-top', 'scroll-left']], ['input', [...editAttributes, 'type', 'password']], ['textarea', editAttributes], ['button', ['type', 'size', 'plain', 'disabled', 'loading']]]);
tagAttributes.get('button').push('open-type', 'phone-number-no-quota-toast', 'lang');
tagAttributes.set('camera', ['mode','device-position','flash','frame-size','resolution']);
tagAttributes.set('video', ['src','duration','controls','danmu-list','danmu-btn','enable-danmu','autoplay','loop','muted','initial-time','direction','show-progress','show-fullscreen-btn','show-play-btn','show-center-play-btn','enable-progress-gesture','object-fit','poster','show-mute-btn','title','play-btn-position','enable-play-gesture','enable-auto-rotation','vslide-gesture','vslide-gesture-in-fullscreen','show-screen-lock-button','picture-in-picture-mode','enable-background-playback']);
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const mediaMimes = new Set(['video/mp4','video/webm','video/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/webm','audio/ogg']);
const own = (value, key) => Object.hasOwn(value, key);
const attr = (node, name) => own(node.typedAttrs ?? {}, name) ? node.typedAttrs[name] : node.attrs?.[name];
const truth = value => value !== undefined && value !== null && value !== false && value !== 0 && value !== 'false';
const scalar = (value, name) => value == null ? '' : ['string', 'number', 'boolean'].includes(typeof value)
  ? String(value) : fail(`${name} must be a scalar attribute`);
const cssQuote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ')}"`;
const clone = value => {
  try { return value === undefined ? null : JSON.parse(JSON.stringify(value)); }
  catch { fail('ordinary JSON data is required at the DOM boundary'); }
};

function exact(value, allowed, name) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`invalid ${name} fields`);
}
function buttonState(node) {
  if (attr(node, 'open-type') != null && attr(node, 'open-type') !== 'getPhoneNumber') unsupported(`button open-type ${attr(node, 'open-type')}`);
  const type = scalar(attr(node, 'type') ?? 'default', 'button type');
  const size = scalar(attr(node, 'size') ?? 'default', 'button size');
  if (!['default', 'primary', 'warn'].includes(type)) unsupported(`button type ${type}`);
  if (!['default', 'mini'].includes(size)) unsupported(`button size ${size}`);
  for (const name of ['plain', 'disabled', 'loading']) scalar(attr(node, name), `button ${name}`);
  return { type, size, plain: truth(attr(node, 'plain')), disabled: truth(attr(node, 'disabled')), loading: truth(attr(node, 'loading')) };
}
/** Native editing state is identified by the declaration as well as the
 * occurrence. Reused occurrence IDs must not transfer edits between owners or
 * control kinds. Offsets use the browser/JS UTF-16 convention. */
export function domTextControlState(node) {
  if (!textControls.has(node.tag)) fail('text control adapter requires input or textarea');
  const value = scalar(attr(node, 'value'), 'value');
  const type = node.tag === 'textarea' ? 'textarea'
    : truth(attr(node, 'password')) ? 'password' : scalar(attr(node, 'type') ?? 'text', 'type');
  if (node.tag === 'input' && !['text', 'password'].includes(type)) unsupported(`input type ${type}`);
  for (const name of ['disabled', 'password', 'focus']) if (attr(node, name) != null) scalar(attr(node, name), name);
  if (truth(attr(node, 'focus'))) unsupported('declarative input focus before presentation acknowledgement');
  const offset = name => {
    const raw = attr(node, name);
    if (raw == null) return -1;
    scalar(raw, name);
    const number = Number(raw);
    if (!Number.isInteger(number) || number < -1 || number > 2147483647) fail(`invalid ${node.tag} ${name}`);
    return number;
  };
  const maximum = attr(node, 'maxlength') == null ? null : offset('maxlength');
  const cursor = offset('cursor'), start = offset('selection-start'), end = offset('selection-end');
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) fail('text selection requires an ordered start/end pair');
  const selection = start >= 0 ? { start, end, direction: 'none' }
    : cursor >= 0 ? { start: cursor, end: cursor, direction: 'none' } : null;
  const ownership = node.ownership ?? {};
  return { value, type, placeholder: scalar(attr(node, 'placeholder'), 'placeholder'), disabled: truth(attr(node, 'disabled')), maximum, selection,
    identity: JSON.stringify([node.tag, type, node.key ?? null, ownership.documentId, ownership.eventOwner ?? null, ownership.componentScope ?? null, ownership.slotOwner ?? null]) };
}

export function restoreDomTextControlState(control, previous) {
  const same = previous?.controlIdentity === control.identity;
  const value = same && previous.sourceValue === control.value ? previous.value : control.value;
  const priorSelection = same && previous.selectionStart != null && previous.selectionEnd != null
    ? { start: previous.selectionStart, end: previous.selectionEnd, direction: previous.selectionDirection ?? 'none' } : null;
  const requested = control.selection ?? priorSelection;
  const selection = requested ? { start: Math.min(requested.start, value.length), end: Math.min(requested.end, value.length), direction: requested.direction } : null;
  return { value, selection, focus: same && previous.focus === true && !control.disabled };
}
export function validateDomViewDocument(document) {
  exact(document, ['version', 'sessionId', 'pageId', 'revision', 'routePath', 'profile', 'nodes', 'styleRoots', 'styles', 'resources'], 'ViewDocument');
  if (document.version !== '1.0') throw new DomViewError('ERR_PROTOCOL_VERSION', 'unsupported ViewDocument version');
  if (document.profile !== 'webview') unsupported('DOM presenter requires the explicit webview profile');
  if (!nonempty(document.sessionId) || !integer(document.pageId) || !integer(document.revision)
    || !canonical(document.routePath) || ![document.nodes, document.styleRoots, document.styles, document.resources].every(Array.isArray)) fail('invalid ViewDocument identity or tables');
  const nodes = new Map(), pending = document.nodes.map(node => ({ node, parent: null, depth: 0, buttonAncestor: null }));
  while (pending.length) {
    const { node, parent, depth, buttonAncestor } = pending.pop();
    if (depth > 256 || nodes.size >= 100000 || !record(node) || !nonempty(node.occurrenceId) || nodes.has(node.occurrenceId)) fail('invalid or over-budget occurrence graph');
    exact(node, node.kind === 'element'
      ? ['kind', 'occurrenceId', 'tag', 'attrs', 'typedAttrs', 'key', 'ownership', 'events', 'children']
      : ['kind', 'occurrenceId', 'value', 'ownership'], 'ViewNode');
    exact(node.ownership, ['eventOwner', 'componentScope', 'slotOwner', 'documentId'], 'ownership');
    if (!canonical(node.ownership.documentId) || !node.ownership.documentId.endsWith('.wxml')
      || ['eventOwner', 'componentScope', 'slotOwner'].some(key => node.ownership[key] != null && !nonempty(node.ownership[key]))) fail('invalid occurrence ownership');
    nodes.set(node.occurrenceId, { node, parent });
    if (node.kind === 'text') { if (typeof node.value !== 'string') fail('invalid text occurrence'); continue; }
    if (node.kind !== 'element' || !nonempty(node.tag) || !record(node.attrs) || !record(node.typedAttrs ?? {})
      || !Array.isArray(node.children) || !Array.isArray(node.events)) fail('invalid element occurrence');
    if (Object.values(node.attrs).some(value => typeof value !== 'string')) fail('invalid legacy attribute projection');
    if (!builtins.has(node.tag) && !nonempty(node.ownership.componentScope)) unsupported(`component ${node.tag} has no DOM adapter`);
    if (['image', 'input', 'textarea'].includes(node.tag) && node.children.length) unsupported(`${node.tag} children`);
    // Native buttons cannot contain independent controls. Preflight the whole
    // evaluated graph before acquiring resources or creating a DOM candidate.
    if (buttonAncestor && (['button', 'input', 'textarea'].includes(node.tag) || attr(node, 'tabindex') != null)) unsupported(`interactive descendant of button ${buttonAncestor}`);
    if (node.tag === 'button') buttonState(node);
    if (textControls.has(node.tag)) domTextControlState(node);
    const bindings = new Set();
    for (const binding of node.events) {
      exact(binding, ['event', 'handler', 'phase', 'catch'], 'event binding');
      if (!supportedEvents.has(binding.event)) unsupported(`event ${binding.event}`);
      if (node.tag === 'button' && !buttonEvents.has(binding.event)) unsupported(`button event ${binding.event}`);
      const key = `${binding.phase}:${binding.event}`;
      if (!nonempty(binding.handler) || !['capture', 'bubble'].includes(binding.phase) || typeof binding.catch !== 'boolean' || bindings.has(key)) fail('invalid or duplicate event binding');
      bindings.add(key);
    }
    pending.push(...node.children.map(child => ({ node: child, parent: node.occurrenceId, depth: depth + 1,
      buttonAncestor: buttonAncestor ?? (node.tag === 'button' ? node.occurrenceId : null) })));
  }
  if (document.styles.length > 16384 || document.resources.length > 100000) fail('ViewDocument table budget exceeded');
  const sheets = new Map(), sources = new Map(), resources = new Map();
  for (const sheet of document.styles) {
    exact(sheet, ['id', 'scopeId', 'ir'], 'stylesheet');
    const path = sheet.id?.replace(/^style:/, ''), key = JSON.stringify([sheet.id, sheet.scopeId ?? null]);
    if (!sheet.id?.startsWith('style:') || !canonical(path) || !/\.(wxss|css)$/.test(path)
      || (sheet.scopeId != null && !nonempty(sheet.scopeId)) || sheets.has(key)) fail('invalid stylesheet identity');
    const encoded = JSON.stringify(sheet.ir);
    if (sources.has(sheet.id) && sources.get(sheet.id) !== encoded) fail('scoped stylesheet sources differ');
    sources.set(sheet.id, encoded); sheets.set(key, sheet);
  }
  if (document.styleRoots.some(root => !sources.has(root))) fail('missing stylesheet root');
  for (const resource of document.resources) {
    if (!record(resource) || !canonical(resource.path) || !/^[a-f0-9]{64}$/.test(resource.sha256)
      || !integer(resource.size) || !nonempty(resource.mime) || resources.has(resource.path)) fail('invalid resource descriptor');
    resources.set(resource.path, resource);
  }
  return { nodes, sheets, resources };
}

function resolvePath(owner, reference) {
  if (!nonempty(reference) || /[\\?#:\x00-\x1f\x7f-\x9f]/.test(reference) || reference.startsWith('//')) unsupported(`resource reference ${reference}`);
  const parts = reference.startsWith('/') ? [] : owner.split('/').slice(0, -1);
  for (const part of reference.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) fail('resource escapes portable package'); parts.pop(); }
    else parts.push(part);
  }
  const path = parts.join('/'); if (!canonical(path)) fail('invalid resolved resource path'); return path;
}

// Split only outside strings, brackets and parentheses. Escaped CSS requires a
// proper tokenizer adapter; rejecting it is safer than changing its meaning.
function splitCss(value, delimiter) {
  if (typeof value !== 'string' || /[\\{}\x00]/.test(value) || value.includes('/*')) unsupported('escaped, commented or block-valued CSS');
  const parts = []; let start = 0, quote = '', bracket = 0, paren = 0;
  for (let index = 0; index < value.length; index++) {
    const c = value[index];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[') bracket++; if (c === ']') bracket--;
    if (c === '(') paren++; if (c === ')') paren--;
    if (bracket < 0 || paren < 0) fail('unbalanced CSS token');
    if (!bracket && !paren && delimiter(c)) { parts.push(value.slice(start, index)); parts.push(c); start = index + 1; }
  }
  if (quote || bracket || paren) fail('unterminated CSS token');
  parts.push(value.slice(start)); return parts;
}
export function scopeDomSelector(selector, scopeToken) {
  if (!/^[a-z0-9]+$/.test(scopeToken)) fail('invalid internal scope token');
  const parts = splitCss(selector, c => /[\s>+~,]/.test(c));
  return parts.map(part => {
    if (!part || /^[\s>+~,]$/.test(part)) return part;
    const type = part.match(/^(\*|[a-zA-Z][\w-]*)/), tag = type?.[1];
    let rest = type ? part.slice(type[0].length) : part;
    let output = tag === '*' ? '*' : tag ? `${domTag(tag)}${builtins.has(tag) || tag === 'page' ? '' : `:where([data-wc-tag=${cssQuote(tag)}])`}` : '';
    let pseudoElement = '';
    while (rest) {
      const token = rest.match(/^(?:[.#][a-zA-Z_][\w-]*|\[(?:[a-zA-Z_][\w-]*)(?:[~|^$*]?=(?:[\w-]+|"[^"\n]*"|'[^'\n]*'))?(?:\s+[is])?\]|:(?:hover|active|focus-visible|focus-within|focus|disabled|checked|empty|first-child|last-child|only-child|first-of-type|last-of-type|only-of-type)(?![\w-])|:nth-(?:last-)?(?:child|of-type)\((?:odd|even|[-+0-9n\s]+)\))/);
      if (token) {
        const sourceType = token[0].match(/^\[type(?=\]|[~|^$*]?=)(.*)\]$/i);
        if (sourceType && tag === 'button') output += `[data-wc-button-source-type${sourceType[1]}]`;
        else if (sourceType && (!tag || tag === '*')) {
          // Preserve attribute-selector specificity and generic input[type]
          // matching while keeping WXML appearance independent of HTML type.
          output += `:is(${token[0]}:where(:not(button)),[data-wc-button-source-type${sourceType[1]}]:where(button))`;
        } else output += token[0];
        rest = rest.slice(token[0].length); continue;
      }
      if (/^::(?:before|after)$/.test(rest)) { pseudoElement = rest; rest = ''; continue; }
      unsupported(`selector fragment ${rest}`);
    }
    if (!output) fail('empty CSS selector');
    return `${output}:where([data-wc-owner="${scopeToken}"])${pseudoElement}`;
  }).join('');
}

async function cssValue(value, viewport, resourceUrl, owner) {
  splitCss(value, () => false);
  let result = '', quote = '';
  for (let index = 0; index < value.length;) {
    const c = value[index];
    if (quote) { result += c; if (c === quote) quote = ''; index++; continue; }
    if (c === '"' || c === "'") { quote = c; result += c; index++; continue; }
    const before = value[index - 1] ?? '';
    if (!/[\w-]/.test(before)) {
      const url = value.slice(index).match(/^url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'"(]+))\s*\)/i);
      if (url) {
        const reference = url[1] ?? url[2] ?? url[3];
        result += `url(${cssQuote(await resourceUrl(owner, reference))})`; index += url[0].length; continue;
      }
      const size = value.slice(index).match(/^(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)rpx\b/);
      if (size) { const pixels = Number(size[1]) * viewport.width / 750; if (!Number.isFinite(pixels)) fail('rpx overflow'); result += `${pixels}px`; index += size[0].length; continue; }
    }
    result += c; index++;
  }
  if (/\b(?:url|image-set|expression)\s*\(/i.test(result.replace(/url\("[^"\n]*"\)/g, ''))) unsupported('unresolved CSS resource or executable value');
  return result;
}
function importPrelude(value) {
  const match = value.trim().match(/^(?:"([^"]+)"|'([^']+)'|url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s()'";]+))\s*\))\s*(.*)$/i);
  if (!match) unsupported('WXSS import syntax');
  return [match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5], match[6]];
}

/** Pure semantic preparation plus an explicitly provided content-addressed
 * resource resolver. It never obtains URLs from source attributes directly. */
export async function prepareDomDocument(document, viewport, { resolveResource, supports = () => true, validateSelector = () => {}, signal, presentationKey, releaseAfter, animation } = {}) {
  const tables = validateDomViewDocument(document);
  animation = copyAnimationRequest(animation);
  // Every consumed runtime binding has a baseline descriptor, including
  // retained runs which need no new properties. Style patches alone do not
  // authorize a directive, and metadata may only identify actual elements.
  const animationOccurrences = new Set(animation?.baselines.map(item => item.occurrenceId));
  for (const id of animationOccurrences) if (tables.nodes.get(id)?.node.kind !== 'element') fail('animation directive metadata must identify an element occurrence');
  const resourceKey = freeze(clone(validateDomPresentationKey(presentationKey ?? { sessionId: document.sessionId, pageId: String(document.pageId), documentRevision: String(document.revision), presentationRevision: String(document.revision), surfaceGeneration: '0', profile: document.profile }, document)));
  if (!record(viewport) || !['width', 'height'].every(key => Number.isFinite(viewport[key]) && viewport[key] > 0 && viewport[key] <= 4096)) fail('invalid logical viewport');
  const scopes = new Map([[null, 'p']]), leases = [], urls = new Map(), releaseDrains = [], releaseErrors = [];
  let cssBytes = 0, releasePromise;
  const check = () => { if (signal?.aborted) throw cancelled(); };
  const token = scope => { const key = scope ?? null; if (!scopes.has(key)) scopes.set(key, `o${scopes.size}`); return scopes.get(key); };
  // Legacy disposal remains synchronous. Its once-only lease records are
  // shared with the strict asynchronous barrier; returned promises are real
  // owned work, never evidence that cleanup already completed.
  const dispose = () => {
    // A candidate may delegate plan.dispose while its own async disposer still
    // uses the plan. Presenter-owned leases wait for that last-use fence.
    if (releaseAfter && !releaseAfter.ready) return [];
    const errors = [];
    for (const lease of leases.splice(0)) try {
      const result = lease.release?.();
      if (result && typeof result.then === 'function') {
        const drain = Promise.resolve(result).catch(error => { releaseErrors.push(cleanupMessage(error)); throw error; });
        drain.catch(() => {}); releaseDrains.push(drain);
      }
    } catch (error) { const message = cleanupMessage(error); errors.push(message); releaseErrors.push(message); }
    return errors;
  };
  const disposeAsync = () => {
    if (!releasePromise) releasePromise = Promise.resolve(releaseAfter?.promise).then(async () => {
      dispose();
      await Promise.allSettled(releaseDrains);
      if (releaseErrors.length) {
        const error = new DomViewError('ERR_RENDER', 'DOM resource lease cleanup failed');
        error.cleanupErrors = [...new Set(releaseErrors)]; throw error;
      }
    });
    releasePromise.catch(() => {}); return releasePromise;
  };
  async function resourceUrl(owner, reference, media = false) {
    check(); const path = resolvePath(owner, reference), resource = tables.resources.get(path);
    if (!resource || !(media ? mediaMimes : imageMimes).has(resource.mime)) unsupported(`undeclared or unsupported ${media ? 'media' : 'image'} resource ${path}`);
    if (urls.has(path)) return urls.get(path);
    if (resource.size > 16 * 1024 * 1024 || urls.size >= 1024) fail('DOM resource budget exceeded');
    if (typeof resolveResource !== 'function') unsupported('content-addressed DOM resource resolver');
    const lease = await resolveResource(Object.freeze({ ...resource }), Object.freeze({ sessionId: document.sessionId, pageId: document.pageId, revision: document.revision, presentationKey: resourceKey, signal }));
    if (record(lease)) leases.push(lease);
    check(); const url = typeof lease === 'string' ? lease : lease?.url;
    if (!nonempty(url) || /[\x00-\x20"<>]/.test(url) || !/^(?:blob:|https?:\/\/|\/(?!\/)|data:image\/(?:png|jpeg|webp|gif);base64,)/.test(url)) fail('resolver returned an invalid image URL');
    urls.set(path, url); return url;
  }
  async function declarations(entries, owner) {
    if (!Array.isArray(entries)) fail('invalid WXSS declarations');
    const output = [];
    for (const declaration of entries) {
      if (!record(declaration) || !/^(?:--[\w-]+|-?[a-z][a-z0-9-]*)$/i.test(declaration.property) || typeof declaration.value !== 'string' || typeof declaration.important !== 'boolean') fail('invalid WXSS declaration');
      if (/^(?:animation|transition)(?:-|$)|^(?:behavior|-moz-binding)$/i.test(declaration.property)) unsupported(`CSS ${declaration.property}`);
      const value = await cssValue(declaration.value, viewport, resourceUrl, owner);
      if (!supports(declaration.property, value)) unsupported(`CSS ${declaration.property}: ${value}`);
      output.push(`${declaration.property}:${value}${declaration.important ? '!important' : ''};`);
    }
    return output.join('');
  }
  async function inline(value, owner) {
    if (!value) return '';
    const entries = splitCss(scalar(value, 'style'), c => c === ';').filter(part => part !== ';' && part.trim());
    return declarations(entries.map(entry => {
      const parts = splitCss(entry, c => c === ':'), at = parts.indexOf(':');
      if (at < 0) fail('invalid inline style');
      const raw = parts.slice(at + 1).join('').trim(), important = /!important\s*$/i.test(raw);
      return { property: parts.slice(0, at).join('').trim(), value: raw.replace(/!important\s*$/i, '').trim(), important };
    }), owner);
  }
  const allElements = new Map();
  async function nodes(input) {
    const output = [];
    for (const node of input) {
      check();
      if (node.kind === 'text') { output.push({ ...node }); continue; }
      const builtin = builtins.has(node.tag), known = new Set(['id', 'class', 'style', 'hidden', 'aria-label', 'role', 'tabindex']);
      const extra = tagAttributes.get(node.tag) ?? [];
      const consumedAttributes = new Set();
      for (const name of Object.keys({ ...node.attrs, ...node.typedAttrs })) {
        if (evaluatedStructuralAttributes.has(name)) { consumedAttributes.add(name); continue; }
        if (/^wx:/i.test(name)) unsupported(`${node.tag} attribute ${name}`);
        if (name === 'animation') {
          if (!animationOccurrences.has(node.occurrenceId)) unsupported(`${node.tag} attribute ${name} has no matching consumed animation metadata`);
          if (!own(node.typedAttrs ?? {}, name)) unsupported('animation requires a typed evaluator binding');
          consumedAttributes.add(name);
          continue;
        }
        if (/^data-wc-/i.test(name)) unsupported('reserved presenter attribute');
        if (known.has(name) || extra.includes(name) || /^(?:data-|mark[:\-]|aria-)/.test(name) || /^(?:capture-)?(?:bind|catch)(?::|[\w])/.test(name)) continue;
        if (!builtin && !/^(?:wx:|on|data-wc-)/i.test(name)) continue; // component props remain data, never DOM attributes
        unsupported(`${node.tag} attribute ${name}`);
      }
      // Component properties are runtime data, even when their names overlap
      // native control attributes. Project only the adapter for this exact tag.
      const domAttributes = {};
      for (const name of nativeAttributes.get(node.tag) ?? []) {
        const value = attr(node, name); if (value != null) domAttributes[name] = scalar(value, name);
      }
      const planned = { ...node, domAttributes, domTag: domTag(node.tag), scopeToken: token(node.ownership.eventOwner), inlineStyle: await inline(attr(node, 'style'), node.ownership.documentId) };
      // Keep consumed runtime data out of the browser projection altogether.
      // The source document remains intact for runtime identity/event facts.
      if (consumedAttributes.size) {
        planned.attrs = { ...node.attrs }; planned.typedAttrs = { ...node.typedAttrs };
        for (const name of consumedAttributes) { delete planned.attrs[name]; delete planned.typedAttrs[name]; }
      }
      if (node.tag === 'image') {
        const mode = scalar(attr(node, 'mode') ?? 'scaleToFill', 'mode');
        if (!['scaleToFill', 'aspectFit', 'aspectFill'].includes(mode)) unsupported(`image mode ${mode}`);
        planned.imageMode = mode;
        const src = attr(node, 'src'); if (src != null && src !== '') planned.imageUrl = await resourceUrl(node.ownership.documentId, scalar(src, 'src'));
      }
      if (node.tag === 'camera' || node.tag === 'video') {
        const src = attr(node, 'src');
        planned.nativeComponent = { type: node.tag, nodeId: node.occurrenceId, publicId: scalar(attr(node,'id'), 'id'),
          devicePosition: scalar(attr(node,'device-position') ?? 'back','device-position'),
          flash: scalar(attr(node,'flash') ?? 'auto','flash'), muted: truth(attr(node,'muted')),
          loop: truth(attr(node,'loop')), controls: attr(node,'controls') === undefined || truth(attr(node,'controls')),
          autoplay: truth(attr(node,'autoplay')), initialTime: Number(attr(node,'initial-time') || 0),
          objectFit: scalar(attr(node,'object-fit') ?? 'contain','object-fit'),
          ...(node.tag === 'video' && src ? { resolvedSrc: await resourceUrl(node.ownership.documentId, scalar(src,'src'), true) } : {}) };
      }
      if (textControls.has(node.tag)) { planned.textControl = domTextControlState(node); if (node.tag === 'input') planned.inputType = planned.textControl.type; }
      if (node.tag === 'button') planned.button = buttonState(node);
      allElements.set(node.occurrenceId, planned);
      planned.children = await nodes(node.children); output.push(planned);
    }
    return output;
  }
  async function sheetCss(id, scope, active = []) {
    check(); if (active.length >= 128 || active.includes(id)) fail('WXSS import cycle or depth limit');
    const sheet = tables.sheets.get(JSON.stringify([id, scope ?? null]));
    if (!sheet) unsupported(`unavailable scoped stylesheet ${id}`);
    const ir = sheet.ir;
    if (!record(ir) || ![1, 2].includes(ir.version) || !Array.isArray(ir.imports) || !Array.isArray(ir.rules) || (ir.version === 2 && ir.imports.length)) fail('invalid WXSS IR');
    const owner = id.slice(6), chain = [...active, id];
    async function imported(prelude) {
      const [reference, condition] = importPrelude(prelude), target = `style:${resolvePath(owner, reference)}`;
      const css = await sheetCss(target, scope, chain);
      return condition ? `@media ${await cssValue(condition, viewport, resourceUrl, owner)}{${css}}` : css;
    }
    async function rules(values, depth = 0) {
      if (!Array.isArray(values) || depth > 128) fail('invalid WXSS rule graph');
      let output = '', importsOpen = depth === 0;
      for (const rule of values) {
        if (!record(rule) || !Array.isArray(rule.selectors) || !Array.isArray(rule.declarations) || !Array.isArray(rule.nested)) fail('invalid WXSS rule');
        if (rule.atRule != null) {
          const match = rule.atRule.match(/^@(\w[\w-]*)\s*(.*)$/s); if (!match) fail('invalid at-rule');
          const kind = match[1].toLowerCase(), argument = match[2];
          if (kind === 'import') { if (!importsOpen || rule.nested.length || rule.declarations.length || rule.selectors.length) unsupported('late or nested WXSS import'); output += await imported(argument); }
          else if (kind === 'charset' && importsOpen && /^['"]utf-8['"]$/i.test(argument)) { /* already decoded UTF-8 */ }
          else if (['media', 'supports'].includes(kind)) {
            importsOpen = false;
            if (rule.declarations.length || rule.selectors.length) fail('invalid conditional WXSS group');
            output += `@${kind} ${await cssValue(argument, viewport, resourceUrl, owner)}{${await rules(rule.nested, depth + 1)}}`;
          } else unsupported(`WXSS @${kind}`);
        } else {
          importsOpen = false;
          if (rule.nested.length || !rule.selectors.length) unsupported('CSS nesting or empty selector');
          const selector = rule.selectors.map(value => scopeDomSelector(value, token(scope))).join(','); validateSelector(selector);
          output += `${selector}{${await declarations(rule.declarations, owner)}}`;
        }
      }
      return output;
    }
    let css = ''; for (const prelude of ir.imports) css += await imported(prelude);
    css += await rules(ir.rules);
    cssBytes += css.length; if (cssBytes > 4 * 1024 * 1024) fail('expanded DOM stylesheet budget exceeded');
    return css;
  }
  try {
    const plannedNodes = await nodes(document.nodes); let css = '';
    for (const root of document.styleRoots) {
      for (const sheet of document.styles.filter(sheet => sheet.id === root)) css += await sheetCss(root, sheet.scopeId);
    }
    check();
    return { document, viewport: { ...viewport }, nodes: plannedNodes, tables, allElements, css, urls: [...urls.values()], dispose, disposeAsync };
  } catch (error) {
    const errors = dispose(); if (errors.length) error.cleanupErrors = errors;
    error.cleanupDrain = disposeAsync();
    throw error;
  }
}

function dataset(node, prefix = 'data-') {
  return Object.fromEntries(Object.keys({ ...node.attrs, ...node.typedAttrs }).filter(key => key.startsWith(prefix))
    .map(key => [key.slice(prefix.length).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), clone(attr(node, key))]));
}
function targetInfo(node) { return { occurrenceId: node.occurrenceId, id: scalar(attr(node, 'id'), 'id'), dataset: dataset(node), ownerScopeId: node.ownership.eventOwner ?? null }; }
function buttonOnPath(tables, targetOccurrenceId, predicate = () => true) {
  let entry = tables.nodes.get(targetOccurrenceId);
  while (entry) {
    if (entry.node.kind === 'element' && entry.node.tag === 'button' && predicate(entry.node)) return entry.node;
    entry = tables.nodes.get(entry.parent);
  }
  return null;
}
/** Local listener/catch plan only. Runtime input never trusts this plan's
 * handler names, ownership, propagation path or dataset projection. */
export function planDomEvent(document, targetOccurrenceId, type, detail = {}, tables = validateDomViewDocument(document)) {
  if (!supportedEvents.has(type)) unsupported(`event ${type}`);
  const { nodes } = tables, path = [];
  let entry = nodes.get(targetOccurrenceId);
  if (!entry || entry.node.kind !== 'element') fail('event target is not a live element');
  const target = targetInfo(entry.node);
  if (textControls.has(entry.node.tag) && truth(attr(entry.node, 'disabled'))) {
    return { type, targetOccurrenceId, target, detail: clone(detail), listeners: [], caught: false, disabled: true };
  }
  while (entry) { if (entry.node.kind === 'element') path.push(entry.node); entry = nodes.get(entry.parent); }
  if (buttonInteractions.has(type) && path.some(node => node.tag === 'button' && truth(attr(node, 'disabled')))) {
    return { type, targetOccurrenceId, target, detail: clone(detail), listeners: [], caught: false, disabled: true };
  }
  const listeners = []; let caught = false;
  for (const [phase, order] of [['capture', [...path].reverse()], ['bubble', path]]) {
    for (const node of order) {
      const binding = node.events.find(binding => binding.phase === phase && binding.event === type);
      if (!binding) continue;
      listeners.push({ ...binding, currentTarget: targetInfo(node), ownerScopeId: node.ownership.eventOwner ?? null });
      if (binding.catch) { caught = true; break; }
    }
    if (caught) break;
  }
  return { type, targetOccurrenceId, target, detail: clone(detail), listeners, caught };
}

// Zero-specificity button defaults let authored WXSS and inline declarations
// override every visual choice. Native type/disabled semantics stay separate.
const baseCss = `html,body{margin:0;padding:0;width:100%;height:100%;font-size:16px;}body{overflow:hidden;}wx-page{display:block;min-height:100%;}wx-view,wx-scroll-view,wx-component{display:block;}wx-text{display:inline;white-space:pre-wrap;}img{display:inline-block;width:320px;height:240px;vertical-align:middle;}input,textarea{display:block;box-sizing:border-box;padding:0;border:0;background:transparent;color:inherit;font:inherit;outline:0;}input{height:1.4em;}textarea{resize:none;}
:where(button[data-wc-tag="button"]){appearance:none;box-sizing:border-box;display:block;width:100%;min-height:46px;margin:0 auto;padding:0 14px;border:1px solid #ddd;border-radius:5px;background:#f8f8f8;color:#000;font:inherit;font-size:18px;line-height:2.5;text-align:center;cursor:pointer;}
:where(button[data-wc-button-type="primary"]){background:#07c160;border-color:#07c160;color:#fff;}
:where(button[data-wc-button-type="warn"]){background:#fa5151;border-color:#fa5151;color:#fff;}
:where(button[data-wc-button-size="mini"]){display:inline-block;width:auto;min-height:32px;font-size:14px;line-height:2.2;}
:where(button[data-wc-button-plain="true"]){background:transparent;border-color:currentColor;color:#000;}
:where(button[data-wc-button-plain="true"][data-wc-button-type="primary"]){color:#07c160;}
:where(button[data-wc-button-plain="true"][data-wc-button-type="warn"]){color:#fa5151;}
:where(button[data-wc-tag="button"]:disabled){opacity:.5;cursor:default;}
:where(button[data-wc-tag="button"]:focus-visible){outline:2px solid currentColor;outline-offset:2px;}
:where(button[data-wc-button-loading="true"])::before{content:"";display:inline-block;width:.8em;height:.8em;margin-right:.4em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;vertical-align:-.1em;animation:wc-dom-button-spin .8s linear infinite;}
@keyframes wc-dom-button-spin{to{transform:rotate(360deg);}}
@media(prefers-reduced-motion:reduce){:where(button[data-wc-button-loading="true"])::before{animation:none;}}
[hidden]{display:none!important;}`;

// Shared by the iframe and persistent-Document presenters so native controls
// and mini-program tags have the same baseline layout in either protocol.
export const DOM_BASE_CSS = baseCss;

async function aborted(promise, signal) {
  if (signal.aborted) throw cancelled();
  let listener;
  try { return await Promise.race([promise, new Promise((_, reject) => { listener = () => reject(cancelled()); signal.addEventListener('abort', listener, { once: true }); })]); }
  finally { signal.removeEventListener('abort', listener); }
}

/** Presentation correlation is separate from the unchanged ViewDocument v1.
 * Wire integers are decimal strings, including values beyond JS safe integers. */
export function validateDomPresentationKey(key, document) {
  exact(key, ['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile'], 'presentation key');
  if (!nonempty(key.sessionId) || key.profile !== 'webview'
    || !['pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration'].every(field => decimal(key[field]))) fail('invalid presentation key');
  if (document && (key.sessionId !== document.sessionId || key.pageId !== String(document.pageId)
    || key.documentRevision !== String(document.revision) || key.profile !== document.profile)) fail('presentation key does not identify ViewDocument');
  return key;
}
const sameKey = (a, b) => a && b && ['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile'].every(field => a[field] === b[field]);
function geometryNodes(measured) {
  if (!Array.isArray(measured)) fail('invalid browser geometry');
  const seen = new Set();
  return measured.map(value => {
    const box = value.borderBox ?? { x: value.x, y: value.y, width: value.width, height: value.height };
    const offset = value.scrollOffset ?? { x: value.scrollLeft ?? 0, y: value.scrollTop ?? 0 };
    const extent = value.scrollExtent ?? { width: value.scrollWidth ?? box.width, height: value.scrollHeight ?? box.height };
    const size = value.clientSize ?? { width: value.clientWidth ?? box.width, height: value.clientHeight ?? box.height };
    if (!nonempty(value.occurrenceId) || seen.has(value.occurrenceId)
      || ![box.x, box.y, box.width, box.height, offset.x, offset.y, extent.width, extent.height, size.width, size.height].every(Number.isFinite)
      || [box.width, box.height, extent.width, extent.height, size.width, size.height].some(number => number < 0)) fail('invalid browser geometry node');
    seen.add(value.occurrenceId);
    return { occurrenceId: value.occurrenceId, borderBox: { ...box }, scrollOffset: { ...offset }, scrollExtent: { ...extent }, clientSize: { ...size } };
  });
}
const legacyGeometry = nodes => nodes.map(node => ({ occurrenceId: node.occurrenceId, ...node.borderBox, scrollLeft: node.scrollOffset.x, scrollTop: node.scrollOffset.y,
  scrollWidth: node.scrollExtent.width, scrollHeight: node.scrollExtent.height, clientWidth: node.clientSize.width, clientHeight: node.clientSize.height }));

const touchFields = ['identifier', 'x', 'y', 'clientX', 'clientY', 'pageX', 'pageY'];
/** Validate facts independently from the local listener plan. These are browser
 * measurements; the runtime still derives target ownership and dispatch. */
export function validateDomInputFacts(facts) {
  exact(facts, ['timeStamp', 'touches', 'changedTouches'], 'input facts');
  if (!Number.isFinite(facts.timeStamp)) fail('input timeStamp must be finite');
  const output = { timeStamp: facts.timeStamp };
  for (const field of ['touches', 'changedTouches']) if (own(facts, field)) {
    if (!Array.isArray(facts[field]) || facts[field].length > 1024) fail(`invalid input ${field}`);
    const seen = new Set();
    output[field] = facts[field].map(touch => {
      exact(touch, touchFields, 'touch facts');
      if (!Number.isSafeInteger(touch.identifier) || !touchFields.every(key => Number.isFinite(touch[key])) || seen.has(touch.identifier)) fail('invalid touch facts');
      seen.add(touch.identifier);
      return Object.fromEntries(touchFields.map(key => [key, touch[key]]));
    });
  }
  return output;
}

/** One registry per candidate. Freezing or retiring that candidate clears the
 * registry; resumed pointermove/up cannot resurrect a pre-freeze contact. */
export class DomPointerContacts {
  constructor() { this.contacts = new Map(); }
  clear() { this.contacts.clear(); }
  update(type, event) {
    const timeStamp = event.timeStamp ?? 0;
    if (!touchEvents.has(type)) return validateDomInputFacts({ timeStamp });
    const touch = { identifier: event.pointerId, x: event.clientX, y: event.clientY, clientX: event.clientX, clientY: event.clientY,
      pageX: event.pageX ?? event.clientX, pageY: event.pageY ?? event.clientY };
    validateDomInputFacts({ timeStamp, changedTouches: [touch] });
    if (type !== 'touchstart' && !this.contacts.has(touch.identifier)) return null;
    if (type === 'touchstart' && this.contacts.has(touch.identifier)) fail('duplicate active pointer');
    if (type === 'touchstart' && this.contacts.size >= 1024) fail('active pointer budget exceeded');
    if (type === 'touchend' || type === 'touchcancel') this.contacts.delete(touch.identifier);
    else this.contacts.set(touch.identifier, touch);
    return validateDomInputFacts({ timeStamp, touches: [...this.contacts.values()], changedTouches: [touch] });
  }
}

const candidateReleaseContract = Object.freeze({
  version: '1.0', exactHandle: true, pendingAcquisitions: true,
  asynchronousDisposal: true, asynchronousConfirmation: true, asynchronousShutdown: true,
});
// Worker owners negotiate this separately from generic strict release 1.0.
// A guard stays attached to the confirmed entry and is checked synchronously at
// activation and every subsequent event/geometry ingress until retirement.
const inputGuardContract = Object.freeze({ version: '1.0', synchronous: true, durable: true });
const releaseOwners = new WeakMap();
const cleanupMessage = value => { try { return value instanceof Error ? value.message : String(value); } catch { return 'DOM cleanup failure could not be serialized'; } };
function cleanupFailure(entry, failure) {
  const values = Array.isArray(failure?.cleanupErrors) && failure.cleanupErrors.length ? failure.cleanupErrors : [failure];
  for (const value of values) {
    const message = cleanupMessage(value);
    if (!entry.cleanupErrors.includes(message)) {
      entry.cleanupErrors.push(message);
      try { entry.reportCleanup?.(new DomViewError('ERR_RENDER', message)); } catch { entry.cleanupErrors.push('DOM cleanup diagnostic delivery failed'); }
    }
  }
}
function ownDrain(entry, promise) {
  const drain = Promise.resolve(promise).catch(failure => { cleanupFailure(entry, failure); throw failure; });
  // The original rejecting promise stays in the exact handle's real drain.
  // This observer only prevents an unhandled rejection before release starts.
  drain.catch(() => {}); entry.drains.push(drain); return drain;
}
function asyncResourceDrain(entry, resource, after = Promise.resolve()) {
  let disposeAsync;
  try { disposeAsync = resource?.disposeAsync; } catch (failure) { return ownDrain(entry, Promise.reject(failure)); }
  if (typeof disposeAsync !== 'function') return Promise.resolve();
  const previous = entry.asyncResources.get(resource); if (previous) return previous;
  // A candidate with an asynchronous disposer may still use its plan until
  // that disposer settles. Do not revoke plan leases before its last local use.
  const drain = ownDrain(entry, Promise.resolve(after).then(() => disposeAsync.call(resource), () => disposeAsync.call(resource)));
  entry.asyncResources.set(resource, drain); return drain;
}
function disposeOwned(entry, resource) {
  if (!resource) return [];
  const previous = entry.disposedResources.get(resource);
  if (previous) return previous.errors;
  const state = { errors: [], dispose: Promise.resolve(), done: Promise.resolve(), asynchronous: false };
  entry.disposedResources.set(resource, state);
  const resultErrors = result => {
    if (result != null && !Array.isArray(result)) throw new DomViewError('ERR_PROTOCOL_VERSION', 'DOM disposer must return an error array, a promise of one, or nothing');
    for (const failure of result ?? []) { const message = cleanupMessage(failure); state.errors.push(message); cleanupFailure(entry, message); }
  };
  try {
    const result = resource.dispose();
    if (result && typeof result.then === 'function') { state.asynchronous = true; state.dispose = ownDrain(entry, Promise.resolve(result).then(resultErrors)); }
    else resultErrors(result);
  } catch (failure) { const message = cleanupMessage(failure); state.errors.push(message); cleanupFailure(entry, failure); }
  try { state.asynchronous ||= typeof resource.disposeAsync === 'function'; } catch (failure) { state.asynchronous = true; cleanupFailure(entry, failure); }
  const asynchronous = asyncResourceDrain(entry, resource, state.dispose);
  state.done = Promise.allSettled([state.dispose, asynchronous]);
  return state.errors;
}

function acquisition(entry, promise, retireLate) {
  const original = Promise.resolve(promise);
  const drain = original.then(value => {
    if (entry.controller.signal.aborted) retireLate?.(value);
  }, failure => {
    if (Array.isArray(failure?.cleanupErrors)) cleanupFailure(entry, failure);
    if (failure?.cleanupDrain && typeof failure.cleanupDrain.then === 'function') return ownDrain(entry, failure.cleanupDrain);
  });
  ownDrain(entry, drain); return original;
}
function settleEntry(entry) {
  const actualDrain = Promise.resolve().then(async () => {
    let observed = 0;
    // Late acquisition callbacks can register the disposal of the resource they
    // just received. Drain to a fixed point, not merely one initial snapshot.
    while (observed < entry.drains.length) {
      const batch = entry.drains.slice(observed); observed = entry.drains.length;
      const settled = await Promise.allSettled(batch);
      for (const value of settled) if (value.status === 'rejected') cleanupFailure(entry, value.reason);
    }
    if (entry.cleanupErrors.length) {
      const failure = new DomViewError('ERR_RENDER', 'DOM candidate cleanup failed');
      failure.cleanupErrors = [...entry.cleanupErrors];
      failure.releaseOutcome = Object.freeze({ version: '1.0', handle: entry.handle, key: entry.key, status: 'failed', cleanupPending: false });
      throw failure;
    }
    return Object.freeze({ version: '1.0', handle: entry.handle, key: entry.key, status: 'settled', cleanupPending: false });
  });
  actualDrain.catch(() => {}); return actualDrain;
}
function releaseDeadline(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw new DomViewError('ERR_PROTOCOL_VERSION', 'invalid DOM release timeout');
}
function boundedRelease(promise, timeoutMs, identity) {
  try { releaseDeadline(timeoutMs); } catch (failure) { return Promise.reject(failure); }
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const failure = new DomViewError('ERR_TIMEOUT', 'DOM cleanup drain is still pending');
      failure.releaseOutcome = Object.freeze({ version: '1.0', ...identity, cleanupPending: true });
      reject(failure);
    }, timeoutMs);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export class DomViewPresenter {
  constructor(container, { resolveResource, onEventBatch, onGeometry, onError, timeoutMs = 5000 } = {}) {
    if (!container?.ownerDocument || typeof container.append !== 'function') fail('DOM presenter needs an owned container element');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) fail('invalid presentation deadline');
    this.container = container; this.resolveResource = resolveResource; this.onEventBatch = onEventBatch; this.onGeometry = onGeometry; this.onError = onError;
    this.samples = new WeakMap(); this.sample = null;
    this.timeoutMs = timeoutMs; this.current = null; this.currentEntry = null; this.pending = null; this.transaction = null;
    this.serial = 0; this.epoch = 0n; this.disposed = false; this.handles = new WeakMap(); this.eventQueue = []; this.flushQueued = false; this.errors = [];
    releaseOwners.set(this, { handles: new WeakMap(), entries: new Set(), failures: [], shutdown: null });
  }
  report(error) {
    this.errors.push(error.toJSON?.() ?? { code: 'ERR_RENDER', message: String(error) });
    try { this.onError?.(error); } catch (callbackError) { this.errors.push({ code: 'ERR_RENDER', message: `diagnostic callback failed: ${callbackError}` }); }
  }
  nextEpoch() { if (this.epoch >= 18446744073709551615n) fail('geometry epoch exhausted'); return String(++this.epoch); }
  connected(entry) { return entry.candidate?.isConnected?.() !== false; }
  available(entry) { return !this.disposed && !entry.controller.signal.aborted && (entry.state === 'confirmed' || entry.serial === this.serial) && entry.isCurrent() && this.connected(entry); }
  inputAllowed(entry) {
    if (!entry?.inputGuard) return true;
    try {
      const allowed = entry.inputGuard();
      if (typeof allowed !== 'boolean') throw new DomViewError('ERR_PROTOCOL_VERSION', 'DOM input guard must return a synchronous boolean');
      return allowed;
    } catch (failure) { this.report(failure); return false; }
  }
  interactive(entry) { return entry && entry.inputEnabled && this.inputAllowed(entry) && entry === this.currentEntry && entry.state === 'confirmed' && !this.pending && !this.transaction && !this.sample && this.available(entry); }
  controlDone(entry) { clearTimeout(entry.timeout); entry.signal?.removeEventListener('abort', entry.externalAbort); }
  cleanup(entry) {
    if (entry.populating && !entry.populationSettled) {
      // Stop the owned browser continuation, including its RAF handle. Unknown
      // candidates that ignore cancellation keep the real drain pending; their
      // resources cannot be revoked while populate still has last use.
      try { entry.candidate?.cancel?.(); this.surface(entry, false, false); }
      catch (failure) { cleanupFailure(entry, failure); }
      if (!entry.populationCleanup) entry.populationCleanup = ownDrain(entry,
        entry.populating.then(() => this.cleanup(entry), () => this.cleanup(entry)));
      this.watchCleanup(entry); return [];
    }
    const errors = [...disposeOwned(entry, entry.candidate ?? entry.plan)];
    const candidateDisposal = entry.candidate && entry.disposedResources.get(entry.candidate);
    const releasePlan = () => {
      entry.releaseLeases();
      // The plan's synchronous delegate may previously have been fenced. Its
      // actual once-only release begins only after all candidate last use ends.
      return entry.plan && entry.candidate ? disposeOwned(entry, entry.plan) : [];
    };
    if (candidateDisposal?.asynchronous) {
      if (!entry.planCleanup) entry.planCleanup = ownDrain(entry, candidateDisposal.done.then(releasePlan));
    } else errors.push(...releasePlan());
    this.watchCleanup(entry); return errors;
  }
  watchCleanup(entry) {
    if (entry.cleanupWatch) return entry.cleanupWatch;
    const owner = releaseOwners.get(this);
    entry.cleanupWatch = settleEntry(entry).then(() => { owner.entries.delete(entry); }, failure => {
      owner.entries.delete(entry); owner.failures.push(failure); throw failure;
    });
    entry.cleanupWatch.catch(() => {}); return entry.cleanupWatch;
  }
  candidateReleaseContract() { return candidateReleaseContract; }
  inputGuardContract() { return inputGuardContract; }
  exactReleaseEntry(handle) {
    const entry = releaseOwners.get(this)?.handles.get(handle);
    if (!entry || entry.handle !== handle) throw new DomViewError('ERR_PROTOCOL_VERSION', 'DOM release requires the exact owned candidate handle');
    return entry;
  }
  // This is the actual unbounded operation/resource drain, even after a bounded
  // release times out. A timeout can never be upgraded to cleanup success.
  drainCandidate(handle) {
    let entry; try { entry = this.exactReleaseEntry(handle); } catch (failure) { return Promise.reject(failure); }
    return settleEntry(entry);
  }
  releaseCandidate(handle, { resumePrevious = false, timeoutMs = this.timeoutMs } = {}) {
    if (this.samples.has(handle)) return this.releaseSample(handle);
    let entry; try {
      entry = this.exactReleaseEntry(handle); releaseDeadline(timeoutMs);
      if (typeof resumePrevious !== 'boolean') throw new DomViewError('ERR_PROTOCOL_VERSION', 'resumePrevious must be boolean');
    } catch (failure) { return Promise.reject(failure); }
    if (entry.releasePromise) return entry.releasePromise;
    let resolve, reject;
    entry.releasePromise = new Promise((yes, no) => { resolve = yes; reject = no; });
    entry.releasePromise.catch(() => {});
    const retained = entry.state === 'confirmed';
    if (!retained) try { this.abort(handle, { resumePrevious }); } catch (failure) { cleanupFailure(entry, failure); }
    boundedRelease(settleEntry(entry), timeoutMs, { handle, key: entry.key }).then(() =>
      Object.freeze({ version: '1.0', handle, key: entry.key, status: retained ? 'retained' : 'released', cleanupPending: false })).then(resolve, reject);
    return entry.releasePromise;
  }
  surface(entry, visible, interactive = false) { if (entry) { entry.inputEnabled = interactive; entry.candidate?.setInteractive?.(interactive); entry.candidate?.setVisible?.(visible); } }
  async prepare(document, { viewport, presentationKey, signal, isCurrent = () => true, resumePreviousOnAbort = true, releaseMode = 'legacy', animation, bindAnimation } = {}) {
    if (this.disposed) throw cancelled();
    if (this.sample) throw cancelled();
    animation = copyAnimationRequest(animation);
    if (animation && typeof bindAnimation !== 'function') fail('animation baseline binding is required');
    if (typeof resumePreviousOnAbort !== 'boolean') fail('resumePreviousOnAbort must be boolean');
    if (!['legacy', 'strict'].includes(releaseMode)) throw new DomViewError('ERR_PROTOCOL_VERSION', 'invalid DOM candidate release mode');
    validateDomViewDocument(document);
    document = clone(document);
    const key = freeze(clone(validateDomPresentationKey(presentationKey, document)));
    const acceptedEntry = this.transaction ? (this.transaction.previousRetired ? null : this.transaction.previous) : this.currentEntry;
    const accepted = acceptedEntry?.key;
    if (accepted?.sessionId === key.sessionId && (BigInt(key.surfaceGeneration) < BigInt(accepted.surfaceGeneration)
      || BigInt(key.presentationRevision) < BigInt(accepted.presentationRevision)
      || (accepted.pageId === key.pageId && BigInt(key.documentRevision) < BigInt(accepted.documentRevision)))) throw cancelled();
    if (this.pending) this.abort(this.pending.handle);
    if (this.transaction) this.abort(this.transaction.handle);
    const controller = new AbortController();
    let releaseLeases;
    const releaseAfter = { ready: false, promise: new Promise(resolve => { releaseLeases = resolve; }) };
    const entry = { releaseAfter, releaseLeases: () => { if (!releaseAfter.ready) { releaseAfter.ready = true; releaseLeases(); } }, key, controller, serial: ++this.serial, state: 'preparing', isCurrent, signal, resumePreviousOnAbort, candidate: null, plan: null, geometryQueued: false, geometryForce: false, geometryInFlight: null, geometryPending: null, geometryBarrier: Promise.resolve(), drains: [], cleanupErrors: [], disposedResources: new WeakMap(), asyncResources: new WeakMap(), releaseMode, reportCleanup: failure => this.report(failure) };
    const handle = { get preparation() { return entry.preparation; }, get state() { return entry.state; }, abort: options => this.abort(handle, options) };
    entry.handle = Object.freeze(handle); this.handles.set(handle, entry); this.pending = entry;
    releaseOwners.get(this).handles.set(handle, entry); releaseOwners.get(this).entries.add(entry);
    try {
      this.eventQueue.length = 0;
      entry.externalAbort = () => { try { this.abort(handle); } catch (failure) { cleanupFailure(entry, failure); } }; signal?.addEventListener('abort', entry.externalAbort, { once: true });
      entry.timeout = setTimeout(entry.externalAbort, this.timeoutMs);
      if (signal?.aborted) { this.abort(handle); throw cancelled(); }
      const previousState = accepted?.sessionId === key.sessionId && accepted.pageId === key.pageId ? acceptedEntry.candidate.snapshot() : undefined;
      this.surface(this.currentEntry, true, false);
      const creating = acquisition(entry, this.createCandidate(viewport, controller.signal), candidate => {
        if (entry.candidate !== candidate) disposeOwned(entry, candidate);
      });
      entry.candidate = await aborted(creating, controller.signal);
      if (!this.available(entry)) throw cancelled();
      const preparing = acquisition(entry, prepareDomDocument(document, viewport, { resolveResource: this.resolveResource, supports: entry.candidate.supports, validateSelector: entry.candidate.validateSelector, signal: controller.signal, presentationKey: key, releaseAfter, animation }), plan => {
        if (entry.plan !== plan) disposeOwned(entry, plan);
      });
      entry.plan = await aborted(preparing, controller.signal);
      entry.candidate.plan = entry.plan;
      entry.populationSettled = false;
      entry.populating = acquisition(entry, entry.candidate.populate(entry.plan));
      entry.populating.then(() => { entry.populationSettled = true; }, () => { entry.populationSettled = true; });
      await aborted(entry.populating, controller.signal);
      if (!this.available(entry)) throw cancelled();
      entry.candidate.restore(previousState);
      if (animation) {
        if (typeof entry.candidate.animationBaselines !== 'function' || typeof entry.candidate.stageAnimation !== 'function') fail('DOM candidate does not support typed animation samples');
        // Previous sampled properties establish the actual hidden inheritance
        // context before any newly discovered property is observed.
        const provisional = entry.candidate.stageAnimation(animation.styles, () => this.available(entry));
        provisional.apply(); provisional.acknowledge();
        const baseline = freeze({ version: '1.0', requestId: animation.requestId, key, epoch: this.nextEpoch(),
          values: entry.candidate.animationBaselines(animation.baselines) });
        const bound = await aborted(Promise.resolve(bindAnimation(baseline)), controller.signal);
        if (!this.available(entry)) throw cancelled();
        exact(bound, ['version', 'requestId', 'key', 'styles'], 'animation baseline response');
        validateDomPresentationKey(bound.key);
        if (bound.version !== '1.0' || bound.requestId !== animation.requestId || !sameKey(bound.key, key)) fail('animation baseline response identifies another candidate');
        const styles = copyAnimationStyles(bound.styles, animation.baselines.map(item => item.occurrenceId));
        const journal = entry.candidate.stageAnimation(styles, () => this.available(entry));
        journal.apply(); journal.acknowledge();
      }
      entry.preparation = freeze({ version: '1.0', key, epoch: this.nextEpoch(), viewport: { ...viewport }, nodes: geometryNodes(entry.candidate.measure()) });
      if (!this.available(entry)) throw cancelled();
      entry.geometry = entry.preparation; entry.state = 'prepared';
      return handle;
    } catch (error) {
      try { this.abort(handle); } catch (cleanup) { cleanupFailure(entry, cleanup); }
      const failure = error instanceof DomViewError ? error : new DomViewError('ERR_RENDER', error?.message ?? String(error));
      if (releaseMode === 'strict') try { await this.releaseCandidate(handle); }
      catch (cleanup) { failure.cleanupErrors = [...(failure.cleanupErrors ?? []), cleanup]; failure.cleanupDrain = this.drainCandidate(handle); }
      throw failure;
    }
  }
  /** Samples retain the accepted topology, iframe and all resource leases. */
  prepareSample(submission, permit, { isCurrent = () => true } = {}) {
    const base = this.currentEntry;
    if (this.disposed || this.sample || this.pending || this.transaction || base?.state !== 'confirmed'
      || !sameAnimationKey(base.key, submission.baseKey) || !this.available(base)
      || typeof base.candidate.stageAnimation !== 'function') throw cancelled();
    const sample = { key: submission.key, submission, permit, base, isCurrent, state: 'prepared' };
    const handle = Object.freeze({ get preparation() { return sample.geometry; }, get state() { return sample.state; } });
    sample.handle = handle;
    sample.journal = base.candidate.stageAnimation(submission.styles, () => this.sample === sample && this.currentEntry === base
      && base.state === 'confirmed' && this.available(base) && isCurrent());
    this.samples.set(handle, sample); this.sample = sample; this.suspendInput();
    return handle;
  }
  commitSample(handle) {
    const sample = this.samples.get(handle), base = sample?.base;
    if (!sample || this.sample !== sample || sample.state !== 'prepared' || this.currentEntry !== base || !sample.isCurrent()) throw cancelled();
    try {
      sample.journal.apply();
      sample.geometry = freeze({ version: '1.0', key: sample.key, epoch: this.nextEpoch(), viewport: { ...sample.submission.viewport },
        nodes: geometryNodes(base.candidate.measure()) });
      if (!sample.isCurrent() || this.currentEntry !== base || !this.available(base)) throw cancelled();
      sample.state = 'committed'; return sample.geometry;
    } catch (failure) {
      try { sample.journal.rollback(); } catch (cleanup) { failure.cleanupErrors = [...(failure.cleanupErrors ?? []), cleanup]; }
      sample.state = 'aborted'; this.sample = null; throw failure;
    }
  }
  acknowledgeSample(handle) {
    const sample = this.samples.get(handle), base = sample?.base;
    if (!sample || sample.state !== 'confirmed' && (this.sample !== sample || sample.state !== 'committed')) fail('sample acknowledgement requires the exact committed sample');
    if (sample.state === 'confirmed') return;
    // No input guard, DOM activation or user callback may precede this claim.
    // It remains irreversible even when local activation subsequently fails.
    sample.journal.acknowledge(); sample.state = 'confirmed'; this.sample = null;
    base.key = sample.key; base.preparation = sample.geometry; base.geometry = sample.geometry; base.geometryAdmitted = sample.geometry;
    base.receipt = freeze({ ...sample.geometry, phase: 'committed', permitId: sample.permit.permitId, commitId: `dom-sample-${sample.key.presentationRevision}` });
  }
  confirmSample(handle, { inputEnabled = false, inputGuard = () => true } = {}) {
    if (typeof inputEnabled !== 'boolean' || typeof inputGuard !== 'function') fail('sample confirmation requires a boolean input outcome and guard');
    this.acknowledgeSample(handle);
    const sample = this.samples.get(handle), base = sample.base;
    base.inputGuard = inputGuard;
    const enabled = inputEnabled && this.currentEntry === base && this.available(base) && this.inputAllowed(base);
    try { this.surface(base, true, enabled); }
    catch (failure) { this.suspendInput(); throw failure; }
    return Object.freeze({ version: '1.0', handle, key: sample.key, inputEnabled: enabled, cleanupPending: false });
  }
  releaseSample(handle) {
    const sample = this.samples.get(handle);
    if (!sample) return Promise.reject(new DomViewError('ERR_PROTOCOL_VERSION', 'sample release requires its exact handle'));
    if (sample.releasePromise) return sample.releasePromise;
    sample.releasePromise = Promise.resolve().then(() => {
      if (sample.state !== 'confirmed') {
        sample.journal.rollback(); sample.state = 'aborted';
        if (this.sample === sample) this.sample = null;
      }
      return Object.freeze({ version: '1.0', handle, key: sample.key, status: sample.state === 'confirmed' ? 'retained' : 'released', cleanupPending: false });
    });
    return sample.releasePromise;
  }
  commit(handle, permit) {
    const entry = this.handles.get(handle);
    if (!entry || entry !== this.pending || entry.state !== 'prepared' || !this.available(entry)) throw cancelled();
    exact(permit, ['version', 'key', 'epoch', 'permitId'], 'presentation permit');
    validateDomPresentationKey(permit.key);
    if (permit.version !== '1.0' || !nonempty(permit.permitId) || !sameKey(permit.key, entry.key) || permit.epoch !== entry.preparation.epoch) fail('presentation permit does not identify prepared geometry');
    // A permit authorizes only this geometry/key. Handler names remain
    // untrusted ViewDocument data and never become capabilities here.
    if (JSON.stringify(geometryNodes(entry.candidate.measure())) !== JSON.stringify(entry.preparation.nodes)) throw new DomViewError('ERR_CANCELLED', 'prepared geometry changed before commit');
    const previous = this.currentEntry;
    try {
      entry.candidate.activate((id, type, detail, native, facts) => this.queueEvent(entry, id, type, detail, native, facts), () => this.queueGeometry(entry));
      this.surface(entry, true, false); this.surface(previous, false, false);
      if (!this.available(entry)) throw cancelled();
      entry.previous = previous; entry.state = 'committed'; this.pending = null; this.transaction = entry;
      this.currentEntry = entry; this.current = entry.candidate;
      entry.receipt = freeze({ ...entry.preparation, phase: 'committed', permitId: permit.permitId, commitId: `dom-commit-${entry.serial}` });
      return entry.receipt;
    } catch (error) { this.surface(previous, true, false); this.abort(handle); throw error; }
  }
  matchingReceipt(entry, receipt) {
    return receipt?.version === '1.0' && receipt.phase === 'committed' && sameKey(receipt.key, entry.key)
      && receipt.epoch === entry.receipt?.epoch && receipt.permitId === entry.receipt?.permitId && receipt.commitId === entry.receipt?.commitId;
  }
  holdAcknowledgement(receipt) {
    const entry = this.transaction;
    if (!entry || entry.state !== 'committed' || !this.matchingReceipt(entry, receipt)) fail('pending acknowledgement requires the exact committed receipt');
    // Once the native final is in flight, ordinary timeout/signal controls
    // cannot decide whether this committed DOM may be rolled back.
    this.controlDone(entry);
  }
  acknowledge(receipt) {
    const entry = this.transaction ?? this.currentEntry;
    if (!entry || !this.matchingReceipt(entry, receipt)
      || entry.state !== 'confirmed' && (entry !== this.transaction || entry.state !== 'committed')) fail('acknowledgement does not identify committed presentation');
    if (entry.state === 'confirmed') return entry.receipt;
    // A genuine runtime final is claimed before input/user hooks or resource
    // disposal. The old owner may have retired while the ACK was in flight.
    this.controlDone(entry); entry.acknowledged = true; entry.state = 'confirmed'; this.transaction = null;
    return entry.receipt;
  }
  confirm(receipt, { inputEnabled = true } = {}) {
    if (typeof inputEnabled !== 'boolean') fail('inputEnabled must be boolean');
    const entry = this.transaction ?? this.currentEntry;
    if (!entry || !this.matchingReceipt(entry, receipt)) fail('confirmation does not identify committed presentation');
    if (entry.confirmFailure) throw entry.confirmFailure;
    if (entry.confirmationComplete) return entry.receipt;
    if (!entry.acknowledged && (entry !== this.transaction || entry.state !== 'committed' || !this.available(entry))) throw cancelled();
    // A runtime ACK is irreversible. Retire cancellation controls and settle
    // before touching predecessor leases: their release cannot roll it back.
    this.acknowledge(receipt); entry.confirmationComplete = true;
    const previous = entry.previous;
    entry.previous = null;
    const errors = previous ? this.cleanup(previous) : [];
    entry.previousRetired = Boolean(previous);
    if (errors.length) {
      entry.confirmFailure = new DomViewError('ERR_RENDER', `previous surface cleanup failed: ${errors.join('; ')}`);
      this.report(entry.confirmFailure); throw entry.confirmFailure;
    }
    try { this.surface(entry, true, inputEnabled); }
    catch (error) { this.surface(entry, true, false); entry.confirmFailure = new DomViewError('ERR_RENDER', `surface activation failed: ${error}`); throw entry.confirmFailure; }
    this.notifyGeometry(entry, entry.geometry);
    // Restored focus can affect :focus styles and geometry synchronously.
    this.queueGeometry(entry);
    return entry.receipt;
  }
  confirmAsync(receipt, { inputEnabled = true, timeoutMs = this.timeoutMs, inputGuard = () => true } = {}) {
    let entry;
    try {
      if (typeof inputEnabled !== 'boolean' || typeof inputGuard !== 'function') fail('strict input policy must be a boolean and synchronous guard');
      releaseDeadline(timeoutMs);
      entry = this.transaction ?? this.currentEntry;
      if (!entry || receipt !== entry.receipt || !this.matchingReceipt(entry, receipt)) fail('strict confirmation requires the exact committed receipt');
      this.exactReleaseEntry(entry.handle);
    } catch (failure) { return Promise.reject(failure); }
    if (entry.confirmPromise) return entry.confirmPromise;
    if (entry.confirmationComplete) return Promise.reject(new DomViewError('ERR_PROTOCOL_VERSION', 'strict confirmation must perform the initial confirmation'));
    const previous = entry.previous;
    let resolve, reject;
    entry.confirmPromise = new Promise((yes, no) => { resolve = yes; reject = no; });
    entry.confirmPromise.catch(() => {});
    entry.inputGuard = inputGuard;
    // Claim the actual ACK synchronously, with input disabled, before an owner
    // fence can cancel controls. The Promise is already published for hooks.
    let confirmationFailure;
    try { this.confirm(receipt, { inputEnabled: false }); } catch (failure) { confirmationFailure = failure; }
    Promise.resolve().then(async () => {
      if (previous) try { await boundedRelease(settleEntry(previous), timeoutMs, { handle: previous.handle, key: previous.key }); }
      catch (failure) { confirmationFailure ??= failure; }
      if (confirmationFailure) {
        entry.confirmFailure ??= confirmationFailure;
        this.suspendInput(); throw confirmationFailure;
      }
      // A retired confirmed ACK remains retained. It is a genuine disabled
      // outcome, not a failed release. Only the latest guard can enable input.
      let enabled = inputEnabled && entry === this.currentEntry && entry.state === 'confirmed' && this.available(entry) && this.inputAllowed(entry);
      if (entry === this.currentEntry) this.surface(entry, true, enabled);
      enabled = enabled && entry === this.currentEntry && this.available(entry) && this.inputAllowed(entry);
      if (!enabled) this.suspendInput();
      this.notifyGeometry(entry, entry.geometry); this.queueGeometry(entry);
      return Object.freeze({ version: '1.0', handle: entry.handle, key: entry.key, receipt: entry.receipt, inputEnabled: enabled, cleanupPending: false });
    }).then(resolve, reject);
    return entry.confirmPromise;
  }
  /** Connection loss and ambiguous ACKs revoke native interaction immediately.
   * Only a subsequent authoritative transaction can enable it again. */
  suspendInput() {
    this.eventQueue.length = 0;
    const entries = new Set([this.currentEntry, this.pending, this.transaction?.previous]);
    for (const entry of entries) if (entry) {
      entry.inputEnabled = false;
      entry.candidate?.setInteractive?.(false);
    }
  }
  /** The session owner calls this only after an exact native abort proves the
   * retained presentation still owns its input lifetime. Local rollback alone
   * cannot refresh an obsolete host-authority closure. */
  restoreConfirmed(key, { isCurrent, inputGuard } = {}) {
    const entry = this.currentEntry;
    if (typeof isCurrent !== 'function' || typeof inputGuard !== 'function'
      || this.disposed || this.pending || this.transaction || this.sample || !entry
      || !sameKey(entry.key, key) || entry.state !== 'confirmed' || !entry.acknowledged
      || !entry.confirmationComplete || entry.confirmFailure || entry.controller.signal.aborted
      || !this.connected(entry)) return false;
    entry.isCurrent = isCurrent; entry.inputGuard = inputGuard;
    try {
      if (!this.available(entry) || !this.inputAllowed(entry)) return false;
      this.surface(entry, true, true);
      if (!this.interactive(entry)) { this.suspendInput(); return false; }
      return true;
    } catch (failure) { this.suspendInput(); throw failure; }
  }
  abort(target, { resumePrevious } = {}) {
    const entry = this.handles.get(target) ?? (this.transaction && this.matchingReceipt(this.transaction, target) ? this.transaction : null);
    if (!entry || ['confirmed', 'aborted'].includes(entry.state)) return false;
    resumePrevious ??= entry.resumePreviousOnAbort;
    if (typeof resumePrevious !== 'boolean') fail('resumePrevious must be boolean');
    entry.state = 'aborted'; entry.controller.abort(); this.controlDone(entry); this.eventQueue.length = 0;
    if (this.pending === entry) this.pending = null;
    if (this.transaction === entry) {
      this.transaction = null; this.currentEntry = entry.previousRetired ? null : entry.previous; this.current = this.currentEntry?.candidate ?? null;
    }
    const errors = this.cleanup(entry);
    this.surface(this.currentEntry, true, resumePrevious && !this.pending && !this.transaction && !this.disposed && Boolean(this.currentEntry && this.available(this.currentEntry)));
    if (errors.length) this.report(new DomViewError('ERR_RENDER', `candidate cleanup failed: ${errors.join('; ')}`));
    return true;
  }
  /** Standalone compatibility only: this local permit/confirm wrapper is not
   * the runtime's two-phase geometry admission and presentation ACK. */
  async submit(document, { viewport, frameId = document?.revision, configGeneration = 0, presentationKey, ...options } = {}) {
    if (!integer(frameId) || !integer(configGeneration)) fail('invalid presentation correlation');
    const key = presentationKey ?? { sessionId: document?.sessionId, pageId: String(document?.pageId), documentRevision: String(document?.revision), presentationRevision: String(frameId), surfaceGeneration: String(configGeneration), profile: document?.profile };
    const candidate = await this.prepare(document, { ...options, viewport, presentationKey: key });
    try {
      const receipt = this.commit(candidate, { version: '1.0', key, epoch: candidate.preparation.epoch, permitId: `standalone-${this.serial}` });
      this.confirm(receipt);
      return { ...receipt, acknowledgement: 'standalone-compatibility', backend: 'browser-dom', profile: 'webview', layoutAuthority: 'browser', sessionId: document.sessionId,
        pageId: document.pageId, revision: document.revision, frameId, configGeneration, geometry: legacyGeometry(receipt.nodes), nodeCount: this.current.plan.tables.nodes.size, cleanupErrors: [] };
    } catch (error) { this.abort(candidate); throw error; }
  }
  blockEntry(entry) {
    entry.inputEnabled = false;
    this.eventQueue = this.eventQueue.filter(item => item.entry !== entry);
    if (entry.geometryInFlight) entry.geometryInFlight.events.length = 0;
    if (entry.geometryPending) entry.geometryPending.events.length = 0;
    try { entry.candidate?.setInteractive?.(false); } catch (error) { this.report(error); }
  }
  geometryJob(entry, batch, needsGeometry = true) {
    let resolve;
    const job = { batch, needsGeometry, events: [], acceptingEvents: true, done: new Promise(yes => { resolve = yes; }), resolve };
    // Store the resolver after constructing the promise, whose executor runs
    // synchronously. Only two jobs retain full geometry: in flight and latest.
    job.resolve = resolve;
    return job;
  }
  startGeometry(entry, job) {
    entry.geometryInFlight = job;
    Promise.resolve().then(async () => {
      if (!this.interactive(entry)) return;
      const result = job.needsGeometry ? await this.onGeometry?.(job.batch) : undefined;
      job.acceptingEvents = false;
      if (result?.discarded === true) { this.blockEntry(entry); return; }
      if (!this.interactive(entry)) return;
      entry.geometryAdmitted = job.batch;
      const events = job.events.splice(0);
      if (events.length) {
        const applied = await this.onEventBatch?.({ version: '1.0', key: entry.key, epoch: job.batch.epoch, events });
        if (applied?.discarded === true) this.blockEntry(entry);
      }
    }).catch(error => { this.blockEntry(entry); this.report(error); }).finally(() => {
      job.acceptingEvents = false; job.events.length = 0; job.resolve();
      if (entry.geometryInFlight === job) entry.geometryInFlight = null;
      const pending = entry.geometryPending; entry.geometryPending = null;
      if (pending) {
        if (this.interactive(entry)) this.startGeometry(entry, pending);
        else { pending.events.length = 0; pending.resolve(); }
      }
    });
  }
  notifyGeometry(entry, batch) {
    if (!this.interactive(entry)) return;
    let job;
    if (entry.geometryInFlight) {
      job = entry.geometryPending ??= this.geometryJob(entry, batch);
      job.batch = batch; job.needsGeometry = true;
    } else { job = this.geometryJob(entry, batch); this.startGeometry(entry, job); }
    entry.geometryBarrier = job.done;
  }
  attachEvents(entry, events) {
    if (!this.interactive(entry)) return;
    let job = entry.geometryPending ?? entry.geometryInFlight;
    if (!job || !job.acceptingEvents) {
      job = this.geometryJob(entry, entry.geometry, entry.geometryAdmitted?.epoch !== entry.geometry.epoch);
      if (entry.geometryInFlight) entry.geometryPending = job;
      else this.startGeometry(entry, job);
      entry.geometryBarrier = job.done;
    }
    if (job.events.length + events.length > maxEventBatch) {
      this.blockEntry(entry); this.report(new DomViewError('ERR_RENDER', 'browser event batch budget exceeded; input suspended'));
      return;
    }
    job.events.push(...events);
  }
  queueGeometry(entry, force = false) {
    if (!this.interactive(entry)) return;
    entry.geometryForce ||= force;
    if (entry.geometryQueued) return;
    entry.geometryQueued = true;
    queueMicrotask(() => {
      entry.geometryQueued = false;
      if (!this.interactive(entry)) { entry.geometryForce = false; return; }
      try {
        const nodes = geometryNodes(entry.candidate.measure()), changed = JSON.stringify(nodes) !== JSON.stringify(entry.geometry.nodes);
        if (!changed && !entry.geometryForce) return;
        entry.geometryForce = false;
        entry.geometry = freeze({ version: '1.0', key: entry.key, epoch: this.nextEpoch(), viewport: entry.preparation.viewport, nodes });
        this.notifyGeometry(entry, entry.geometry);
      } catch (error) { this.surface(entry, true, false); this.report(error); }
    });
  }
  queueEvent(entry, id, type, detail, native = {}, facts = { timeStamp: native.timeStamp ?? 0 }) {
    if (!this.interactive(entry)) return;
    facts = validateDomInputFacts(facts);
    if (['scroll', 'input', 'focus', 'blur'].includes(type)) this.queueGeometry(entry, true);
    const event = planDomEvent(entry.plan.document, id, type, detail, entry.plan.tables);
    if (event.disabled) { native.stopImmediatePropagation?.(); if (native.cancelable) native.preventDefault?.(); return; }
    if (event.caught) { native.stopPropagation?.(); if (type === 'touchmove' && native.cancelable) native.preventDefault?.(); }
    // Down and terminal touch facts establish and retire runtime gesture
    // ownership even if this target only binds a later touch lifecycle event.
    if (!event.listeners.length && !touchEvents.has(type)) return;
    // The browser's handler/path/ownership plan is useful only for immediate
    // native catch policy. The runtime derives dispatch authority independently.
    if (this.eventQueue.length >= maxEventBatch) {
      this.blockEntry(entry); this.report(new DomViewError('ERR_RENDER', 'browser event batch budget exceeded; input suspended'));
      return;
    }
    this.eventQueue.push({ entry, event: { type, targetOccurrenceId: id, detail: event.detail, ...facts } });
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const accepted = this.currentEntry;
      const events = this.eventQueue.splice(0).filter(item => item.entry === accepted).map(item => item.event);
      if (!this.interactive(accepted)) return;
      if (!events.length) return;
      this.attachEvents(accepted, events);
    });
  }
  /** Selector queries are actual browser samples, independent of the geometry
   * admitted for event dispatch. Never answer from preparation/scroll caches. */
  sampleQueryGeometry(key, afterEpoch, occurrenceIds = [], includeViewportExtent = false) {
    validateDomPresentationKey(key);
    if (typeof afterEpoch !== 'string' || afterEpoch.length > 20 || !decimal(afterEpoch) || !Array.isArray(occurrenceIds) || occurrenceIds.length > 100000
      || occurrenceIds.some(id => !nonempty(id)) || new Set(occurrenceIds).size !== occurrenceIds.length) fail('invalid query geometry request');
    const entry = this.currentEntry;
    const current = () => this.interactive(entry) && sameKey(entry.key, key)
      && this.container.ownerDocument.hidden !== true;
    if (!current()) throw new DomViewError('ERR_CANCELLED', 'query has no current visible confirmed DOM presentation');
    if (occurrenceIds.some(id => !entry.plan.tables.nodes.has(id))) throw new DomViewError('ERR_CANCELLED', 'query target is outside the confirmed occurrence graph');
    const baseline = BigInt(afterEpoch);
    if (baseline === 18446744073709551615n) fail('query geometry epoch exhausted');
    if (typeof entry.candidate.measureViewportScroll !== 'function') unsupported('browser viewport scroll sampling');
    const nodes = geometryNodes(entry.candidate.measure()), viewportScroll = entry.candidate.measureViewportScroll();
    // Older recipients can still answer bounding queries. Viewport scroll
    // queries require this independent content sample at native admission.
    if (includeViewportExtent && typeof entry.candidate.measureViewportExtent !== 'function') unsupported('browser viewport content extent sampling');
    const viewportExtent = includeViewportExtent ? entry.candidate.measureViewportExtent() : undefined;
    if (!record(viewportScroll) || Object.keys(viewportScroll).length !== 2 || !['x', 'y'].every(field => Number.isFinite(viewportScroll[field]))) fail('invalid browser viewport scroll sample');
    if (includeViewportExtent && (!record(viewportExtent) || Object.keys(viewportExtent).length !== 2
      || !['width', 'height'].every(field => Number.isFinite(viewportExtent[field]) && viewportExtent[field] >= 0))) fail('invalid browser viewport content extent');
    if (!current()) throw new DomViewError('ERR_CANCELLED', 'DOM query presentation retired during browser measurement');
    const measured = new Set(nodes.map(node => node.occurrenceId));
    if (measured.size !== entry.plan.tables.nodes.size || [...entry.plan.tables.nodes.keys()].some(id => !measured.has(id))) fail('browser query did not measure the complete occurrence graph');
    if (this.epoch < baseline) this.epoch = baseline;
    return freeze({ geometry: { version: '1.0', key: entry.key, epoch: this.nextEpoch(), viewport: entry.preparation.viewport, nodes }, viewportScroll: { ...viewportScroll },
      ...(viewportExtent === undefined ? {} : { viewportExtent: { ...viewportExtent } }) });
  }
  measure() { if (!this.currentEntry) fail('no accepted DOM document'); const entry = this.currentEntry; return { ...entry.receipt, revision: entry.plan.document.revision, geometry: legacyGeometry(geometryNodes(this.current.measure())) }; }
  async createCandidate(viewport, signal) { return createBrowserCandidate(this.container, viewport, signal); }
  drainDisposal() {
    const actual = releaseOwners.get(this).actualShutdown;
    return actual ?? Promise.reject(new DomViewError('ERR_PROTOCOL_VERSION', 'DOM presenter shutdown has not started'));
  }
  disposeAsync({ timeoutMs = this.timeoutMs } = {}) {
    try { releaseDeadline(timeoutMs); } catch (failure) { return Promise.reject(failure); }
    const owner = releaseOwners.get(this);
    if (owner.shutdown) return owner.shutdown;
    // Claim the barrier before dispose can invoke user-controlled resource code.
    let resolve, reject;
    owner.shutdown = new Promise((yes, no) => { resolve = yes; reject = no; });
    const immediateFailures = [];
    try { this.dispose(); } catch (failure) { immediateFailures.push(failure); }
    // A legacy synchronous callback can throw before dispose reaches another
    // owned entry. Strict shutdown still retires every registered resource.
    for (const entry of [...owner.entries]) {
      try { this.controlDone(entry); entry.controller.abort(); } catch (failure) { immediateFailures.push(failure); }
      try { this.cleanup(entry); } catch (failure) { immediateFailures.push(failure); }
    }
    const actual = Promise.resolve().then(async () => {
      const settled = await Promise.allSettled([...owner.entries].map(entry => settleEntry(entry)));
      const failures = [...new Set([...immediateFailures, ...owner.failures,
        ...settled.filter(value => value.status === 'rejected').map(value => value.reason)].filter(Boolean))];
      if (failures.length) {
        const failure = new DomViewError('ERR_RENDER', 'DOM presenter shutdown cleanup failed');
        failure.cleanupErrors = failures; throw failure;
      }
      return Object.freeze({ version: '1.0', presenter: this, status: 'disposed', cleanupPending: false });
    });
    actual.catch(() => {}); owner.actualShutdown = actual;
    boundedRelease(actual, timeoutMs, { presenter: this }).then(resolve, reject);
    return owner.shutdown;
  }
  dispose() {
    let sampleFailure;
    if (this.sample) {
      const sample = this.sample;
      try { sample.journal.rollback(); } catch (failure) { sampleFailure = failure; }
      sample.state = 'aborted'; this.sample = null;
    }
    if (this.disposed) { if (sampleFailure) throw sampleFailure; return; } this.disposed = true;
    if (this.pending) this.abort(this.pending.handle);
    if (this.transaction) this.abort(this.transaction.handle);
    this.serial++; this.eventQueue.length = 0;
    const current = this.currentEntry; this.current = null; this.currentEntry = null;
    const errors = current ? this.cleanup(current) : [];
    if (sampleFailure) { if (errors.length) sampleFailure.cleanupErrors = [...(sampleFailure.cleanupErrors ?? []), ...errors]; throw sampleFailure; }
    if (errors.length) fail(`DOM cleanup failed: ${errors.join('; ')}`);
  }
}

async function createBrowserCandidate(container, viewport, signal) {
  if (!record(viewport) || !['width', 'height'].every(key => Number.isFinite(viewport[key]) && viewport[key] > 0 && viewport[key] <= 4096)) fail('invalid logical viewport');
  const iframe = container.ownerDocument.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-same-origin'); iframe.setAttribute('title', 'Weapp Container DOM surface');
  iframe.inert = true;
  iframe.style.cssText = `border:0;width:${viewport.width}px;height:${viewport.height}px;position:absolute;visibility:hidden;pointer-events:none;`;
  const loaded = new Promise((resolve, reject) => { iframe.addEventListener('load', resolve, { once: true }); iframe.addEventListener('error', () => reject(new Error('DOM surface load failed')), { once: true }); });
  iframe.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src blob: data: http: https:; media-src blob:;"></head><body></body></html>';
  container.append(iframe);
  try { await aborted(loaded, signal); } catch (error) { iframe.remove(); throw error; }
  const document = iframe.contentDocument, window = iframe.contentWindow;
  if (!document?.body || !window?.CSS?.supports) { iframe.remove(); unsupported('same-origin isolated DOM and CSS.supports'); }
  const elements = new Map(), nativeNodes = new WeakMap(), listeners = [], images = [], decodeDrains = [], contacts = new DomPointerContacts();
  const population = new AbortController();
  let root, plan, disposed = false, activated = false, interactive = false, restoringFocus = false, observer, disposalResult;
  const notifyNativeSurface = () => {
    const CustomEvent = container.ownerDocument?.defaultView?.CustomEvent;
    if (CustomEvent && typeof container.dispatchEvent === 'function') container.dispatchEvent(new CustomEvent('weapp-native-surface', { bubbles: true }));
  };
  const cancelPopulation = () => {
    population.abort();
    // Removing src asks the browser to cancel image decode/fetch, but is not
    // itself proof of settlement. Actual decoder promises stay in decodeDrains.
    for (const image of images) image.removeAttribute('src');
  };
  signal?.addEventListener('abort', cancelPopulation, { once: true });
  if (signal?.aborted) cancelPopulation();
  const nextFrame = () => new Promise((resolve, reject) => {
    if (population.signal.aborted) { reject(cancelled()); return; }
    let frameId;
    const cancel = () => { window.cancelAnimationFrame(frameId); population.signal.removeEventListener('abort', cancel); reject(cancelled()); };
    frameId = window.requestAnimationFrame(() => { population.signal.removeEventListener('abort', cancel); resolve(); });
    population.signal.addEventListener('abort', cancel, { once: true });
  });
  const candidate = {
    iframe, cancel: cancelPopulation, supports: (property, value) => window.CSS.supports(property, value),
    animationBaselines(descriptors) { return descriptors.map(descriptor => {
      const element = elements.get(descriptor.occurrenceId);
      if (element?.nodeType !== 1 || element.ownerDocument !== document || !element.isConnected) fail('animation baseline target is not an exact connected element');
      return computedAnimationBaseline(descriptor, window.getComputedStyle(element));
    }); },
    stageAnimation(styles, isCurrent) { return stageAnimationStyles(styles, { elementFor: id => elements.get(id), document,
      isCurrent: () => !disposed && iframe.isConnected && container.isConnected && isCurrent(), supports: (name, value) => window.CSS.supports(name, value) }); },
    isConnected: () => !disposed && iframe.isConnected && container.isConnected,
    setVisible(visible) {
      iframe.style.position = visible ? 'relative' : 'absolute'; iframe.style.visibility = visible ? 'visible' : 'hidden'; iframe.style.display = 'block';
      iframe.setAttribute('data-weapp-native-accepted', String(visible));
      notifyNativeSurface();
    },
    setInteractive(value) {
      if (!value) contacts.clear();
      interactive = value; iframe.inert = !value; iframe.style.pointerEvents = value ? 'auto' : 'none';
      notifyNativeSurface();
      if (value && candidate.focus) {
        const { element, selection } = candidate.focus; candidate.focus = null;
        // Restoring an accepted editor is adapter work, not another user focus.
        // In particular bindfocus -> setData must not recurse on each frame.
        restoringFocus = true;
        try { element.focus({ preventScroll: true }); if (selection) element.setSelectionRange(selection.start, selection.end, selection.direction); }
        finally { restoringFocus = false; }
      }
    },
    validateSelector: selector => { try { document.querySelector(selector); } catch { unsupported(`browser selector ${selector}`); } },
    async populate(value) {
      if (population.signal.aborted || disposed) throw cancelled();
      plan = value;
      const style = document.createElement('style'); style.textContent = baseCss + plan.css; document.head.append(style);
      root = document.createElement('wx-page'); root.setAttribute('data-wc-owner', 'p'); root.setAttribute('data-wc-tag', 'page'); document.body.append(root);
      function append(parent, nodes) {
        for (const node of nodes) {
          if (node.kind === 'text') { const text = document.createTextNode(node.value); parent.append(text); elements.set(node.occurrenceId, text); continue; }
          const element = document.createElement(node.domTag); elements.set(node.occurrenceId, element); nativeNodes.set(element, node.occurrenceId);
          element.setAttribute('data-wc-id', node.occurrenceId); element.setAttribute('data-wc-tag', node.tag); element.setAttribute('data-wc-owner', node.scopeToken);
          for (const name of ['id', 'class', 'role', 'tabindex', 'aria-label']) { const value = attr(node, name); if (value != null) element.setAttribute(name, scalar(value, name)); }
          for (const name of Object.keys({ ...node.attrs, ...node.typedAttrs }).filter(name => /^(?:data-|aria-)/.test(name))) {
            const value = attr(node, name); if (value != null) element.setAttribute(name, typeof value === 'object' ? JSON.stringify(value) : scalar(value, name));
          }
          for (const [name, value] of Object.entries(node.domAttributes)) element.setAttribute(name, value);
          element.style.cssText = node.inlineStyle; element.hidden = truth(attr(node, 'hidden'));
          if (node.tag === 'text') element.style.userSelect = truth(attr(node, 'selectable')) ? 'text' : 'none';
          if (node.tag === 'image') {
            element.alt = scalar(attr(node, 'alt'), 'alt'); element.style.objectFit = { scaleToFill: 'fill', aspectFit: 'contain', aspectFill: 'cover' }[node.imageMode];
            if (node.imageUrl) { element.src = node.imageUrl; images.push(element); }
          }
          if (node.tag === 'scroll-view') { element.style.overflowX = truth(attr(node, 'scroll-x')) ? 'auto' : 'hidden'; element.style.overflowY = truth(attr(node, 'scroll-y')) ? 'auto' : 'hidden'; }
          if (node.textControl) {
            const control = node.textControl;
            if (node.tag === 'input') element.type = control.type;
            element.value = control.value; element.placeholder = control.placeholder; element.disabled = control.disabled;
            element.setAttribute('aria-disabled', String(control.disabled));
            if (control.maximum != null && control.maximum >= 0) element.maxLength = control.maximum;
            else element.removeAttribute('maxlength');
          }
          if (node.tag === 'button') {
            // WXML type controls appearance, never browser submit/reset.
            element.type = 'button'; element.disabled = node.button.disabled;
            if (attr(node, 'type') != null) element.setAttribute('data-wc-button-source-type', scalar(attr(node, 'type'), 'type'));
            for (const name of ['type', 'size', 'plain', 'loading']) element.setAttribute(`data-wc-button-${name}`, String(node.button[name]));
            element.setAttribute('aria-disabled', String(node.button.disabled));
            element.setAttribute('aria-busy', String(node.button.loading));
            if (attr(node,'open-type') != null) element.setAttribute('data-wc-open-type', scalar(attr(node,'open-type'),'open-type'));
          }
          if (node.nativeComponent) element.setAttribute('data-wc-native-component', JSON.stringify(node.nativeComponent));
          parent.append(element); append(element, node.children);
        }
      }
      append(root, plan.nodes);
      // Preload resolved background URLs too, so a receipt cannot precede a
      // broken or still undecoded image used only by CSS.
      for (const url of plan.urls) if (!images.some(image => image.src === url)) { const image = document.createElement('img'); image.src = url; images.push(image); }
      for (const image of images) {
        const decoding = Promise.resolve(image.decode());
        decoding.catch(() => {}); decodeDrains.push(decoding);
      }
      await aborted(Promise.all(decodeDrains), population.signal);
      // fonts.ready observes browser-owned work. Cancellation ends this local
      // continuation without pretending the browser's global font set settled.
      await aborted(document.fonts.ready, population.signal);
      await nextFrame();
    },
    snapshot() {
      const state = new Map();
      for (const [id, node] of elements) if (node.nodeType === 1) {
        const input = ['INPUT', 'TEXTAREA'].includes(node.tagName) ? node : null;
        const focusable = input ?? (node.tagName === 'BUTTON' ? node : null);
        const control = plan.allElements.get(id)?.textControl;
        state.set(id, { scrollTop: node.scrollTop, scrollLeft: node.scrollLeft, value: input?.value, sourceValue: control?.value, controlIdentity: control?.identity,
          focus: focusable !== null && document.activeElement === focusable, selectionStart: input?.selectionStart, selectionEnd: input?.selectionEnd, selectionDirection: input?.selectionDirection });
      }
      return state;
    },
    restore(state) {
      for (const [id, element] of elements) if (element.nodeType === 1) {
        const node = plan.allElements.get(id), old = state?.get(id);
        if (node.textControl) {
          const restored = restoreDomTextControlState(node.textControl, old);
          element.value = restored.value;
          if (restored.selection) element.setSelectionRange(restored.selection.start, restored.selection.end, restored.selection.direction);
          if (restored.focus) candidate.focus = { element, selection: restored.selection };
        } else if (element.tagName === 'BUTTON' && old?.focus && !element.disabled) candidate.focus = { element };
        // Restore content before offsets: the browser clamps scroll against
        // the current value. A reused occurrence is not an editing identity.
        const scroll = node.textControl && old?.controlIdentity !== node.textControl.identity ? undefined : old;
        for (const [attribute, property] of [['scroll-top', 'scrollTop'], ['scroll-left', 'scrollLeft']]) {
          const value = node.tag === 'scroll-view' ? attr(node, attribute) : undefined, offset = value == null ? scroll?.[property] ?? 0 : Number(value);
          if (!Number.isFinite(offset)) fail('invalid scroll offset'); element[property] = offset;
        }
      }
    },
    measureViewportScroll() {
      const scroller = document.scrollingElement;
      return { x: Number.isFinite(window.scrollX) ? window.scrollX : scroller?.scrollLeft,
        y: Number.isFinite(window.scrollY) ? window.scrollY : scroller?.scrollTop };
    },
    measureViewportExtent() {
      // The scrolling element owns document content dimensions; the iframe
      // viewport and a root component border box cannot substitute for them.
      const scroller = document.scrollingElement;
      return { width: scroller?.scrollWidth, height: scroller?.scrollHeight };
    },
    measure() {
      const geometry = [];
      for (const [id, element] of elements) {
        let rect;
        if (element.nodeType === 3) { const range = document.createRange(); range.selectNodeContents(element); rect = range.getBoundingClientRect(); }
        else rect = element.getBoundingClientRect();
        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) fail('non-finite browser geometry');
        const node = plan.tables.nodes.get(id).node;
        geometry.push({ occurrenceId: id, x: rect.x, y: rect.y, width: rect.width, height: rect.height, scrollLeft: element.scrollLeft ?? 0, scrollTop: element.scrollTop ?? 0,
          scrollWidth: element.scrollWidth ?? 0, scrollHeight: element.scrollHeight ?? 0, clientWidth: element.clientWidth ?? 0, clientHeight: element.clientHeight ?? 0, ownership: clone(node.ownership) });
      }
      return geometry;
    },
    activate(send, changed) {
      if (activated) fail('DOM candidate listeners already activated'); activated = true;
      const types = { click: 'tap', pointerdown: 'touchstart', pointermove: 'touchmove', pointerup: 'touchend', pointercancel: 'touchcancel', lostpointercapture: 'touchcancel', scroll: 'scroll', input: 'input', focusin: 'focus', focusout: 'blur', keydown: 'confirm' };
      for (const [native, type] of Object.entries(types)) {
        const listener = event => {
          if (!interactive) { event.stopImmediatePropagation(); if (event.cancelable) event.preventDefault(); return; }
          if (restoringFocus && ['focusin', 'focusout'].includes(native)) return;
          if (native === 'keydown' && !['Enter', ' ', 'Spacebar'].includes(event.key)) return;
          if (native === 'pointermove' && !event.buttons && event.pointerType !== 'touch') return;
          const target = event.composedPath().find(element => nativeNodes.has(element)); if (!target) return;
          const id = nativeNodes.get(target), element = elements.get(id);
          const control = plan.allElements.get(id).textControl;
          if (control?.disabled) { event.stopImmediatePropagation(); if (event.cancelable) event.preventDefault(); return; }
          if (buttonInteractions.has(type) && buttonOnPath(plan.tables, id, node => truth(attr(node, 'disabled')))) {
            event.stopImmediatePropagation(); if (event.cancelable) event.preventDefault(); return;
          }
          // Native buttons emit one click for Enter/Space. Do not additionally
          // synthesize an input confirm event from the same key press.
          if (native === 'keydown' && buttonOnPath(plan.tables, id)) return;
          if (native === 'keydown' && event.key !== 'Enter') return;
          // The IME candidate-selection key is never an application confirm.
          // A multiline editor keeps the browser's normal newline behavior.
          if (native === 'keydown' && (event.isComposing || event.keyCode === 229 || !control || control.type === 'textarea')) return;
          const facts = contacts.update(type, event); if (!facts) return;
          if (native === 'pointerdown') try { target.setPointerCapture(event.pointerId); } catch { /* Detached targets cannot capture; registry is still cleared on freeze. */ }
          const detail = control && ['input', 'focus', 'blur', 'confirm'].includes(type)
            ? { value: element.value, cursor: element.selectionEnd, selectionStart: element.selectionStart, selectionEnd: element.selectionEnd }
            : { x: event.clientX ?? 0, y: event.clientY ?? 0, pointerId: event.pointerId ?? null, value: event.target.value ?? null, scrollTop: element.scrollTop, scrollLeft: element.scrollLeft };
          send(id, type, detail, event, facts);
        };
        document.addEventListener(native, listener, { capture: true, passive: false }); listeners.push([native, listener]);
      }
      if (typeof window.ResizeObserver === 'function') {
        observer = new window.ResizeObserver(() => changed?.());
        observer.observe(root); for (const element of elements.values()) if (element.nodeType === 1) observer.observe(element);
      }
    },
    dispose() {
      if (disposed) return disposalResult ?? []; disposed = true;
      interactive = false; contacts.clear(); observer?.disconnect(); cancelPopulation();
      signal?.removeEventListener('abort', cancelPopulation);
      for (const [type, listener] of listeners) document.removeEventListener(type, listener, true);
      for (const element of document.querySelectorAll?.('[data-weapp-native-media]') || []) element.__weappNativeDispose?.();
      iframe.inert = true; iframe.style.visibility = 'hidden'; iframe.style.pointerEvents = 'none';
      const finish = () => { iframe.remove(); return plan?.dispose() ?? []; };
      // Removing an iframe must not strand an owned RAF. cancelPopulation has
      // already canceled+settled it. Decoder last use is a separate real drain.
      disposalResult = decodeDrains.length ? Promise.allSettled(decodeDrains).then(finish) : finish();
      return disposalResult;
    },
  };
  return candidate;
}
