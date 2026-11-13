import { createContainer } from '@weapp-container/node';
import { inject, test as baseTest } from 'vitest';
import { ARTIFACT_KEY } from './config.mjs';

export { expect } from 'vitest';
export { createContainer, ContainerError } from '@weapp-container/node';

export function createContainerTest(options = {}) {
  return baseTest.extend({
    container: async ({ signal }, use) => {
      const provided = options.artifact ? { artifact: options.artifact } : inject(ARTIFACT_KEY);
      if (provided?.error) throw new Error(`Mini-program compilation failed: ${provided.error}`);
      const artifact = options.artifact ?? provided?.artifact;
      const pack = options.pack ?? artifact?.packPath;
      if (!pack) throw new Error('Configure weappContainerTest from @weapp-container/vitest/config or pass an explicit pack.');
      const container = await createContainer({ ...provided?.options, ...options, artifact, pack, signal });
      try { await use(container); } finally { await container.dispose(); }
    },
  });
}

export const test = createContainerTest();
