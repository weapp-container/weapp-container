import * as native from 'libentry.so';

// The generated N-API module owns the opaque Rust handle and exchanges one
// complete JSON bridge batch per call. A host can replace the inline fixture
// with the packed portable manifest loaded from its rawfile/blob store.
interface NativeContainerOwner {
  capabilities(): string;
  loadManifest(manifestJson: string): string;
  loadManifestWithConfig(manifestJson: string, configJson: string): string;
  start(manifestJson: string, requestId: string): string;
  dispatch(envelopeJson: string): string;
  dispatchBatch(batchJson: string): string;
  hostServices(commandJson: string): string;
  inspectState(): string;
  pollTimers(nowNsDecimalString: string): string;
  acknowledgePresentation(renderRevisionDecimalString: string): string;
  resizeViewport(width: number, height: number): string;
  lifecycle(requestId: string, event: string): string;
  snapshot(): string;
  attachSurface(surfaceId: string, width: number, height: number): string;
  renderSurface(width: number, height: number): string;
  detachSurface(): string;
  canvasSnapshot(canvasId: string): string;
  destroy(): void;
}

export class WeappContainer {
  private readonly nativeOwner: NativeContainerOwner;
  constructor() {
    if (typeof native.createOwner !== 'function') throw new Error('ERR_PROTOCOL_VERSION: isolated native owners are required');
    this.nativeOwner = native.createOwner() as NativeContainerOwner;
  }
  capabilities(): string {
    return this.nativeOwner.capabilities() as string;
  }

  loadManifest(manifestJson: string): string {
    return this.nativeOwner.loadManifest(manifestJson) as string;
  }

  loadManifestWithConfig(manifestJson: string, configJson: string): string {
    return this.nativeOwner.loadManifestWithConfig(manifestJson, configJson) as string;
  }

  start(manifestJson: string, requestId: string = 'harmony-init'): string {
    return this.nativeOwner.start(manifestJson, requestId) as string;
  }

  dispatch(envelopeJson: string): string {
    return this.nativeOwner.dispatch(envelopeJson) as string;
  }

  dispatchBatch(batchJson: string): string { return this.nativeOwner.dispatchBatch(batchJson) as string; }
  hostServices(commandJson: string): string { return this.nativeOwner.hostServices(commandJson) as string; }

  inspectState(): string { return this.nativeOwner.inspectState() as string; }

  pollTimers(nowNsDecimalString: string): string { return this.nativeOwner.pollTimers(nowNsDecimalString) as string; }
  acknowledgePresentation(renderRevisionDecimalString: string): string { return this.nativeOwner.acknowledgePresentation(renderRevisionDecimalString) as string; }

  resizeViewport(width: number, height: number): string { return this.nativeOwner.resizeViewport(width, height) as string; }

  lifecycle(requestId: string, event: string): string { return this.nativeOwner.lifecycle(requestId, event) as string; }

  snapshot(): string {
    return this.nativeOwner.snapshot() as string;
  }

  /** Attach the ArkUI XComponent surface id to an EGL/GLES context. */
  attachSurface(surfaceId: string, width: number, height: number): string {
    return this.nativeOwner.attachSurface(surfaceId, width, height) as string;
  }

  /** Submit the latest committed frame and swap the XComponent EGL surface. */
  renderSurface(width: number, height: number): string {
    return this.nativeOwner.renderSurface(width, height) as string;
  }

  /** Detach before ArkUI destroys or replaces the XComponent surface. */
  detachSurface(): string {
    return this.nativeOwner.detachSurface() as string;
  }

  canvasSnapshot(canvasId: string = 'main'): string {
    return this.nativeOwner.canvasSnapshot(canvasId) as string;
  }

  destroy(): void {
    this.nativeOwner.destroy();
  }
}

/** A fresh native Rust/EGL owner in this same ArkTS executor. */
export function createWeappContainer(): WeappContainer { return new WeappContainer(); }
const container = createWeappContainer();
export default container;
