import { expectType, expectError } from 'tsd'
import { test, createContainerTest } from '@weapp-container/vitest'
import { weappContainerTest } from '@weapp-container/vitest/config'
import { defineConfig } from 'vitest/config'

defineConfig({ plugins: [weappContainerTest({ build: { cwd: '.' } })] })
test('typed fixture', async ({ container }) => {
  const page = await container.renderPage('/pages/index')
  expectType<Promise<number>>(page.data<number>('count'))
  const component = await container.renderComponent('components/index')
  expectType<Promise<void>>(component.setProperties({ value: 2 }))
  expectType<Promise<{ value: number }[]>>(component.emitted<{ value: number }>('change'))
})
createContainerTest({ host: { 'wx.request': async (payload, { signal }) => ({ data: payload['url'], aborted: signal.aborted }) } })
expectError(createContainerTest({ nowMs: '0' }))
