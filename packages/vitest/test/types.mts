import { defineConfig } from 'vitest/config';
import { test, createContainerTest, expect } from '@weapp-container/vitest';
import { weappContainerTest } from '@weapp-container/vitest/config';
import { createContainer } from '@weapp-container/node';

defineConfig({ plugins: [weappContainerTest({ build: { cwd: '.' } })] });
test('typed fixture', async ({ container }) => {
  const page = await container.renderPage('/pages/index');
  expect(await page.data<number>('count')).toBe(0);
  const component = await container.renderComponent('components/index');
  await component.setProperties({ value: 2 });
  await component.emitted<{ value: number }>('change');
});
createContainerTest({ host: { 'wx.request': async (payload, { signal }) => ({ data: payload.url, aborted: signal.aborted }) } });
const container = await createContainer();
await container[Symbol.asyncDispose]();
