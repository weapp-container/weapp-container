// This is the only new entry that imports/constructs the WASM AppService.
// The page owns presentation and eventually terminates this Worker after its
// correlated close result. There is no main-thread or HTTP runtime fallback.
import { createWorkerRuntime } from './worker-runtime.mjs'

// Guard before importing application glue, initializing WASM or constructing
// any AppService. Shared/Service Workers and Window are not supported owners.
if (typeof DedicatedWorkerGlobalScope !== 'function'
  || !(globalThis instanceof DedicatedWorkerGlobalScope)
  || typeof globalThis.document !== 'undefined') {
  throw Object.assign(new Error('AppService entry requires a Dedicated Worker'), { code: 'ERR_ENGINE' })
}
// Register receive before any asynchronous module work. A module Worker's
// first posted message can arrive while a top-level dynamic import is pending.
// The runtime's existing bounded load queue owns import/init and cancellation.
let WebWasmHost
const owner = createWorkerRuntime({
  initializeWasm: async () => {
    const application = await import('./pkg/container_host_web.js')
    WebWasmHost = application.WebWasmHost
    await application.default()
  },
  createHost: () => new WebWasmHost(),
  baseUrl: self.location.href,
  send: (envelope, transfers) => self.postMessage(envelope, transfers),
})

self.addEventListener('message', event => owner.receive(event.data))
