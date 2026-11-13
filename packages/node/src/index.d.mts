import type { ContainerArtifact } from './artifact.mjs';

export interface HostCallContext { signal: AbortSignal; callId: string; api: string }
export type HostHandler = (payload: Record<string, unknown>, context: HostCallContext) => unknown | Promise<unknown>;
export interface ContainerOptions {
  pack?: string;
  artifact?: ContainerArtifact;
  binaryPath?: string;
  host?: Record<string, HostHandler | Record<string, unknown>>;
  syncValues?: Record<string, unknown>;
  nowMs?: number;
  timeout?: number;
  flushBudget?: number;
  turnTimeoutMs?: number;
  bootstrapTimeoutMs?: number;
  failOnConsoleError?: boolean;
  signal?: AbortSignal;
}
export interface ComponentOptions {
  properties?: Record<string, unknown>;
  slots?: Record<string, string>;
  events?: string[];
}
export class ContainerError extends Error { code: string }
export class Container implements AsyncDisposable {
  constructor(options?: ContainerOptions);
  ready(): Promise<this>;
  readonly clock: { advanceBy(ms: number): Promise<void> };
  renderPage(route: string, options?: Record<string, unknown>): Promise<PageHandle>;
  renderComponent(path: string, options?: ComponentOptions): Promise<ComponentHandle>;
  navigateTo(route: string, query?: Record<string, unknown>): Promise<PageHandle>;
  redirectTo(route: string, query?: Record<string, unknown>): Promise<PageHandle>;
  navigateBack(): Promise<PageHandle>;
  currentPage(): Promise<PageHandle>;
  lifecycle(visible: boolean): Promise<void>;
  mock(api: string, handler: HostHandler | Record<string, unknown>): this;
  flush(): Promise<{ pendingHostCalls: Array<{ callId: string; api: string }> }>;
  diagnostics(): Array<Record<string, unknown>>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
export class PageHandle {
  readonly route: string;
  data<T = unknown>(path?: string): Promise<T>;
  callMethod<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  query(selector: string): Promise<NodeHandle>;
  queryAll(selector: string): Promise<NodeHandle[]>;
}
export class NodeHandle {
  readonly snapshot: Readonly<{ identity: string; revision: string; id: string; tag: string; text: string; attributes: Record<string, string>; dataset: Record<string, unknown> }>;
  readonly text: string;
  trigger(type: string, detail?: unknown): Promise<void>;
  tap(): Promise<void>;
  input(value: string): Promise<void>;
}
export class ComponentHandle extends PageHandle {
  setProperties(properties: Record<string, unknown>): Promise<void>;
  emitted(): Promise<Array<{ name: string; detail: unknown }>>;
  emitted<T = unknown>(name: string): Promise<T[]>;
}
export function createContainer(options?: ContainerOptions): Promise<Container>;
export function resolveTestBinary(explicit?: string): string;
