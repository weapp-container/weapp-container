import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// These cases reuse the actual pack/HostSession/HTTP/browser owner created by
// dom-runtime-browser-smoke. They never create a second browser or synthesize
// event payloads. A manual present is the harness's explicit render schedule.
export async function runTextControlRuntimeCases({ page, report, out, first }) {
  const frame = page.frameLocator('iframe')
  const samples = []
  let previous = first
  const readState = () => page.evaluate(() => {
    const data = window.observation.page.data
    return {
      singleValue: data.singleValue, multiValue: data.multiValue,
      editorDisabled: data.editorDisabled, eventCount: data.eventCount,
      confirmCount: data.confirmCount, focusCount: data.focusCount,
      blurCount: data.blurCount, lastControl: data.lastControl,
      lastCursor: data.lastCursor, lastSelectionStart: data.lastSelectionStart,
      lastSelectionEnd: data.lastSelectionEnd,
      logText: data.logText,
    }
  })
  const drainNativeWork = () => page.evaluate(async () => {
    // The native restore focus is synchronous; its event/geometry work is
    // queued. Observe the real queues after browser layout and await them.
    await new Promise(resolve => requestAnimationFrame(resolve))
    await window.presenter.currentEntry?.geometryBarrier
    await window.client.turn
  })
  const expectData = async expected => {
    const marker = await page.evaluate(() => window.states.length)
    return async action => {
      await action()
      await page.waitForFunction(({ expected, marker }) => {
        const data = window.observation.page.data
        return Object.entries(expected).every(([key, value]) => data[key] === value)
          && window.states.slice(marker).some(state => state.phase === 'updated' && state.op === 'view.events')
      }, { expected, marker })
    }
  }
  const present = async (id, { expected, focusId = null } = {}) => {
    const before = await readState()
    const receipt = await page.evaluate(() => window.present())
    assert.equal(receipt.inputEnabled, true, `${id}: new presentation must admit input`)
    assert.equal(receipt.key.sessionId, first.key.sessionId, `${id}: same AppService session`)
    assert.equal(receipt.key.pageId, first.key.pageId, `${id}: same page instance`)
    assert.ok(BigInt(receipt.key.documentRevision) > BigInt(previous.key.documentRevision), `${id}: changed Page data must produce a newer document`)
    await drainNativeWork()
    const after = await readState()
    assert.equal(after.focusCount, before.focusCount, `${id}: restoration must not invoke the application focus callback`)
    assert.equal(after.blurCount, before.blurCount, `${id}: retirement must not invoke the application blur callback`)
    for (const [key, value] of Object.entries(expected || {})) assert.equal(after[key], value, `${id}: ${key}`)
    if (focusId) assert.equal(await frame.locator(`#${focusId}`).evaluate(element => element.ownerDocument.activeElement === element), true, `${id}: native focus restored`)
    assert.equal(await page.locator('iframe').count(), 1, `${id}: old candidate retired`)
    const sample = { id, state: after, presentation: receipt }
    samples.push(sample)
    report.cases.push({ id, status: 'passed', ...sample })
    previous = receipt
    return sample
  }
  const blur = async selector => {
    const before = await readState()
    await (await expectData({ blurCount: before.blurCount + 1 }))(() => frame.locator(selector).evaluate(element => element.blur()))
    return present(`text-control-native-blur-${samples.length}`, { expected: { blurCount: before.blurCount + 1 } })
  }
  const edit = async (selector, expected, action) => {
    const before = await readState()
    const marker = await page.evaluate(selector => {
      const element = document.querySelector('iframe').contentDocument.querySelector(selector)
      // Observers belong to the parent realm; the isolated iframe disallows
      // scripts. A multiline fill can generate several native input events.
      const probe = window.textControlInputProbe = { element, events: [] }
      probe.listener = event => probe.events.push({ value: element.value, trusted: event.isTrusted })
      element.addEventListener('input', probe.listener, true)
      return window.batches.length
    }, selector)
    try {
      await (await expectData(expected))(action)
      await drainNativeWork()
      const delivery = await page.evaluate(marker => ({
        native: window.textControlInputProbe.events,
        wire: window.batches.slice(marker).flatMap(entry => entry.request.op === 'view.events' ? entry.request.payload.events.filter(event => event.type === 'input') : []),
      }), marker)
      assert.ok(delivery.native.length > 0, 'an edit must produce real native input')
      assert.equal(delivery.wire.length, delivery.native.length, 'each native edit crosses the bridge once')
      const after = await readState()
      assert.equal(after.eventCount - before.eventCount, delivery.native.length, 'each input invokes the actual Page handler once')
      report.nativeTextInputDelivery ??= []
      report.nativeTextInputDelivery.push({ selector, beforeCount: before.eventCount, afterCount: after.eventCount, ...delivery })
      return after
    } finally {
      await page.evaluate(() => {
        const probe = window.textControlInputProbe
        probe.element.removeEventListener('input', probe.listener, true)
        delete window.textControlInputProbe
      })
    }
  }

  assert.equal((await readState()).focusCount, 0)
  assert.equal(await frame.locator('#single-line').evaluate(element => element.tagName), 'INPUT')
  assert.equal(await frame.locator('#multiline').evaluate(element => element.tagName), 'TEXTAREA')
  assert.equal(await frame.locator('#disabled').isDisabled(), true)
  assert.equal(await frame.locator('#single-line').getAttribute('aria-label'), 'Single line editor')
  assert.equal(await frame.locator('#multiline').getAttribute('aria-label'), 'Multiline editor')

  await (await expectData({ focusCount: 1 }))(() => frame.locator('#single-line').focus())
  await present('text-control-focus-setdata-restores-without-feedback', { expected: { focusCount: 1 }, focusId: 'single-line' })

  const text = 'hello 微信'
  await (await expectData({ singleValue: text, eventCount: 1 }))(() => frame.locator('#single-line').fill(text))
  await present('text-control-native-input-appservice-value-and-selection', {
    expected: { singleValue: text, eventCount: 1, lastControl: 'single-line', lastCursor: text.length, lastSelectionStart: text.length, lastSelectionEnd: text.length },
    focusId: 'single-line',
  })
  assert.equal(await frame.locator('#single-line').inputValue(), text)
  const inputFact = await page.evaluate(() => window.batches.flatMap(entry => entry.request.op === 'view.events' ? entry.request.payload.events : []).find(event => event.type === 'input'))
  assert.ok(inputFact, 'native input must reach the actual runtime')
  assert.equal(inputFact.detail.value, text)
  assert.equal(inputFact.detail.cursor, text.length)
  assert.equal(inputFact.detail.selectionStart, text.length)
  assert.equal(inputFact.detail.selectionEnd, text.length)
  assert.equal('handler' in inputFact || 'listeners' in inputFact || 'ownerScopeId' in inputFact, false)

  // Native keyboard selection and insertion, with one manually scheduled
  // presentation after the application's input callback has consumed it.
  for (let index = 0; index < text.length; index++) await frame.locator('#single-line').press('ArrowLeft')
  await frame.locator('#single-line').press('ArrowRight')
  await frame.locator('#single-line').press('Shift+ArrowRight')
  const selection = await frame.locator('#single-line').evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd }))
  assert.deepEqual(selection, { start: 1, end: 2 })
  await (await expectData({ singleValue: 'h!llo 微信', eventCount: 2 }))(() => page.keyboard.insertText('!'))
  await present('text-control-native-keyboard-selection-replacement', {
    expected: { singleValue: 'h!llo 微信', eventCount: 2, lastCursor: 2, lastSelectionStart: 2, lastSelectionEnd: 2 },
    focusId: 'single-line',
  })
  await (await expectData({ confirmCount: 1 }))(() => frame.locator('#single-line').press('Enter'))
  await present('text-control-native-enter-confirms-single-line', { expected: { confirmCount: 1 }, focusId: 'single-line' })

  await blur('#single-line')
  const beforeMultiline = await readState()
  await (await expectData({ focusCount: beforeMultiline.focusCount + 1 }))(() => frame.locator('#multiline').focus())
  await present('text-control-textarea-focus-restoration', { expected: { focusCount: beforeMultiline.focusCount + 1 }, focusId: 'multiline' })
  const multiline = 'first\nsecond'
  const multilineEdit = await edit('#multiline', { multiValue: multiline }, () => frame.locator('#multiline').fill(multiline))
  await present('text-control-textarea-native-edit', { expected: { multiValue: multiline, eventCount: multilineEdit.eventCount, lastControl: 'multiline' }, focusId: 'multiline' })
  assert.equal(await frame.locator('#multiline').evaluate(element => element.selectionStart), multiline.length)
  const newlineEdit = await edit('#multiline', { multiValue: multiline + '\n' }, () => frame.locator('#multiline').press('Enter'))
  await present('text-control-textarea-enter-is-native-newline', { expected: { multiValue: multiline + '\n', eventCount: newlineEdit.eventCount, confirmCount: 1 }, focusId: 'multiline' })

  await blur('#multiline')
  await (await expectData({ editorDisabled: true }))(() => frame.locator('#disable-toggle').click())
  await present('text-control-appservice-disables-native-editors', { expected: { editorDisabled: true } })
  assert.equal(await frame.locator('#single-line').isDisabled(), true)
  assert.equal(await frame.locator('#multiline').isDisabled(), true)
  await (await expectData({ editorDisabled: false }))(() => frame.locator('#disable-toggle').click())
  await present('text-control-appservice-reenables-native-editors', { expected: { editorDisabled: false } })
  assert.equal(await frame.locator('#single-line').isDisabled(), false)
  assert.equal(await frame.locator('#multiline').isDisabled(), false)

  const replacement = { singleValue: 'Replaced by AppService', multiValue: 'AppService replacement\nEdit this second line.' }
  await (await expectData(replacement))(() => frame.locator('#replace-value').click())
  await present('text-control-declared-value-replaces-native-edit', { expected: replacement })
  assert.equal(await frame.locator('#single-line').inputValue(), replacement.singleValue)
  assert.equal(await frame.locator('#multiline').inputValue(), replacement.multiValue)

  assert.equal(await frame.locator('#password').getAttribute('type'), 'password')
  const batchCount = await page.evaluate(() => window.batches.length)
  await frame.locator('#password').fill('demo-mask')
  await drainNativeWork()
  assert.equal(await frame.locator('#password').evaluate(element => element.value.length), 9)
  const passwordLeaked = await page.evaluate(start => JSON.stringify(window.batches.slice(start)).includes('demo-mask'), batchCount)
  assert.equal(passwordLeaked, false, 'listenerless password text must not cross the application bridge')
  report.cases.push({ id: 'text-control-native-password-without-value-logging', status: 'passed', nativeType: 'password', valueCrossedBridge: false })

  const state = await readState()
  const diagnostics = await page.evaluate(() => window.diagnostics)
  assert.deepEqual(diagnostics, [])
  report.textControlRuntime = {
    profile: 'webview', nativeInput: true, nativeTextarea: true, sameSession: first.key.sessionId,
    actualPageCallbacks: true, focusCallbackCallsSetData: true,
    limitations: ['Explicit native-runtime harness scheduling; no automatic simulator watch claim.', 'No active IME composition across a document replacement, official WeChat, native mobile keyboard or performance acceptance.'],
    finalState: state,
  }
  await writeFile(resolve(out, 'text-controls-state.json'), JSON.stringify({ samples, finalState: state, inputFact, diagnostics }, null, 2) + '\n')
  return state
}
