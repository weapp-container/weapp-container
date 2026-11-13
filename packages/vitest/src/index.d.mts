import type { Container, ContainerOptions } from '@weapp-container/node';
import type { TestAPI } from 'vitest';
export { expect } from 'vitest';
export { createContainer, ContainerError } from '@weapp-container/node';
export function createContainerTest(options?: ContainerOptions): TestAPI<{ container: Container }>;
export const test: TestAPI<{ container: Container }>;
