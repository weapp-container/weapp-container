export interface NativeOwner {
  capabilities(): string;
  loadManifest(manifestJson: string): string;
  loadManifestWithConfig(manifestJson: string, configJson: string): string;
  start(manifestJson: string, requestId: string): string;
  dispatch(envelopeJson: string): string;
  dispatchBatch(batchJson: string): string;
  hostServices(commandJson: string): string;
  inspectState(): string;
  resizeViewport(width: number, height: number): string;
  pollTimers(nowNsDecimalString: string): string;
  acknowledgePresentation(renderRevisionDecimalString: string): string;
  lifecycle(requestId: string, event: string): string;
  snapshot(): string;
  attachSurface(surfaceId: string, width: number, height: number): string;
  renderSurface(width: number, height: number): string;
  detachSurface(): string;
  canvasSnapshot(canvasId: string): string;
  destroy(): void;
  unload(): string;
}

export interface NativeModule {
  createOwner(): NativeOwner;
  capabilities(): string;
  loadManifest(manifestJson: string): string;
  loadManifestWithConfig(manifestJson: string, configJson: string): string;
  start(manifestJson: string, requestId: string): string;
  dispatch(envelopeJson: string): string;
  dispatchBatch(batchJson: string): string;
  hostServices(commandJson: string): string;
  inspectState(): string;
  resizeViewport(width: number, height: number): string;
  pollTimers(nowNsDecimalString: string): string;
  acknowledgePresentation(renderRevisionDecimalString: string): string;
  lifecycle(requestId: string, event: string): string;
  snapshot(): string;
  attachSurface(surfaceId: string, width: number, height: number): string;
  renderSurface(width: number, height: number): string;
  detachSurface(): string;
  canvasSnapshot(canvasId: string): string;
  destroy(): void;
  unload(): string;
}

export function createOwner(): NativeOwner;

export function capabilities(): string;
export function loadManifest(manifestJson: string): string;
export function loadManifestWithConfig(manifestJson: string, configJson: string): string;
export function start(manifestJson: string, requestId: string): string;
export function dispatch(envelopeJson: string): string;
export function dispatchBatch(batchJson: string): string;
export function hostServices(commandJson: string): string;
export function inspectState(): string;
export function resizeViewport(width: number, height: number): string;
export function pollTimers(nowNsDecimalString: string): string;
export function acknowledgePresentation(renderRevisionDecimalString: string): string;
export function lifecycle(requestId: string, event: string): string;
export function snapshot(): string;
export function attachSurface(surfaceId: string, width: number, height: number): string;
export function renderSurface(width: number, height: number): string;
export function detachSurface(): string;
export function canvasSnapshot(canvasId: string): string;
export function destroy(): void;
export function unload(): string;
