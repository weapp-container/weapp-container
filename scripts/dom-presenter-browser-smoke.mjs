import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const element = (id, tag, options = {}) => ({ kind: 'element', occurrenceId: id, tag, attrs: {}, typedAttrs: {}, ownership: { documentId: 'pages/home.wxml' }, events: [], children: [], ...options })
const binding = (handler, event = 'tap', phase = 'bubble', catches = false) => ({ event, handler, phase, catch: catches })
const rule = (selector, values) => ({ selectors: [selector], declarations: Object.entries(values).map(([property, value]) => ({ property, value, important: false })), nested: [] })
const sheet = (path, rules, scopeId) => ({ id: `style:${path}`, ...(scopeId ? { scopeId } : {}), ir: { version: 2, imports: [], rules } })

export async function runDomPresenterBrowserSmoke({ outDir }) {
  const out = resolve(outDir); await mkdir(dirname(out), { recursive: true }); await mkdir(out, { recursive: false })
  const source = await readFile(resolve(repository, 'examples/hosts/web-wasm/dom-presenter.mjs'))
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
  const report = { schemaVersion: 1, status: 'running', headless: true, scope: 'standalone-browser-dom-presenter', startedAt: new Date().toISOString(), sourceSha256: sha(source), cases: [], cleanup: {}, limitations: ['Synthetic evaluated ViewDocument fixture; no end-to-end runtime or official WeChat comparison.', 'No GPU, native WebView, accessibility audit or performance acceptance.'] }
  let server, browser, context, page, cdp, failure
  const html = `<!doctype html><meta charset="utf-8"><title>DOM presenter verification</title><div id="surface"></div><script type="module">
    import {DomViewPresenter} from '/dom-presenter.mjs';
    window.batches=[];window.geometries=[];window.released=0;window.errors=[];
    window.presenter=new DomViewPresenter(document.querySelector('#surface'),{
      onEventBatch:batch=>window.batches.push(batch),onGeometry:batch=>window.geometries.push(batch),onError:error=>window.errors.push(String(error)),
      resolveResource:async descriptor=>{const bytes=await(await fetch('/pixel.png')).arrayBuffer();
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
        if(hash!==descriptor.sha256||bytes.byteLength!==descriptor.size)throw new Error('resource integrity mismatch');
        const url=URL.createObjectURL(new Blob([bytes],{type:descriptor.mime}));return{url,release(){URL.revokeObjectURL(url);window.released++}};
      }});
    window.ready=true;
  </script>`
  const resources = new Map([['/', [Buffer.from(html), 'text/html']], ['/dom-presenter.mjs', [source, 'text/javascript']], ['/pixel.png', [png, 'image/png']]])
  const fixture = { version: '1.0', sessionId: 'dom-smoke', pageId: 1, revision: 1, routePath: 'pages/home', profile: 'webview', nodes: [
    element('root', 'view', { attrs: { style: 'width:600rpx;display:flex;flex-direction:column;gap:10rpx' }, events: [binding('capture', 'tap', 'capture'), binding('outer')], children: [
      element('text', 'text', { events: [binding('caught', 'tap', 'bubble', true)], children: [{ kind: 'text', occurrenceId: 'text-value', value: 'Browser layout', ownership: { documentId: 'pages/home.wxml' } }] }),
      element('image', 'image', { attrs: { src: '../assets/pixel.png', mode: 'aspectFit', style: 'width:32rpx;height:32rpx' } }),
      element('input', 'input', { attrs: { value: 'initial', style: 'height:30px;width:200px' }, events: [binding('edit', 'input'), binding('confirm', 'confirm'), binding('focused', 'focus'), binding('blurred', 'blur')] }),
      element('textarea', 'textarea', { attrs: { value: '', maxlength: '8', style: 'height:48px;width:200px' }, events: [binding('multiEdit', 'input'), binding('multiConfirm', 'confirm')] }),
      element('scroll', 'scroll-view', { attrs: { 'scroll-y': 'true', style: 'height:60px;width:200px' }, events: [binding('scrolled', 'scroll')], children: [element('tall', 'view', { attrs: { style: 'height:300px;background:rgb(200,210,220)' } })] }),
      element('silent-scroll', 'scroll-view', { attrs: { 'scroll-y': 'true', style: 'height:40px;width:200px' }, children: [element('silent-tall', 'view', { attrs: { style: 'height:200px' } })] }),
      element('silent-input', 'input', { attrs: { value: 'no-listener', style: 'height:30px;width:200px' } }),
      element('component', 'card', { ownership: { documentId: 'pages/home.wxml', componentScope: 'card-instance' }, children: [element('inside', 'view', { attrs: { class: 'inside' }, ownership: { eventOwner: 'card-instance', documentId: 'components/card.wxml' } })] }),
    ] }),
  ], styleRoots: ['style:app.wxss', 'style:components/card.wxss'], styles: [
    sheet('app.wxss', [rule('.inside', { width: '120px', height: '120px', 'background-color': 'rgb(255,0,0)' })]),
    sheet('components/card.wxss', [rule('.inside', { width: '80rpx', height: '40rpx', 'background-color': 'rgb(0,0,255)' })], 'card-instance'),
  ], resources: [{ path: 'assets/pixel.png', mime: 'image/png', size: png.length, sha256: sha(png) }] }
  const fixtureBytes = JSON.stringify(fixture, null, 2) + '\n'
  await writeFile(resolve(out, 'fixture.json'), fixtureBytes)
  report.fixtureSha256 = sha(fixtureBytes)
  try {
    server = createServer((request, response) => {
      const entry = request.method === 'GET' && resources.get(request.url)
      if (!entry) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' }).end(entry[0])
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    report.url = `http://127.0.0.1:${server.address().port}/`
    const { chromium } = await import(pathToFileURL(resolve(process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE || resolve(repository, 'vendor/weapp-vite/node_modules/playwright/index.mjs'))).href)
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    report.browser = await browser.version()
    context = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 })
    page = await context.newPage(); page.setDefaultTimeout(10000)
    await page.goto(report.url); await page.waitForFunction(() => window.ready)
    const first = await page.evaluate(fixture => window.presenter.submit(fixture, { viewport: { width: 375, height: 667 }, frameId: 1, configGeneration: 0 }), fixture)
    assert.equal(first.acknowledgement, 'standalone-compatibility')
    const geometry = id => first.geometry.find(entry => entry.occurrenceId === id)
    assert.equal(geometry('root').width, 300); assert.equal(geometry('image').width, 16); assert.equal(geometry('inside').width, 40)
    assert.equal(geometry('inside').height, 20)
    assert.ok(geometry('text-value').width > 0)
    const style = await page.evaluate(() => { const frame = document.querySelector('iframe'), node = frame.contentDocument.querySelector('[data-wc-id="inside"]'); return frame.contentWindow.getComputedStyle(node).backgroundColor })
    assert.equal(style, 'rgb(0, 0, 255)')
    report.cases.push({ id: 'browser-layout-resources-scoped-wxss', status: 'passed', receipt: first })

    const frame = page.frameLocator('iframe')
    await frame.locator('[data-wc-id="text"]').click()
    await page.waitForFunction(() => window.batches.some(batch => batch.events.some(event => event.type === 'tap')))
    const tap = await page.evaluate(() => window.batches.flatMap(batch => batch.events).find(event => event.type === 'tap'))
    assert.deepEqual(Object.keys(tap).sort(), ['detail', 'targetOccurrenceId', 'timeStamp', 'type'])
    assert.equal(tap.targetOccurrenceId, 'text')
    assert.ok(Number.isFinite(tap.timeStamp))
    assert.equal(tap.listeners, undefined)
    await frame.locator('[data-wc-id="input"]').fill('edited')
    await frame.locator('[data-wc-id="input"]').press('Enter')
    await page.waitForFunction(() => window.batches.some(batch => batch.events.some(event => event.type === 'confirm')))
    const input = await page.evaluate(() => window.batches.flatMap(batch => batch.events).find(event => event.type === 'input'))
    assert.equal(input.detail.value, 'edited')
    await frame.locator('[data-wc-id="scroll"]').hover(); await page.mouse.wheel(0, 70)
    await page.waitForFunction(() => document.querySelector('iframe').contentDocument.querySelector('[data-wc-id="scroll"]').scrollTop > 0)
    await page.waitForFunction(() => window.geometries.some(batch => batch.nodes.some(node => node.occurrenceId === 'scroll' && node.scrollOffset.y > 0)))
    const eventBatch = await page.evaluate(() => window.batches.find(batch => batch.events.some(event => event.type === 'input')))
    assert.equal(eventBatch.version, '1.0'); assert.equal(eventBatch.key.documentRevision, '1')
    assert.match(eventBatch.epoch, /^[1-9][0-9]*$/)
    report.cases.push({ id: 'trusted-click-native-input-scroll', status: 'passed', tap, input })

    await frame.locator('[data-wc-id="silent-scroll"]').evaluate(element => { element.scrollTop = 35; element.dispatchEvent(new Event('scroll')) })
    await page.waitForFunction(() => window.geometries.some(batch => batch.nodes.some(node => node.occurrenceId === 'silent-scroll' && node.scrollOffset.y === 35 && node.scrollExtent.height === 200 && node.clientSize.height === 40)))
    const beforeSilentInput = await page.evaluate(() => window.geometries.at(-1).epoch)
    await frame.locator('[data-wc-id="silent-input"]').fill('native-only')
    await page.waitForFunction(epoch => BigInt(window.geometries.at(-1).epoch) > BigInt(epoch), beforeSilentInput)
    assert.equal(await page.evaluate(() => window.batches.some(batch => batch.events.some(event => event.targetOccurrenceId === 'silent-input' || event.targetOccurrenceId === 'silent-scroll'))), false)
    report.cases.push({ id: 'listenerless-input-scroll-geometry', status: 'passed', epoch: await page.evaluate(() => window.geometries.at(-1).epoch) })

    fixture.revision = 2
    const prepare = fixture => page.evaluate(async fixture => {
      const key = { sessionId: fixture.sessionId, pageId: String(fixture.pageId), documentRevision: String(fixture.revision), presentationRevision: String(fixture.revision), surfaceGeneration: '0', profile: 'webview' }
      window.pending = await window.presenter.prepare(fixture, { viewport: { width: 375, height: 667 }, presentationKey: key })
      return window.pending.preparation
    }, fixture)
    const prepared = await prepare(fixture)
    assert.equal(prepared.key.pageId, '1'); assert.equal(prepared.key.documentRevision, '2')
    const preparing = await page.evaluate(() => {
      const frames = Array.from(document.querySelectorAll('iframe'))
      const count = window.batches.length
      frames[0].contentDocument.querySelector('[data-wc-id="text"]').click()
      return { count, frames: frames.map(frame => ({ visible: frame.style.visibility, inert: frame.inert })), released: window.released }
    })
    assert.deepEqual(preparing.frames, [{ visible: 'visible', inert: true }, { visible: 'hidden', inert: true }])
    assert.equal(preparing.released, 0)
    await page.waitForTimeout(10)
    assert.equal(await page.evaluate(() => window.batches.length), preparing.count)
    const pendingReceipt = await page.evaluate(() => {
      window.pendingReceipt = window.presenter.commit(window.pending, { version: '1.0', key: window.pending.preparation.key, epoch: window.pending.preparation.epoch, permitId: 'fixture-runtime-permit-2' })
      return window.pendingReceipt
    })
    assert.equal(pendingReceipt.phase, 'committed')
    const committed = await page.evaluate(() => ({ released: window.released, frames: Array.from(document.querySelectorAll('iframe'), frame => ({ visible: frame.style.visibility, inert: frame.inert })) }))
    assert.deepEqual(committed.frames, [{ visible: 'hidden', inert: true }, { visible: 'visible', inert: true }])
    assert.equal(committed.released, 0)
    const invalidConfirm = await page.evaluate(() => { try { window.presenter.confirm({ ...window.pendingReceipt, permitId: 'forged' }); return null } catch (error) { return error.code } })
    assert.equal(invalidConfirm, 'ERR_RENDER')
    assert.equal(await page.evaluate(() => document.querySelectorAll('iframe')[1].inert), true)
    assert.equal(await page.evaluate(() => window.presenter.abort(window.pendingReceipt)), true)
    assert.equal(await page.locator('iframe').count(), 1)
    assert.equal(await frame.locator('[data-wc-id="input"]').inputValue(), 'edited')
    assert.equal(await page.evaluate(() => document.querySelector('iframe').inert), false)
    report.cases.push({ id: 'prepare-permit-abort-retains-old-surface-and-input-gate', status: 'passed', preparation: prepared, receipt: pendingReceipt })

    await prepare(fixture)
    const second = await page.evaluate(() => {
      const receipt = window.presenter.commit(window.pending, { version: '1.0', key: window.pending.preparation.key, epoch: window.pending.preparation.epoch, permitId: 'fixture-runtime-permit-3' })
      window.presenter.confirm(receipt)
      return receipt
    })
    assert.equal(await page.locator('iframe').count(), 1)
    assert.equal(await page.evaluate(() => document.querySelector('iframe').inert), false)
    assert.equal(await frame.locator('[data-wc-id="input"]').inputValue(), 'edited')
    assert.ok(await frame.locator('[data-wc-id="scroll"]').evaluate(element => element.scrollTop) > 0)
    const failed = structuredClone(fixture); failed.revision = 3; failed.nodes[0].children[1].attrs.mode = 'widthFix'
    const error = await page.evaluate(async fixture => { try { await window.presenter.submit(fixture, { viewport: { width: 375, height: 667 }, frameId: 3, configGeneration: 0 }); return null } catch (error) { return error.code } }, failed)
    assert.equal(error, 'ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(await page.locator('iframe').count(), 1)
    assert.equal(await page.evaluate(() => window.presenter.measure().revision), 2)
    report.cases.push({ id: 'state-retention-and-failed-candidate', status: 'passed', receipt: second })

    const resized = await page.evaluate(fixture => window.presenter.submit(fixture, { viewport: { width: 750, height: 667 }, frameId: 3, configGeneration: 1 }), fixture)
    assert.equal(resized.geometry.find(entry => entry.occurrenceId === 'inside').width, 80)
    assert.equal(resized.geometry.find(entry => entry.occurrenceId === 'root').width, 600)
    report.cases.push({ id: 'logical-resize-native-relayout', status: 'passed', receipt: resized })

    const events = () => page.evaluate(() => window.batches.flatMap(batch => batch.events))
    const inputControl = frame.locator('[data-wc-id="input"]')
    await inputControl.focus()
    await inputControl.evaluate(element => element.setSelectionRange(2, 5, 'backward'))
    // Two RAFs let native focus and its original geometry/event lane settle.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const focusCount = (await events()).filter(event => event.type === 'focus' && event.targetOccurrenceId === 'input').length
    fixture.revision = 3
    await page.evaluate(fixture => window.presenter.submit(fixture, { viewport: { width: 750, height: 667 }, frameId: 4, configGeneration: 1 }), fixture)
    const retainedEdit = await inputControl.evaluate(element => ({ value: element.value, start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection, focused: element.ownerDocument.activeElement === element }))
    assert.deepEqual(retainedEdit, { value: 'edited', start: 2, end: 5, direction: 'backward', focused: true })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal((await events()).filter(event => event.type === 'focus' && event.targetOccurrenceId === 'input').length, focusCount)
    report.cases.push({ id: 'native-selection-direction-and-focus-restoration-without-business-feedback', status: 'passed', retainedEdit, focusCount })

    fixture.nodes[0].children.find(node => node.occurrenceId === 'input').ownership.eventOwner = 'replacement-owner'
    fixture.revision = 4
    await page.evaluate(fixture => window.presenter.submit(fixture, { viewport: { width: 375, height: 667 }, frameId: 5, configGeneration: 2 }), fixture)
    assert.equal(await inputControl.inputValue(), 'initial')
    assert.equal(await inputControl.evaluate(element => element.ownerDocument.activeElement === element), false)
    report.cases.push({ id: 'changed-declaration-owner-does-not-inherit-edits-or-focus', status: 'passed' })

    const multiline = frame.locator('[data-wc-id="textarea"]')
    await multiline.fill('a'); await multiline.press('End'); await multiline.press('Enter'); await multiline.pressSequentially('N')
    assert.equal(await multiline.inputValue(), 'a\nN')
    assert.equal((await events()).filter(event => event.type === 'confirm' && event.targetOccurrenceId === 'textarea').length, 0)
    await multiline.fill('abcdefg'); await multiline.press('End'); await multiline.pressSequentially('XY')
    assert.equal(await multiline.inputValue(), 'abcdefgX')
    const editFacts = (await events()).filter(event => event.type === 'input' && event.targetOccurrenceId === 'textarea').at(-1).detail
    assert.equal(editFacts.value, 'abcdefgX'); assert.equal(editFacts.cursor, 8)
    assert.equal(editFacts.selectionStart, 8); assert.equal(editFacts.selectionEnd, 8)
    report.cases.push({ id: 'native-textarea-newline-maxlength-and-utf16-edit-facts', status: 'passed', editFacts })

    fixture.nodes[0].children.find(node => node.occurrenceId === 'textarea').attrs.maxlength = '-1'
    fixture.revision = 5
    await page.evaluate(fixture => window.presenter.submit(fixture, { viewport: { width: 375, height: 667 }, frameId: 6, configGeneration: 2 }), fixture)
    const overflowingText = 'line of local native edit\n'.repeat(20)
    await multiline.fill(overflowingText)
    await multiline.evaluate(element => { element.blur(); element.setSelectionRange(0, 0); element.scrollTop = element.scrollHeight })
    const nativeScroll = await multiline.evaluate(element => element.scrollTop)
    assert.ok(nativeScroll > 0)
    fixture.revision = 6
    await page.evaluate(fixture => window.presenter.submit(fixture, { viewport: { width: 375, height: 667 }, frameId: 7, configGeneration: 2 }), fixture)
    assert.equal(await multiline.inputValue(), overflowingText)
    assert.equal(await multiline.evaluate(element => element.scrollTop), nativeScroll)
    fixture.nodes[0].children.find(node => node.occurrenceId === 'textarea').ownership.eventOwner = 'replacement-editor'
    fixture.revision = 7
    await page.evaluate(fixture => window.presenter.submit(fixture, { viewport: { width: 375, height: 667 }, frameId: 8, configGeneration: 2 }), fixture)
    assert.equal(await multiline.inputValue(), '')
    assert.equal(await multiline.evaluate(element => element.scrollTop), 0)
    report.cases.push({ id: 'native-textarea-scroll-restored-after-value-and-bound-to-owner', status: 'passed', nativeScroll })

    await inputControl.focus()
    await page.evaluate(() => {
      // The iframe disallows scripts. Observers, like the production adapter,
      // must be created in the parent realm rather than that sandbox's realm.
      const element = document.querySelector('iframe').contentDocument.querySelector('[data-wc-id="input"]')
      window.imeObservations = []
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'keydown']) element.addEventListener(type, event => {
        const output = window.imeObservations
        if (output.length < 32) output.push({ type, key: event.key ?? null, keyCode: event.keyCode ?? null, isComposing: event.isComposing ?? null, trusted: event.isTrusted })
      })
    })
    const beforeImeConfirm = (await events()).filter(event => event.type === 'confirm').length
    cdp = await context.newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: '拼', selectionStart: 1, selectionEnd: 1 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
    await cdp.send('Input.insertText', { text: '拼音' })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    const ime = await page.evaluate(() => window.imeObservations)
    report.imeProbe = { observations: ime, value: await inputControl.inputValue(), focused: await inputControl.evaluate(element => element.ownerDocument.activeElement === element), beforeConfirmCount: beforeImeConfirm, afterConfirmCount: (await events()).filter(event => event.type === 'confirm').length }
    assert.ok(ime.some(event => event.type === 'compositionstart' && event.trusted))
    assert.ok(ime.some(event => event.type === 'keydown' && event.key === 'Enter' && event.trusted && (event.isComposing || event.keyCode === 229)))
    assert.equal((await events()).filter(event => event.type === 'confirm').length, beforeImeConfirm)
    await inputControl.press('Enter')
    await page.waitForFunction(count => window.batches.flatMap(batch => batch.events).filter(event => event.type === 'confirm').length === count + 1, beforeImeConfirm)
    report.cases.push({ id: 'native-cdp-ime-selection-enter-is-not-confirm', status: 'passed', observations: ime, limitation: 'One native composition within an unchanged document; cross-render IME continuity remains unverified and incomplete.' })
    await cdp.detach(); cdp = null; report.cleanup.imeCdpDetached = true
    await page.screenshot({ path: resolve(out, 'surface.png') })
    const released = await page.evaluate(async () => { await window.presenter.disposeAsync(); return { frames: document.querySelectorAll('iframe').length, released: window.released, errors: window.errors } })
    assert.equal(released.frames, 0); assert.equal(released.released, 9); assert.deepEqual(released.errors, [])
    report.cleanup.presenter = released
    // Exercise the built-in provider in a real iframe while controlling only
    // that iframe's owned RAF delivery. No fake DOM, decoder or resource drain.
    await page.evaluate(() => {
      const container = document.createElement('div'); container.id = 'cancellation-surface'; document.body.append(container)
      const presenter = window.cancellationPresenter = new window.presenter.constructor(container)
      const create = presenter.createCandidate.bind(presenter)
      window.ownedRaf = { requested: [], canceled: [] }
      presenter.createCandidate = async (...args) => {
        const candidate = await create(...args), view = candidate.iframe.contentWindow
        const request = view.requestAnimationFrame.bind(view), cancel = view.cancelAnimationFrame.bind(view)
        view.requestAnimationFrame = callback => {
          const id = request(() => {}); window.ownedRaf.requested.push(id); return id
        }
        view.cancelAnimationFrame = id => { window.ownedRaf.canceled.push(id); cancel(id) }
        return candidate
      }
    })
    const cancelFixture = { ...fixture, revision: 4, nodes: [element('cancel-root', 'view')], resources: [], styles: [], styleRoots: [] }
    await page.evaluate(fixture => {
      const key = { sessionId: fixture.sessionId, pageId: String(fixture.pageId), documentRevision: String(fixture.revision), presentationRevision: String(fixture.revision), surfaceGeneration: '0', profile: 'webview' }
      window.cancelOutcome = window.cancellationPresenter.prepare(fixture, { viewport: { width: 375, height: 667 }, presentationKey: key, releaseMode: 'strict' })
        .then(() => ({ unexpectedSuccess: true }), error => ({ code: error.code }))
    }, cancelFixture)
    await page.waitForFunction(() => window.ownedRaf.requested.length === 1)
    const cancellation = await page.evaluate(async () => {
      const presenter = window.cancellationPresenter, handle = presenter.pending.handle
      presenter.abort(handle)
      const release = await presenter.releaseCandidate(handle)
      const outcome = await window.cancelOutcome
      await presenter.disposeAsync()
      const result = { ...window.ownedRaf, outcome, cleanupPending: release.cleanupPending,
        frames: document.querySelector('#cancellation-surface').querySelectorAll('iframe').length }
      document.querySelector('#cancellation-surface').remove()
      return result
    })
    assert.deepEqual(cancellation.requested, cancellation.canceled)
    assert.equal(cancellation.outcome.code, 'ERR_CANCELLED')
    assert.equal(cancellation.cleanupPending, false)
    assert.equal(cancellation.frames, 0)
    report.cases.push({ id: 'real-iframe-owned-raf-cancel-and-settlement', status: 'passed', evidence: cancellation,
      limitations: ['Owned iframe RAF delivery was held by the probe; real browser DOM and cleanup were used.'] })
    report.status = 'passed'
  } catch (error) { failure = error; report.status = 'failed'; report.error = error.stack ?? String(error) }
  finally {
    const cleanupErrors = []
    if (cdp) try { await cdp.detach(); report.cleanup.imeCdpDetached = true } catch (error) { cleanupErrors.push(`IME CDP: ${error}`) }
    if (page && !page.isClosed()) try { await page.evaluate(async () => { await window.cancellationPresenter?.disposeAsync(); await window.presenter?.disposeAsync(); document.querySelector('#cancellation-surface')?.remove() }); report.cleanup.presenterDisposed = true } catch (error) { cleanupErrors.push(`presenter: ${error}`) }
    if (context) try { await context.close(); report.cleanup.contextClosed = true } catch (error) { cleanupErrors.push(`context: ${error}`) }
    if (browser) try { await browser.close(); report.cleanup.browserClosed = true } catch (error) { cleanupErrors.push(`browser: ${error}`) }
    if (server) try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); report.cleanup.serverClosed = true } catch (error) { cleanupErrors.push(`server: ${error}`) }
    report.cleanup.errors = cleanupErrors
    if (cleanupErrors.length) { report.status = 'failed'; failure ??= new Error(cleanupErrors.join('; ')) }
    report.finishedAt = new Date().toISOString()
    await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  }
  if (failure) throw failure
  return report
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const flag = process.argv.indexOf('--out')
  if (flag < 0 || !process.argv[flag + 1]) throw new Error('Usage: node scripts/dom-presenter-browser-smoke.mjs --out <new-artifact-directory>')
  await runDomPresenterBrowserSmoke({ outDir: process.argv[flag + 1] })
  console.log('DOM presenter browser smoke passed; browser, context and server closed.')
}
