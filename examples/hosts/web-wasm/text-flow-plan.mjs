/** Synchronous, browser-only validation of committed portable text-flow plans. */

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const encoder = new TextEncoder()
const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits))
const invalid = message => { throw new Error(`invalid text flow: ${message}`) }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function unicodeText(text) {
  if (typeof text !== 'string') invalid('source must be a string')
  for (const character of text) {
    const point = character.codePointAt(0)
    if (point >= 0xd800 && point <= 0xdfff) invalid('source contains an unpaired surrogate')
  }
  return text
}

/** SHA-256 of exact UTF-8 source bytes, without WebCrypto or Node builtins. */
export function sha256Utf8(text) {
  const bytes = encoder.encode(unicodeText(text))
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  const bitLength = bytes.length * 8
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)
  const state = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const words = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4)
    for (let index = 16; index < 64; index++) {
      const before15 = words[index - 15], before2 = words[index - 2]
      const s0 = rotate(before15, 7) ^ rotate(before15, 18) ^ (before15 >>> 3)
      const s1 = rotate(before2, 17) ^ rotate(before2, 19) ^ (before2 >>> 10)
      words[index] = words[index - 16] + s0 + words[index - 7] + s1
    }
    let [a, b, c, d, e, f, g, h] = state
    for (let index = 0; index < 64; index++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)
      const choose = (e & f) ^ (~e & g)
      const t1 = (h + s1 + choose + SHA256_K[index] + words[index]) >>> 0
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) state[index] += value
  }
  return [...state].map(value => value.toString(16).padStart(8, '0')).join('')
}

export function validateTextFlowStyle(flow) {
  if (!record(flow)) invalid('flow style must be an object')
  if (!['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'].includes(flow.white_space)) invalid('white_space')
  if (!['normal', 'break-all', 'keep-all'].includes(flow.word_break)) invalid('word_break')
  if (!['start', 'end', 'left', 'right', 'center'].includes(flow.text_align)) invalid('text_align')
  return flow
}

const TEXT_BUDGET = 1_000_000
const f32 = Math.fround
const finite = value => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value))
const nonnegative = value => finite(value) && value >= 0
const integer = value => Number.isSafeInteger(value) && value >= 0
const equal = (left, right) => f32(left) === f32(right)
let graphemeSegmenter

function lineHeight(value, size) {
  if (value === 'normal') {
    if (!nonnegative(f32(size) * f32(1.2))) invalid('normal line height exceeds finite coordinates')
    return null
  }
  if (!record(value) || Object.keys(value).length !== 1) invalid('line_height')
  const kind = Object.keys(value)[0]
  if (!['number', 'px'].includes(kind) || !nonnegative(value[kind])) invalid('line_height')
  const used = kind === 'px' ? value[kind] : f32(size) * f32(value[kind])
  if (!nonnegative(used)) invalid('line height exceeds finite coordinates')
  return Math.fround(used)
}

function sameLineHeight(left, right) {
  if (left === 'normal' || right === 'normal') return left === right
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right)
  return leftKeys.length === 1 && rightKeys.length === 1 && leftKeys[0] === rightKeys[0] && equal(left[leftKeys[0]], right[rightKeys[0]])
}

function sourceTokens(text, whiteSpace) {
  const collapse = ['normal', 'nowrap', 'pre-line'].includes(whiteSpace)
  const preserveBreaks = !['normal', 'nowrap'].includes(whiteSpace)
  if (typeof globalThis.Intl?.Segmenter !== 'function') invalid('grapheme segmentation is unavailable')
  graphemeSegmenter ??= new Intl.Segmenter('und', { granularity: 'grapheme' })
  const tokens = []
  let offset = 0, scalarCount = 0, normalizedLength = 0
  // CSS whitespace normalization operates on scalars before grapheme
  // segmentation. A combining mark must not protect an ASCII space from
  // collapse/trim or become part of that collapsed space's source span.
  for (let index = 0; index < text.length;) {
    const start = offset
    const point = text.codePointAt(index)
    let character = String.fromCodePoint(point)
    index += character.length
    offset += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    scalarCount++
    if (character === '\r' && text[index] === '\n') {
      character = '\r\n'; index++; offset++; scalarCount++
    }
    if (scalarCount > TEXT_BUDGET) invalid('source character budget exceeded')
    const segmentBreak = ['\r', '\n', '\r\n'].includes(character)
    let kind, glyphs
    if (segmentBreak && preserveBreaks) {
      character = '\n'; kind = 'hard'; glyphs = []
    } else if (collapse && (segmentBreak || character === ' ' || character === '\t')) {
      const last = tokens.at(-1)
      if (last?.kind === 'collapsed') { last.end = offset; last.glyphs[0].end = offset; continue }
      character = ' '; kind = 'collapsed'; glyphs = [{ character, start, end: offset }]
    } else {
      kind = character === '\t' ? 'tab' : 'glyph'
      glyphs = [{ character, start, end: offset }]
    }
    normalizedLength += character.length
    tokens.push({ character, start, end: offset, kind, glyphs, normalizedEnd: normalizedLength })
  }
  const normalized = tokens.map(token => token.character).join('')
  const graphemeEnds = new Set()
  for (const { segment, index } of graphemeSegmenter.segment(normalized)) graphemeEnds.add(index + segment.length)
  return { tokens, byteLength: offset, scalarCount, graphemeEnds }
}

/**
 * Validate an accepted source-to-glyph plan without measuring or reflowing it.
 * Native font metrics remain authoritative; browser replay uses their positions.
 * Rust's commit boundary validates full Unicode line-break opportunities. This
 * replay validator checks normalized grapheme boundaries and complete normalization/source
 * coverage; it deliberately does not maintain a second UAX #14 table in JS.
 */
export function validateTextFlowPlan(text, textStyle, layout) {
  if (typeof text !== 'string' || text.length > TEXT_BUDGET * 2) invalid('source character budget exceeded')
  unicodeText(text)
  let sourceScalars = 0
  for (const _character of text) if (++sourceScalars > TEXT_BUDGET) invalid('source character budget exceeded')
  if (!record(textStyle) || !nonnegative(textStyle.font_size)) invalid('resolved text style')
  const properties = validateTextFlowStyle(textStyle.flow)
  const usedHeight = lineHeight(textStyle.line_height, textStyle.font_size)
  const font = record(layout?.measurement) && Object.keys(layout.measurement).length === 1 ? layout.measurement.font : null
  const fontBound = record(font) && Object.keys(font).length === 3 && typeof font.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(font.sha256) && font.face_index === 0 && font.profile === 'sfnt-unhinted-v1'
  if (!record(layout) || !record(layout.metrics) || !Array.isArray(layout.glyphs)
    || !(['native', 'fallback'].includes(layout.measurement) || fontBound)) invalid('committed layout')
  const { width, height, line_count: lineCount } = layout.metrics
  if (!nonnegative(width) || !nonnegative(height) || !integer(lineCount)) invalid('metrics')
  const plan = layout.flow
  if (!record(plan) || plan.version !== 1) invalid('missing or unsupported committed plan')
  validateTextFlowStyle(plan.style)
  for (const key of ['white_space', 'word_break', 'text_align']) {
    if (plan.style[key] !== properties[key]) invalid(`style binding ${key}`)
  }
  lineHeight(plan.line_height, plan.font_size)
  if (!nonnegative(plan.font_size) || !equal(plan.font_size, textStyle.font_size) || !sameLineHeight(plan.line_height, textStyle.line_height)) invalid('font binding')
  if (plan.available_width != null && !nonnegative(plan.available_width)) invalid('available_width')
  if (!finite(plan.offset_x) || !finite(plan.offset_y)) invalid('offsets')
  if (!Array.isArray(plan.glyph_sources) || !Array.isArray(plan.lines)
    || plan.glyph_sources.length !== layout.glyphs.length || layout.glyphs.length > TEXT_BUDGET
    || plan.lines.length > TEXT_BUDGET || lineCount !== plan.lines.length) invalid('plan coverage or budget')
  const { tokens, byteLength, scalarCount, graphemeEnds } = sourceTokens(text, properties.white_space)
  if (plan.lines.length > scalarCount || layout.glyphs.length > scalarCount) invalid('plan exceeds source scalar coverage')
  if (typeof plan.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(plan.source_sha256)
    || plan.source_sha256 !== sha256Utf8(text)) invalid('source SHA-256')
  for (const glyph of layout.glyphs) {
    if (!record(glyph) || typeof glyph.character !== 'string' || [...glyph.character].length !== 1
      || !finite(glyph.x) || !finite(glyph.baseline_y)) invalid('glyph character or position')
    unicodeText(glyph.character)
  }
  if (plan.lines.length === 0) {
    if (!record(plan.empty_source) || plan.empty_source.start !== 0 || plan.empty_source.end !== byteLength
      || layout.glyphs.length !== 0 || width !== 0 || height !== 0
      || tokens.some(token => token.kind !== 'collapsed')) invalid('empty source coverage')
    return layout
  }
  if (plan.empty_source != null) invalid('nonempty plan has empty_source')
  let nextSource = 0, nextGlyph = 0, nextToken = 0, maxWidth = 0, totalHeight = 0
  const collapses = ['normal', 'nowrap', 'pre-line'].includes(properties.white_space)
  for (const [lineIndex, line] of plan.lines.entries()) {
    if (!record(line) || ![line.glyph_start, line.glyph_end, line.source_start, line.source_end].every(integer)
      || line.glyph_start !== nextGlyph || line.glyph_end < line.glyph_start || line.glyph_end > layout.glyphs.length
      || line.source_start !== nextSource || line.source_end <= line.source_start || line.source_end > byteLength
      || !finite(line.x) || !finite(line.y) || !finite(line.baseline_y)
      || !nonnegative(line.width) || !nonnegative(line.advance_width) || !nonnegative(line.height)
      || !['soft', 'hard', 'end'].includes(line.break_kind)) invalid('line ranges or geometry')
    if (f32(line.width) > f32(line.advance_width)
      || ((properties.white_space !== 'pre-wrap' || plan.available_width == null
        || f32(line.advance_width) <= f32(plan.available_width)) && !equal(line.width, line.advance_width))) invalid('line advance width')
    const last = lineIndex === plan.lines.length - 1
    if ((line.break_kind === 'end' && !last) || (line.break_kind === 'soft' && last)
      || (line.break_kind === 'soft' && ['pre', 'nowrap'].includes(properties.white_space))) invalid('line break kind')
    if (!equal(line.y, f32(totalHeight + f32(plan.offset_y)))) invalid('line vertical continuity')
    if (usedHeight !== null && !equal(line.height, usedHeight)) invalid('used line height')
    let alignment = 0
    if (plan.available_width != null) {
      const factor = ['end', 'right'].includes(properties.text_align) ? 1 : properties.text_align === 'center' ? 0.5 : 0
      alignment = f32(Math.max(f32(f32(plan.available_width) - f32(line.advance_width)), 0) * factor)
    }
    if (!equal(line.x, f32(alignment + f32(plan.offset_x)))) invalid('line alignment')
    const begin = nextToken
    while (nextToken < tokens.length && tokens[nextToken].end <= line.source_end) nextToken++
    if (nextToken === begin || line.source_start !== (tokens[begin]?.start ?? byteLength)
      || line.source_end !== (tokens[nextToken - 1]?.end ?? line.source_start)) invalid('line splits a source token')
    if (line.break_kind === 'soft' && !graphemeEnds.has(tokens[nextToken - 1].normalizedEnd)) invalid('line splits a source token or normalized grapheme')
    let onlyCollapsed = true
    for (let index = begin; index < nextToken; index++) if (tokens[index].kind !== 'collapsed') { onlyCollapsed = false; break }
    if (line.break_kind !== 'hard' && onlyCollapsed) invalid('collapsed whitespace cannot create a line')
    let visibleStart = begin, visibleEnd = nextToken
    if (collapses) {
      while (visibleStart < visibleEnd && tokens[visibleStart].kind === 'collapsed') visibleStart++
      while (visibleStart < visibleEnd && tokens[visibleEnd - 1].kind === 'collapsed') visibleEnd--
    }
    const hard = []
    for (let index = visibleStart; index < visibleEnd; index++) if (tokens[index].kind === 'hard') hard.push(index)
    if (line.break_kind === 'hard') {
      if (hard.length !== 1 || hard[0] !== visibleEnd - 1
        || (hard[0] !== nextToken - 1 && !last)) invalid('hard break source')
      visibleEnd--
      if (collapses) while (visibleStart < visibleEnd && tokens[visibleEnd - 1].kind === 'collapsed') visibleEnd--
    } else if (hard.length) invalid('unrepresented hard break')
    let glyphIndex = line.glyph_start, previousX = f32(line.x)
    for (let index = visibleStart; index < visibleEnd; index++) {
      const token = tokens[index]
      if (token.kind === 'tab') continue
      for (const expected of token.glyphs) {
        const glyph = layout.glyphs[glyphIndex], source = plan.glyph_sources[glyphIndex]
        if (glyphIndex >= line.glyph_end || !record(source) || source.start !== expected.start || source.end !== expected.end
          || glyph.character !== expected.character) invalid('normalized glyph source coverage')
        if (!equal(glyph.baseline_y, line.baseline_y) || f32(glyph.x) < previousX) invalid('glyph line position')
        previousX = f32(glyph.x)
        glyphIndex++
      }
    }
    if (glyphIndex !== line.glyph_end) invalid('extra glyph in line')
    nextSource = line.source_end; nextGlyph = line.glyph_end
    totalHeight = f32(totalHeight + f32(line.height))
    maxWidth = Math.max(maxWidth, f32(line.width))
  }
  if (nextSource !== byteLength || nextGlyph !== layout.glyphs.length || nextToken !== tokens.length
    || !equal(width, maxWidth) || !equal(height, totalHeight)) invalid('complete source, glyph or metrics coverage')
  return layout
}
