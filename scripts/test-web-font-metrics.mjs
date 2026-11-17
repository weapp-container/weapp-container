#!/usr/bin/env node
// Actual Rust layout vs the actual pinned CanvasKit face. No browser or GPU.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { validateTextFlowPlan } from '../examples/hosts/web-wasm/text-flow-plan.mjs'

const { values } = parseArgs({ options: { font: { type: 'string' }, canvaskit: { type: 'string' } }, strict: true })
assert(values.font && values.canvaskit, '--font <original pinned TTF> --canvaskit <original CanvasKit package> required')
const fontPath = resolve(values.font), kit = resolve(values.canvaskit), bytes = await readFile(fontPath)
const digest = createHash('sha256').update(bytes).digest('hex')
assert.equal(digest, 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da', 'Use the original Noto font from the diagnosed release')
const actual = JSON.parse(execFileSync('rtk', ['proxy', 'cargo', 'run', '--quiet', '--locked', '-p', 'container-render-skia', '--example', 'portable_font_probe', '--', fontPath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
assert.equal(actual.fontSha256, digest); assert(actual.missingRejected)
const CK = await createRequire(import.meta.url)(resolve(kit, 'canvaskit.js'))({ locateFile: () => resolve(kit, 'canvaskit.wasm') })
const face = CK.Typeface.MakeTypefaceFromData(bytes), font = new CK.Font(face, 16), paint = new CK.Paint()
font.setSubpixel(true); font.setLinearMetrics(true); font.setHinting(CK.FontHinting.None)
const near = (a, b, name) => assert(Math.abs(a - b) < 0.001, `${name}: ${a} != ${b}`)
try {
  for (const test of actual.cases) {
    const layout = test.layout, identity = layout.measurement.font
    assert.deepEqual(identity, { sha256: digest, face_index: 0, profile: 'sfnt-unhinted-v1' })
    validateTextFlowPlan(test.text, { font_size: 16, line_height: 'normal', flow: { white_space: 'normal', word_break: 'break-all', text_align: 'start' } }, layout)
    const glyphs = font.getGlyphIDs(test.text), widths = Array.from(font.getGlyphWidths(glyphs, paint)), metrics = font.getMetrics()
    assert(Array.from(glyphs).every(glyph => glyph !== 0))
    let offset = 0
    for (const line of layout.flow.lines) {
      const lineGlyphs = layout.glyphs.slice(line.glyph_start, line.glyph_end)
      let x = line.x
      for (const glyph of lineGlyphs) { near(glyph.x, x, `advance at ${glyph.character}`); x += widths[offset++] }
      near(line.advance_width, x - line.x, 'line width')
      near(line.height, -metrics.ascent + metrics.descent + metrics.leading, 'normal line height')
      near(line.baseline_y - line.y, -metrics.ascent + metrics.leading / 2, 'normal baseline')
    }
    assert.equal(offset, layout.glyphs.length)
    if (test.text.includes('\u0301')) {
      const mark = layout.glyphs.findIndex(glyph => glyph.character === '\u0301')
      assert.equal(widths[mark], 0); assert.equal(layout.flow.glyph_sources[mark].end - layout.flow.glyph_sources[mark].start, 2)
    }
    if (test.width === 37) assert(layout.metrics.line_count >= 3, 'Actual full-width glyphs must change wrapping')
  }
  console.log(JSON.stringify({ status: 'passed', fontSha256: digest, cases: actual.cases.map(test => ({ text: test.text, width: test.layout.metrics.width, lines: test.layout.metrics.line_count })), missingGlyphRejected: actual.missingRejected, limits: 'Scalar default-instance metrics only; no browser/GPU, shaping or CSS weight acceptance' }))
} finally { paint.delete(); font.delete(); face.delete() }
