/** Complete unchanged generated-output checks for the native template only.
 * Inputs must come from the independent actual official/fixture reader. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import snapshots from './template-multi-platform-snapshots.json' with { type: 'json' }
import { descriptor } from './template-multi-platform-descriptor.mjs'
import { formatWxml, formatWxss, normalizeWxmlForSnapshot, resolvePages, assertTemplateRouteCoverage,
  UNSUPPORTED_VUE_EVENT_SHORTHAND_RE } from './template-snapshot-format.mjs'
const ensure = (value, message) => { if (!value) throw new Error(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const prefix = 'template e2e: weapp-vite-multi-platform-template > renders and updates the WeChat target > weapp-vite-multi-platform-template::'
const snapshotSource = '6216494786c314ab4f7385cdda74ffda1c60450aca59a955ba6f2a4910d4e9ec'
export async function assertTemplateStaticOutputs(input) {
  ensure(input?.caseId === descriptor.caseId && input.sourceSha256 === descriptor.sourceSha256
    && Array.isArray(input.files) && input.files.length === descriptor.compiledFiles.length,
  'Template original generated access coverage is incomplete')
  ensure(snapshots.source.sha256 === snapshotSource && snapshots.source.bytes === 1410
    && isDeepStrictEqual(Object.keys(snapshots.snapshots), [prefix + 'app.wxss 1', prefix + descriptor.route + ' 1']),
  'Template original snapshot key/source coverage differs')
  const files = new Map()
  for (const [at, path] of descriptor.compiledFiles.entries()) {
    const file = input.files[at]
    ensure(file?.path === path && Buffer.isBuffer(file.bytes) && file.length === file.bytes.length && file.sha256 === hash(file.bytes)
      && Buffer.from(file.bytes.toString('utf8'), 'utf8').equals(file.bytes), 'Template generated original member is absent, changed or not exact UTF-8')
    files.set(path, file.bytes.toString('utf8'))
  }
  // Original loadAppConfig reads generated app.json first. This profile requires
  // that branch, whose actual existence is independently proved above.
  const config = JSON.parse(files.get('app.json')), pages = resolvePages(config)
  const acceptance = [{ route: '/' + descriptor.route, steps: descriptor.checkpoints.map(step => ({ route: '/' + descriptor.route, id: step.id })) }]
  assertTemplateRouteCoverage(pages, acceptance)
  ensure(pages.length > 0, 'Template original app config has no pages')
  const used = [], formattedWxss = await formatWxss(files.get('app.wxss'))
  ensure(formattedWxss === snapshots.snapshots[prefix + 'app.wxss 1'], 'Template original formatted app.wxss snapshot differs')
  used.push(prefix + 'app.wxss 1')
  for (const page of pages) {
    const path = page + '.wxml'
    ensure(files.has(path), 'Template original page WXML is missing: ' + page)
    const wxml = normalizeWxmlForSnapshot(files.get(path))
    ensure(!UNSUPPORTED_VUE_EVENT_SHORTHAND_RE.test(wxml), 'Template original generated WXML contains unsupported Vue event shorthand')
    const key = prefix + page + ' 1', formatted = await formatWxml(wxml)
    ensure(Object.hasOwn(snapshots.snapshots, key) && formatted === snapshots.snapshots[key], 'Template original formatted page WXML snapshot differs: ' + page)
    used.push(key)
  }
  ensure(isDeepStrictEqual(used, Object.keys(snapshots.snapshots)), 'Template original snapshot assertions are omitted or duplicated')
  return { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, manifestIntegrity: input.manifestIntegrity,
    originalGeneratedAccesses: input.files.length, originalSnapshotAssertions: used, generatedPages: pages,
    originalRouteCoverage: true, originalNonemptyPages: true, originalWxmlSyntaxChecks: pages.length,
    files: input.files.map(({ path, sha256, length: bytes }) => ({ path, sha256, bytes })) }
}
