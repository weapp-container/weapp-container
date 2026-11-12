import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { sha256Utf8, validateTextFlowPlan, validateTextFlowStyle } from '../examples/hosts/web-wasm/text-flow-plan.mjs'

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')

function fixture(text = 'A B', options = {}) {
  const style = { font_size: 10, line_height: { px: 20 }, flow: {
    white_space: options.whiteSpace ?? 'normal', word_break: 'normal', text_align: options.align ?? 'start',
  } }
  const glyphs = (options.glyphs ?? [['A', 0, 1, 0, 10], [' ', 1, 2, 5, 10], ['B', 2, 3, 10, 10]])
    .map(([character, start, end, x, baseline_y]) => ({ character, x, baseline_y, source: { start, end } }))
  const lines = options.lines ?? [{ glyph_start: 0, glyph_end: glyphs.length, source_start: 0,
    source_end: Buffer.byteLength(text), x: 0, y: 0, width: 15, advance_width: 15, height: 20, baseline_y: 10, break_kind: 'end' }]
  const layout = { measurement: 'fallback', metrics: { width: lines.reduce((max, line) => Math.max(max, line.width), 0),
    height: lines.reduce((sum, line) => Math.fround(sum + Math.fround(line.height)), 0), line_count: lines.length },
  glyphs: glyphs.map(({ source, ...glyph }) => glyph), flow: {
    version: 1, source_sha256: sha256(text), style: structuredClone(style.flow), font_size: 10, line_height: { px: 20 },
    available_width: 40, glyph_sources: glyphs.map(glyph => glyph.source), lines,
    offset_x: 0, offset_y: 0, empty_source: null,
  } }
  return { text, style, layout }
}

function line(sourceStart, sourceEnd, glyphStart, glyphEnd, width, y, kind = 'end') {
  return { source_start: sourceStart, source_end: sourceEnd, glyph_start: glyphStart, glyph_end: glyphEnd,
    x: 0, y, width, advance_width: width, height: 20, baseline_y: y + 10, break_kind: kind }
}

function scalarGlyphs(text, baseline = 10) {
  let byteOffset = 0
  return [...text].map((character, index) => {
    const start = byteOffset
    byteOffset += Buffer.byteLength(character)
    return [character, start, byteOffset, index * 5, baseline]
  })
}

const validate = value => validateTextFlowPlan(value.text, value.style, value.layout)

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

test('synchronous browser SHA-256 matches published vectors and Node crypto', () => {
  for (const [source, expected] of [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ]) {
    assert.equal(sha256Utf8(source), expected)
    assert.equal(sha256Utf8(source), sha256(source))
  }
  for (const source of ['微信小程序', 'A😀中\r\n\t B\u0000\u000c', 'e\u0301\u00e9👨‍👩‍👧‍👦',
    ...Array.from({ length: 150 }, (_, length) => '😀x中é'.repeat(length))]) {
    assert.equal(sha256Utf8(source), sha256(source), `UTF-8 length ${Buffer.byteLength(source)}`)
  }
  for (const source of ['\ud800', '\udfff', 'a\ud800b', null, 42]) assert.throws(() => sha256Utf8(source))
})

test('flow style requires explicit supported values and preserves its input', () => {
  for (const white_space of ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']) {
    for (const word_break of ['normal', 'break-all', 'keep-all']) {
      for (const text_align of ['start', 'end', 'left', 'right', 'center']) {
        const flow = { white_space, word_break, text_align }
        assert.equal(validateTextFlowStyle(Object.freeze(flow)), flow)
      }
    }
  }
  const base = { white_space: 'normal', word_break: 'normal', text_align: 'start' }
  for (const invalid of [null, undefined, [], 1, false, {}, { ...base, white_space: 'pre wrap' },
    { ...base, white_space: 'NORMAL' }, { ...base, word_break: 'break-word' }, { ...base, text_align: 'justify' }]) {
    assert.throws(() => validateTextFlowStyle(invalid))
  }
})

test('valid exact source and collapsed whitespace plans remain immutable', () => {
  const original = fixture()
  const serialized = JSON.stringify(original)
  assert.equal(validate(freeze(original)), original.layout)
  assert.equal(JSON.stringify(original), serialized)
  const collapsed = fixture(' \tA\r\n B  ', { glyphs: [
    ['A', 2, 3, 0, 10], [' ', 3, 6, 5, 10], ['B', 6, 7, 10, 10],
  ] })
  assert.equal(validate(collapsed), collapsed.layout)
  for (const whiteSpace of ['normal', 'nowrap']) {
    const cjk = fixture('中\r\n文', { whiteSpace,
      glyphs: [['中', 0, 3, 0, 10], [' ', 3, 5, 5, 10], ['文', 5, 8, 10, 10]] })
    validate(cjk)
  }
})

test('preserved CRLF, tabs, pre-line terminal trim and hard empty lines cover exact source', () => {
  for (const whiteSpace of ['pre', 'pre-wrap', 'pre-line', 'break-spaces']) {
    validate(fixture('A\r\nB', { whiteSpace, glyphs: [['A', 0, 1, 0, 10], ['B', 3, 4, 0, 30]],
      lines: [line(0, 3, 0, 1, 5, 0, 'hard'), line(3, 4, 1, 2, 5, 20)] }))
    validate(fixture('\n', { whiteSpace, glyphs: [], lines: [line(0, 1, 0, 0, 0, 0, 'hard')] }))
  }
  validate(fixture('A\n  ', { whiteSpace: 'pre-line', glyphs: [['A', 0, 1, 0, 10]],
    lines: [line(0, 4, 0, 1, 5, 0, 'hard')] }))
  validate(fixture('\tA\t', { whiteSpace: 'pre', glyphs: [['A', 1, 2, 40, 10]],
    lines: [line(0, 3, 0, 1, 80, 0)] }))
  validate(fixture('A   ', { whiteSpace: 'pre-wrap', glyphs: scalarGlyphs('A   '),
    lines: [line(0, 4, 0, 4, 20, 0)] }))
  validate(fixture('A   ', { whiteSpace: 'break-spaces', glyphs: scalarGlyphs('A   '),
    lines: [line(0, 4, 0, 4, 20, 0)] }))
})

test('empty and fully collapsed source have no line box but retain full coverage', () => {
  for (const whiteSpace of ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']) {
    const empty = fixture('', { whiteSpace, glyphs: [], lines: [] })
    empty.layout.flow.empty_source = { start: 0, end: 0 }
    validate(empty)
  }
  for (const whiteSpace of ['normal', 'nowrap', 'pre-line']) {
    const text = whiteSpace === 'pre-line' ? ' \t  ' : ' \t\r\n  '
    const empty = fixture(text, { whiteSpace, glyphs: [], lines: [] })
    empty.layout.flow.empty_source = { start: 0, end: Buffer.byteLength(text) }
    validate(empty)
  }
  for (const text of ['A', '\u00a0', '\u000c', '\n']) {
    const bad = fixture(text, { whiteSpace: 'pre-line', glyphs: [], lines: [] })
    bad.layout.flow.empty_source = { start: 0, end: Buffer.byteLength(text) }
    assert.throws(() => validate(bad), /empty source coverage/)
  }
})

test('UTF-8 scalars, combining sequences, emoji, NBSP and FF retain original mappings', () => {
  for (const text of ['e\u0301Z', '👨‍👩‍👧‍👦A', '🇨🇳中', 'A\u00a0B', 'A\u000cB', 'A\u200bB', '✈️']) {
    const glyphs = scalarGlyphs(text)
    const value = fixture(text, { glyphs, lines: [line(0, Buffer.byteLength(text), 0, glyphs.length, glyphs.length * 5, 0)] })
    validate(value)
    assert.equal(value.text, text)
  }
})

test('ASCII whitespace normalizes before graphemes without losing combining mark source or ink', () => {
  for (const whiteSpace of ['normal', 'nowrap', 'pre-line']) {
    for (const [text, glyphs] of [
      [' \u0301A', [['\u0301', 1, 3, 0, 10], ['A', 3, 4, 0, 10]]],
      ['A  \u0301B', [['A', 0, 1, 0, 10], [' ', 1, 3, 5, 10], ['\u0301', 3, 5, 10, 10], ['B', 5, 6, 10, 10]]],
      ['A \u0301 ', [['A', 0, 1, 0, 10], [' ', 1, 2, 5, 10], ['\u0301', 2, 4, 10, 10]]],
      ['\t\u0301A', [['\u0301', 1, 3, 0, 10], ['A', 3, 4, 0, 10]]],
      [' \u0301 ', [['\u0301', 1, 3, 0, 10]]],
    ]) {
      const value = fixture(text, { whiteSpace, glyphs })
      validate(value)
      assert.ok(value.layout.glyphs.some(glyph => glyph.character === '\u0301'), 'mark remains an actual painted glyph')
    }
  }
  for (const whiteSpace of ['normal', 'nowrap']) {
    validate(fixture('\r\n\u0301A', { whiteSpace, glyphs: [['\u0301', 2, 4, 0, 10], ['A', 4, 5, 0, 10]] }))
  }
  for (const whiteSpace of ['pre', 'pre-wrap', 'break-spaces']) {
    for (const text of [' \u0301A', 'A  \u0301B', 'A \u0301 ']) {
      const glyphs = scalarGlyphs(text)
      validate(fixture(text, { whiteSpace, glyphs,
        lines: [line(0, Buffer.byteLength(text), 0, glyphs.length, glyphs.length * 5, 0)] }))
    }
  }
  const lostMark = fixture('A  \u0301B', { glyphs: [['A', 0, 1, 0, 10], [' ', 1, 5, 5, 10], ['B', 5, 6, 10, 10]] })
  assert.throws(() => validate(lostMark), /normalized glyph/)
  const protectedSpace = fixture(' \u0301A', { glyphs: scalarGlyphs(' \u0301A') })
  assert.throws(() => validate(protectedSpace), /normalized glyph/)
})

test('soft breaks follow normalized graphemes including space plus a combining mark', () => {
  const collapsed = fixture('A  \u0301B', { glyphs: [['A', 0, 1, 0, 10], ['\u0301', 3, 5, 0, 30], ['B', 5, 6, 0, 30]],
    lines: [line(0, 3, 0, 1, 5, 0, 'soft'), line(3, 6, 1, 3, 5, 20)] })
  assert.throws(() => validate(collapsed), /normalized grapheme/)
  for (const whiteSpace of ['pre-wrap', 'break-spaces']) {
    const split = fixture(' \u0301A', { whiteSpace, glyphs: [[' ', 0, 1, 0, 10], ['\u0301', 1, 3, 0, 30], ['A', 3, 4, 0, 30]],
      lines: [line(0, 1, 0, 1, 5, 0, 'soft'), line(1, 4, 1, 3, 5, 20)] })
    assert.throws(() => validate(split), /normalized grapheme/)
  }
})

test('real soft lines partition source and give trimmed collapsed space to the preceding line', () => {
  const value = fixture('A B', { glyphs: [['A', 0, 1, 0, 10], ['B', 2, 3, 0, 30]],
    lines: [line(0, 2, 0, 1, 5, 0, 'soft'), line(2, 3, 1, 2, 5, 20)] })
  validate(value)
  for (const whiteSpace of ['pre', 'nowrap']) {
    const invalid = structuredClone(value)
    invalid.style.flow.white_space = invalid.layout.flow.style.white_space = whiteSpace
    assert.throws(() => validate(invalid), /line break kind/)
  }
})

test('alignment, translated private text boxes, negative baselines and f32 sums are validated', () => {
  for (const [align, expected] of [['start', 0], ['left', 0], ['end', 25], ['right', 25], ['center', 12.5]]) {
    const value = fixture('A B', { align })
    value.layout.flow.lines[0].x = expected
    value.layout.glyphs.forEach(glyph => { glyph.x += expected })
    validate(value)
  }
  const overflow = fixture('A B', { align: 'right' })
  overflow.layout.flow.available_width = 5
  validate(overflow)
  const translated = fixture()
  translated.layout.flow.offset_x = -7; translated.layout.flow.offset_y = -30
  Object.assign(translated.layout.flow.lines[0], { x: -7, y: -30, baseline_y: -20 })
  translated.layout.glyphs.forEach(glyph => { glyph.x -= 7; glyph.baseline_y = -20 })
  validate(translated)
  const zeroHeight = fixture()
  zeroHeight.style.line_height = zeroHeight.layout.flow.line_height = { px: 0 }
  zeroHeight.layout.metrics.height = zeroHeight.layout.flow.lines[0].height = 0
  zeroHeight.layout.flow.lines[0].baseline_y = -5
  zeroHeight.layout.glyphs.forEach(glyph => { glyph.baseline_y = -5 })
  validate(zeroHeight)
  const native = fixture('A\nB', { whiteSpace: 'pre', glyphs: [['A', 0, 1, 0, 10], ['B', 2, 3, 0, 23.7]],
    lines: [line(0, 2, 0, 1, 5, 0, 'hard'), { ...line(2, 3, 1, 2, 5, 13.7), baseline_y: 23.7 }] })
  native.style.line_height = native.layout.flow.line_height = 'normal'
  native.layout.flow.lines.forEach(current => { current.height = 13.7 })
  native.layout.metrics.height = Math.fround(Math.fround(13.7) + Math.fround(13.7))
  validate(native)
})

test('pre-wrap alignment includes hanging whitespace advances', () => {
  const value = fixture('A   ', { whiteSpace: 'pre-wrap', align: 'center', glyphs: scalarGlyphs('A   '),
    lines: [{ ...line(0, 4, 0, 4, 20, 0), x: 10 }] })
  value.layout.glyphs.forEach(glyph => { glyph.x += 10 })
  validate(value)
  const safeStart = fixture('A   ', { whiteSpace: 'pre-wrap', align: 'center', glyphs: scalarGlyphs('A   '),
    lines: [{ ...line(0, 4, 0, 4, 5, 0), advance_width: 20 }] })
  safeStart.layout.flow.available_width = 15
  validate(safeStart)
  const measuredWidthAlignment = structuredClone(safeStart)
  measuredWidthAlignment.layout.flow.lines[0].x = 5
  measuredWidthAlignment.layout.glyphs.forEach(glyph => { glyph.x += 5 })
  assert.throws(() => validate(measuredWidthAlignment), /alignment/)
  for (const available of [null, 20, 40]) {
    const unjustifiedHanging = structuredClone(safeStart)
    unjustifiedHanging.layout.flow.available_width = available
    assert.throws(() => validate(unjustifiedHanging), /advance width/)
  }
})

const corruptions = [
  ['missing committed plan', value => { delete value.layout.flow }],
  ['flow style without source plan', value => { value.layout.flow = null }],
  ['plan without typed flow', value => { delete value.style.flow }],
  ['unknown version', value => { value.layout.flow.version = 2 }],
  ['changed original source', value => { value.text = 'A C' }],
  ['forged source hash', value => { value.layout.flow.source_sha256 = '0'.repeat(64) }],
  ['different flow', value => { value.layout.flow.style.text_align = 'right' }],
  ['different font size', value => { value.layout.flow.font_size = 20 }],
  ['different line height kind', value => { value.layout.flow.line_height = { number: 2 } }],
  ['negative multiplier at zero font', value => { value.style.font_size = 0; value.style.line_height = { number: -1 } }],
  ['missing glyph mapping', value => { value.layout.flow.glyph_sources.pop() }],
  ['source span shifts', value => { value.layout.flow.glyph_sources[0].start = 1 }],
  ['source span overlaps', value => { value.layout.flow.glyph_sources[1].start = 0 }],
  ['source span string', value => { value.layout.flow.glyph_sources[0].start = '0' }],
  ['glyph character replacement', value => { value.layout.glyphs[0].character = 'Z' }],
  ['invalid glyph surrogate', value => { value.layout.glyphs[0].character = '\ud800' }],
  ['multiple scalars in glyph', value => { value.layout.glyphs[0].character = 'AB' }],
  ['nonmonotonic glyph position', value => { value.layout.glyphs[1].x = -1 }],
  ['glyph baseline mismatch', value => { value.layout.glyphs[1].baseline_y = 11 }],
  ['nonfinite glyph coordinate', value => { value.layout.glyphs[0].x = Infinity }],
  ['coordinate exceeds f32', value => { value.layout.glyphs[0].x = 1e40 }],
  ['negative available width', value => { value.layout.flow.available_width = -1 }],
  ['string available width', value => { value.layout.flow.available_width = '40' }],
  ['infinite available width', value => { value.layout.flow.available_width = Infinity }],
  ['nonfinite offset', value => { value.layout.flow.offset_y = NaN }],
  ['line source omission', value => { value.layout.flow.lines[0].source_start = 1 }],
  ['line glyph omission', value => { value.layout.flow.lines[0].glyph_start = 1 }],
  ['empty line source', value => { value.layout.flow.lines[0].source_end = 0 }],
  ['line source truncation', value => { value.layout.flow.lines[0].source_end = 2 }],
  ['glyph range truncation', value => { value.layout.flow.lines[0].glyph_end = 2 }],
  ['negative line width', value => { value.layout.flow.lines[0].width = -1 }],
  ['missing advance width', value => { delete value.layout.flow.lines[0].advance_width }],
  ['negative advance width', value => { value.layout.flow.lines[0].advance_width = -1 }],
  ['infinite advance width', value => { value.layout.flow.lines[0].advance_width = Infinity }],
  ['width exceeds advance', value => { value.layout.flow.lines[0].advance_width = 14 }],
  ['non-pre-wrap hanging width', value => { value.layout.flow.lines[0].advance_width = 20 }],
  ['wrong line height', value => { value.layout.flow.lines[0].height = 21 }],
  ['line y mismatch', value => { value.layout.flow.lines[0].y = 1 }],
  ['line x mismatch', value => { value.layout.flow.lines[0].x = 1 }],
  ['wrong metric width', value => { value.layout.metrics.width = 16 }],
  ['wrong metric height', value => { value.layout.metrics.height = 21 }],
  ['wrong metric line count', value => { value.layout.metrics.line_count = 0 }],
  ['fractional line count', value => { value.layout.metrics.line_count = 1.5 }],
  ['nonempty empty_source', value => { value.layout.flow.empty_source = { start: 0, end: 3 } }],
  ['final soft break', value => { value.layout.flow.lines[0].break_kind = 'soft' }],
  ['hard break without source newline', value => { value.layout.flow.lines[0].break_kind = 'hard' }],
]

for (const [name, corrupt] of corruptions) test(`rejects ${name}`, () => {
  const value = fixture()
  corrupt(value)
  assert.throws(() => validate(value))
})

test('normalization cannot trim nonspace, split CRLF, or remove preserved spaces', () => {
  const trimmed = fixture('ABC', { glyphs: [['B', 1, 2, 0, 10]], lines: [line(0, 3, 0, 1, 5, 0)] })
  assert.throws(() => validate(trimmed), /normalized glyph/)
  const crlf = fixture('A\r\nB', { whiteSpace: 'pre', glyphs: [['A', 0, 1, 0, 10], ['B', 3, 4, 0, 30]],
    lines: [line(0, 2, 0, 1, 5, 0, 'hard'), line(2, 4, 1, 2, 5, 20)] })
  assert.throws(() => validate(crlf), /source token/)
  for (const text of ['e\u0301Z', '🇨🇳Z', '👨‍👩‍👧‍👦Z']) {
    const glyphs = scalarGlyphs(text), end = glyphs[0][2]
    const split = fixture(text, { glyphs, lines: [line(0, end, 0, 1, 5, 0, 'soft'), line(end, Buffer.byteLength(text), 1, glyphs.length, 10, 20)] })
    assert.throws(() => validate(split), /source token/)
  }
  const preserved = fixture(' A ', { whiteSpace: 'pre', glyphs: [['A', 1, 2, 0, 10]], lines: [line(0, 3, 0, 1, 5, 0)] })
  assert.throws(() => validate(preserved), /normalized glyph/)
  const wrongRun = fixture('A  B', { glyphs: [['A', 0, 1, 0, 10], [' ', 1, 2, 5, 10], ['B', 3, 4, 10, 10]] })
  assert.throws(() => validate(wrongRun), /normalized glyph/)
  const collapsed = fixture('  ', { glyphs: [], lines: [line(0, 2, 0, 0, 0, 0)] })
  assert.throws(() => validate(collapsed), /collapsed whitespace/)
})

test('text and committed plan budgets fail before hashing or replay', () => {
  const source = fixture('a'.repeat(1_000_001), { glyphs: [], lines: [] })
  source.layout.flow.empty_source = { start: 0, end: source.text.length }
  assert.throws(() => validate(source), /budget/)
  const glyphs = fixture()
  glyphs.layout.glyphs = Array(1_000_001).fill(glyphs.layout.glyphs[0])
  glyphs.layout.flow.glyph_sources = Array(1_000_001).fill({ start: 0, end: 1 })
  assert.throws(() => validate(glyphs), /budget/)
})

// Runtime integration exports accepted RenderFrames; never synthesize a frame
// or substitute another font to satisfy this optional cross-language replay.
if (process.env.WEAPP_CONTAINER_TEXT_FLOW_FRAMES_DIR !== undefined) {
  test('both engines replay every exported runtime text-flow frame without mutation', async t => {
    const directory = process.env.WEAPP_CONTAINER_TEXT_FLOW_FRAMES_DIR
    assert.ok(directory, 'WEAPP_CONTAINER_TEXT_FLOW_FRAMES_DIR must name a nonempty directory')
    const files = (await readdir(directory)).filter(file => file.endsWith('.frame.json')).sort()
    const phases = ['source-initial', 'source-changed', 'source-restored',
      ...['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces', 'empty'].map(mode => `whitespace-${mode}`),
      ...['latin', 'cjk'].flatMap(script => ['normal', 'break-all', 'keep-all'].map(mode => `words-${script}-${mode}`)),
      'graphemes', 'inheritance', ...['start', 'end', 'left', 'right', 'center'].map(align => `alignment-${align}`),
      'invalid-fallback', ...['var', 'revert', 'revert-layer'].map(value => `rejected-${value}-retained`), 'repaired']
    for (const engine of ['quickjs', 'v8']) {
      for (const phase of phases) assert.ok(files.includes(`${engine}-${phase}.frame.json`), `missing ${engine} ${phase} evidence`)
    }
    let textNodes = 0
    for (const file of files) {
      assert.match(file, /^(quickjs|v8)-.+\.frame\.json$/, 'every frame has an explicit engine identity')
      const frame = JSON.parse(await readFile(join(directory, file), 'utf8'))
      const before = JSON.stringify(frame)
      assert.ok(frame && typeof frame === 'object' && !Array.isArray(frame), `${file}: frame object`)
      assert.ok(Number.isSafeInteger(frame.frame_id) && frame.frame_id >= 0, `${file}: frame id`)
      assert.ok(frame.viewport && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(frame.viewport[key])), `${file}: viewport`)
      let frameTextNodes = 0
      const visit = node => {
        assert.ok(node && typeof node === 'object' && !Array.isArray(node), `${file}: node object`)
        assert.equal(typeof node.id, 'string', `${file}: node id`)
        assert.ok(Array.isArray(node.children), `${file} ${node.id}: children`)
        if (node.text != null || node.text_layout != null) {
          assert.equal(typeof node.text, 'string', `${file} ${node.id}: original source`)
          assert.ok(node.text_style && node.text_layout, `${file} ${node.id}: committed source layout`)
          assert.doesNotThrow(() => validateTextFlowPlan(node.text, node.text_style, node.text_layout), `${file} ${node.id}`)
          frameTextNodes++
        }
        node.children.forEach(visit)
      }
      visit(frame.root)
      assert.ok(frameTextNodes > 0, `${file}: at least one actual source-mapped text node`)
      assert.equal(JSON.stringify(frame), before, `${file}: replay validation must not change the frame`)
      textNodes += frameTextNodes
    }
    t.diagnostic(`validated ${files.length} accepted runtime frames, ${textNodes} text nodes, QuickJS and V8`)
  })
}
