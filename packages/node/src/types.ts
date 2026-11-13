import type { ContainerArtifact } from './artifact.ts'

export interface HostCallContext { signal: AbortSignal; callId: string; api: string }
export type HostHandler = (payload: Record<string, unknown>, context: HostCallContext) => unknown | Promise<unknown>
export interface ContainerOptions {
  pack?: string
  artifact?: ContainerArtifact
  binaryPath?: string
  host?: Record<string, HostHandler | Record<string, unknown>>
  syncValues?: Record<string, unknown>
  nowMs?: number
  timeout?: number
  flushBudget?: number
  turnTimeoutMs?: number
  bootstrapTimeoutMs?: number
  failOnConsoleError?: boolean
  signal?: AbortSignal
}
export interface ComponentOptions { properties?: Record<string, unknown>; slots?: Record<string, string>; events?: string[] }
export interface HandleIdentity { sessionId: string; pageId: number; route: string; receiver?: string }
export interface NodeSnapshot { identity: string; revision: string; id: string; tag: string; text: string; attributes: Record<string, string>; dataset: Record<string, unknown> }
export interface FlushResult { pendingHostCalls: Array<{ callId: string; api: string }> }
export interface ErrorDetail { code?: string | undefined; message?: string | undefined; errors?: ErrorDetail[]; error?: ErrorDetail }
export interface DiagnosticEvent { type: string; level?: string; message?: string; error?: ErrorDetail }
export interface HostEvent { type: 'hostCall'; callId: string; method: string; payload: Record<string, unknown>; context?: unknown }
export type RuntimeEvent = HostEvent | { type: 'hostCallCancelled'; callId: string } | (DiagnosticEvent & { type: 'error' | 'console' })
export interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
