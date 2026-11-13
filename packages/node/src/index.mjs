import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const MAX_MESSAGE = 8 * 1024 * 1024;

export class ContainerError extends Error {
  constructor(code, message, options) { super(message, options); this.name = 'ContainerError'; this.code = code; }
}

export function resolveTestBinary(explicit) {
  if (explicit || process.env.WEAPP_CONTAINER_TEST_BINARY) return explicit || process.env.WEAPP_CONTAINER_TEST_BINARY;
  try { return require.resolve(`@weapp-container/runtime-${process.platform}-${process.arch}`); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    const local = fileURLToPath(new URL(`../../../target/debug/weapp-test-host${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
    if (existsSync(local)) return local;
    throw new ContainerError('ERR_BINARY_UNAVAILABLE', `No testing binary for ${process.platform}-${process.arch}. Install the matching runtime package or set WEAPP_CONTAINER_TEST_BINARY. Source checkouts: run pnpm testing:build.`);
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function timed(promise, milliseconds, message, code = 'ERR_TIMEOUT') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new ContainerError(code, message)), milliseconds); })]).finally(() => clearTimeout(timer));
}

export class Container {
  #child; #ready = deferred(); #exit = deferred(); #pending = new Map(); #sequence = 0;
  #decoder = new StringDecoder('utf8'); #ownedArtifacts = new Set(); #buffer = ''; #stderr = ''; #queue = Promise.resolve(); #closing; #closed = false; #loaded = false;
  #calls = new Map(); #handlers; #diagnostics = []; #checked = 0; #options; #abortListener;
  constructor(options = {}) {
    this.#options = { timeout: 10_000, flushBudget: 100, ...options };
    for (const name of ['timeout', 'flushBudget', 'turnTimeoutMs', 'bootstrapTimeoutMs']) {
      const value = this.#options[name];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new TypeError(`${name} must be a positive safe integer`);
    }
    if (options.nowMs !== undefined && (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0)) throw new TypeError('nowMs must be a nonnegative safe integer');
    this.#handlers = new Map(Object.entries(options.host ?? {}));
    this.#child = spawn(resolveTestBinary(options.binaryPath), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // Every rejection is also consumed by startup, RPC callers or dispose.
    this.#ready.promise.catch(() => {});
    this.#child.stdout.on('data', chunk => this.#receive(chunk));
    this.#child.stderr.on('data', chunk => { this.#stderr = (this.#stderr + chunk).slice(-65536); });
    this.#child.on('error', error => this.#fail(error));
    this.#child.stdin.on('error', error => this.#fail(error));
    this.#child.on('close', (code, signal) => {
      this.#closed = true;
      const error = new ContainerError('ERR_PROCESS_EXIT', `Test host exited (${code ?? signal}). ${this.#stderr}`);
      this.#fail(error);
      this.#exit.resolve({ code, signal });
    });
    if (options.signal) {
      this.#abortListener = () => { this.dispose().catch(() => {}); };
      options.signal.addEventListener('abort', this.#abortListener, { once: true });
    }
    this.clock = Object.freeze({ advanceBy: ms => this.#operation(async () => {
      if (!Number.isSafeInteger(ms) || ms < 0) throw new TypeError('clock advance must be a nonnegative safe integer');
      await this.#rpc('advance', { ms });
      this.#options.nowMs = (this.#options.nowMs ?? 1_700_000_000_000) + ms;
      await this.#flush();
    }) });
  }

  async ready() {
    await timed(this.#ready.promise, this.#options.timeout, 'Test host startup timed out');
    if (this.#options.signal?.aborted) throw this.#options.signal.reason;
    return this;
  }

  #fail(error) {
    this.#ready.reject(error);
    for (const request of this.#pending.values()) request.reject(error);
    this.#pending.clear();
  }

  #receive(chunk) {
    this.#buffer += this.#decoder.write(chunk);
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      try {
        if (Buffer.byteLength(line) > MAX_MESSAGE) throw new Error('RPC response exceeds 8 MiB');
        const message = JSON.parse(line);
        if (message.protocolVersion) {
          if (message.protocolVersion !== 1 || message.engine !== 'quickjs' || message.testing !== true) throw new Error('Incompatible test host; real QuickJS is required');
          this.#ready.resolve();
          continue;
        }
        const pending = this.#pending.get(message.id);
        if (!pending) throw new Error('Unexpected RPC response identity');
        this.#pending.delete(message.id);
        for (const event of message.events ?? []) this.#event(event);
        if (message.error) {
          let error = new ContainerError(message.error.code, message.error.message);
          try { this.#assertDiagnostics(); } catch (diagnostic) { error = diagnostic; }
          pending.reject(error);
        }
        else pending.resolve(message.result);
      } catch (error) { this.#fail(error); this.#child.kill(); }
    }
    if (Buffer.byteLength(this.#buffer) > MAX_MESSAGE) { this.#fail(new Error('RPC response exceeds 8 MiB')); this.#child.kill(); }
  }

  #event(event) {
    if (event.type === 'hostCall') {
      const controller = new AbortController();
      const record = { controller, promise: undefined, event, completing: false };
      this.#calls.set(event.callId, record);
      if (this.#closing) controller.abort(new ContainerError('ERR_CLOSED', 'Container disposed'));
      record.promise = this.#handleCall(event, controller.signal).finally(() => {
        if (this.#calls.get(event.callId) === record) this.#calls.delete(event.callId);
      });
      record.promise.catch(() => {});
    } else if (event.type === 'hostCallCancelled') {
      this.#calls.get(event.callId)?.controller.abort(new ContainerError('ERR_CANCELLED', 'Guest cancelled host call'));
    } else if (event.type === 'error') {
      const errors = event.error?.errors ?? [event.error?.error ?? event.error];
      for (const error of errors) this.#diagnostics.push({ ...event, error });
    } else if (event.type === 'console') this.#diagnostics.push(event);
  }

  async #handleCall(event, signal) {
    let result, failure;
    try {
      const handler = this.#handlers.get(event.method);
      if (!handler) throw new ContainerError('ERR_UNMATCHED_MOCK', `No host mock matched ${event.method}: ${JSON.stringify(event.payload)}`);
      result = typeof handler === 'function' ? await handler(event.payload, { signal, callId: event.callId, api: event.method }) : handler;
    } catch (error) {
      if (signal.aborted || this.#closing) return;
      failure = error;
      this.#diagnostics.push({ type: 'error', error: { code: error.code ?? 'ERR_HOST_MOCK', message: error.message ?? String(error) } });
    }
    if (signal.aborted || this.#closing || this.#closed) return;
    const record = this.#calls.get(event.callId);
    if (record) record.completing = true;
    try {
      await this.#rpc('complete', { callId: event.callId, hostApi: event.context != null,
        ...(failure ? { error: { code: 'unsupported', message: failure.message ?? String(failure), retryable: false } } : { result: result ?? null }) });
    } catch (error) {
      if (!signal.aborted && !this.#closing) this.#diagnostics.push({ type: 'error', error: { code: error.code, message: error.message } });
    }
  }

  async #rpc(method, params = {}) {
    if (this.#closed) throw new ContainerError('ERR_CLOSED', 'Container was disposed');
    const id = ++this.#sequence;
    const request = deferred();
    const encoded = JSON.stringify({ id, method, params }) + '\n';
    if (Buffer.byteLength(encoded) > MAX_MESSAGE) throw new RangeError('RPC request exceeds 8 MiB');
    this.#pending.set(id, request);
    this.#child.stdin.write(encoded);
    try { return await timed(request.promise, this.#options.timeout, `${method} timed out`, 'ERR_RPC_TIMEOUT'); }
    catch (error) {
      if (error.code === 'ERR_RPC_TIMEOUT') { this.#child.kill('SIGKILL'); this.#fail(error); }
      throw error;
    } finally { this.#pending.delete(id); }
  }

  #operation(operation) {
    const pending = this.#queue.then(async () => {
      if (this.#closing || this.#closed) throw new ContainerError('ERR_CLOSED', 'Container was disposed');
      return operation();
    });
    this.#queue = pending.catch(() => {});
    return pending;
  }

  #assertDiagnostics() {
    const errors = this.#diagnostics.slice(this.#checked).filter(event => event.type === 'error' || (event.level === 'error' && this.#options.failOnConsoleError !== false));
    this.#checked = this.#diagnostics.length;
    if (errors.length) throw new ContainerError('ERR_GUEST', errors.map(event => event.error?.message ?? event.message).join('\n'));
  }

  async #flush() {
    for (let turn = 0; turn < this.#options.flushBudget; turn++) {
      // Let completed host promises enqueue their RPCs. Unresolved host work
      // belongs to the caller; it must not prevent navigation or cancellation.
      await new Promise(resolve => setImmediate(resolve));
      const result = await this.#rpc('tick');
      this.#assertDiagnostics();
      if (!result.timersReady && ![...this.#calls.values()].some(record => record.completing)) {
        return { pendingHostCalls: [...this.#calls.values()].filter(record => !record.controller.signal.aborted).map(record => ({ callId: record.event.callId, api: record.event.method })) };
      }
    }
    throw new ContainerError('ERR_NOT_QUIESCENT', `Runtime did not settle after ${this.#options.flushBudget} turns (${this.#calls.size} host calls, ready timers may remain)`);
  }

  flush() { return this.#operation(() => this.#flush()); }
  diagnostics() { return structuredClone(this.#diagnostics); }
  mock(api, handler) {
    if (this.#loaded && api !== 'wx.request' && !this.#handlers.has(api)) throw new Error('Declare mock APIs before renderPage');
    this.#handlers.set(api, handler);
    return this;
  }
  renderPage(route, options = {}) {
    return this.#operation(async () => {
      if (!this.#options.pack) throw new TypeError('A portable pack is required; use packArtifact or the Vitest artifact plugin');
      const handle = await this.#rpc('load', { packPath: this.#options.pack, route, options,
        testing: { nowMs: this.#options.nowMs ?? 1_700_000_000_000, apis: [...this.#handlers.keys()], syncValues: this.#options.syncValues ?? {},
          turnTimeoutMs: this.#options.turnTimeoutMs ?? 1000, bootstrapTimeoutMs: this.#options.bootstrapTimeoutMs ?? 5000 } });
      this.#loaded = true;
      await this.#flush();
      return new PageHandle(this, handle);
    });
  }
  async renderComponent(path, options = {}) {
    return this.#operation(async () => {
      const { componentArtifact } = await import('./artifact.mjs');
      if (!this.#options.artifact) throw new TypeError('renderComponent requires the compiled artifact descriptor');
      const artifact = await componentArtifact(this.#options.artifact, path, options);
      this.#ownedArtifacts.add(artifact);
      const handle = await this.#rpc('load', { packPath: artifact.packPath, route: '__container_test__/index',
        testing: { nowMs: this.#options.nowMs ?? 1_700_000_000_000, apis: [...this.#handlers.keys()], syncValues: this.#options.syncValues ?? {},
          turnTimeoutMs: this.#options.turnTimeoutMs ?? 1000, bootstrapTimeoutMs: this.#options.bootstrapTimeoutMs ?? 5000 } });
      this.#loaded = true;
      await this.#flush();
      const receiver = await this.#rpc('component', handle);
      return new ComponentHandle(this, { ...handle, receiver }, Object.keys(options.properties ?? {}));
    });
  }
  #navigate(method, params) { return this.#operation(async () => {
    const handle = await this.#rpc(method, params);
    await this.#flush();
    return new PageHandle(this, handle);
  }); }
  navigateTo(route, query = {}) { return this.#navigate('navigateTo', { route, query }); }
  redirectTo(route, query = {}) { return this.#navigate('redirectTo', { route, query }); }
  navigateBack() { return this.#navigate('navigateBack', {}); }
  currentPage() { return this.#operation(async () => new PageHandle(this, await this.#rpc('currentPage'))); }
  lifecycle(visible) { return this.#operation(async () => { await this.#rpc('lifecycle', { visible }); await this.#flush(); }); }
  /** @internal Handles always send their original session/page identity. */
  _handle(method, identity, params = {}, flush = false) { return this.#operation(async () => {
    const result = await this.#rpc(method, { ...params, ...identity });
    if (flush) await this.#flush();
    return result;
  }); }
  dispose() {
    return this.#closing ??= this.#dispose();
  }
  async #dispose() {
    const errors = [];
    this.#options.signal?.removeEventListener('abort', this.#abortListener);
    for (const record of this.#calls.values()) record.controller.abort(new ContainerError('ERR_CLOSED', 'Container disposed'));
    try { await timed(this.#queue, this.#options.timeout, 'Pending operation did not stop'); } catch (error) { errors.push(error); }
    try { if (!this.#closed) await this.#rpc('close'); } catch (error) { errors.push(error); }
    this.#child.stdin.end();
    try {
      const result = await timed(this.#exit.promise, this.#options.timeout, 'Test host failed to exit');
      if (result.code !== 0) errors.push(new ContainerError('ERR_CLEANUP', `Test host exited with ${result.code ?? result.signal}: ${this.#stderr}`));
    } catch (error) {
      errors.push(error);
      this.#child.kill('SIGKILL');
      await this.#exit.promise;
    }
    try { await timed(Promise.allSettled([...this.#calls.values()].map(record => record.promise)), this.#options.timeout, 'Host mock cleanup did not settle'); } catch (error) { errors.push(error); }
    const { disposeArtifact } = await import('./artifact.mjs');
    for (const artifact of this.#ownedArtifacts) { try { await disposeArtifact(artifact); } catch (error) { errors.push(error); } }
    this.#ownedArtifacts.clear();
    try { this.#assertDiagnostics(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Container cleanup failed');
  }
  async [Symbol.asyncDispose]() { await this.dispose(); }
}

export class PageHandle {
  #container; #identity; #subject;
  constructor(container, identity, subject) { this.#container = container; this.#identity = identity; this.#subject = subject; this.route = identity.route; }
  async data(path) {
    const data = await this.#container._handle('data', this.#identity);
    if (path === undefined) return data;
    if (typeof path !== 'string') throw new TypeError('data path must be a string');
    return path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).reduce((value, key) => value != null && Object.hasOwn(value, key) ? value[key] : undefined, data);
  }
  async callMethod(method, ...args) {
    const result = await this.#container._handle('callMethod', this.#identity, { method, args }, true);
    return result.present ? result.value : undefined;
  }
  async query(selector) {
    const nodes = await this.queryAll(selector);
    if (!nodes.length) throw new ContainerError('ERR_NODE_NOT_FOUND', `No node matched ${selector}`);
    return nodes[0];
  }
  async queryAll(selector) {
    const nodes = await this.#container._handle('query', this.#identity, { selector: this.#subject && selector === ':subject' ? this.#subject : selector, all: true });
    return nodes.map(node => new NodeHandle(this.#container, this.#identity, node));
  }
}

export class ComponentHandle extends PageHandle {
  #container; #identity; #host; #properties;
  constructor(container, identity, properties) {
    super(container, identity, '#subject');
    this.#container = container; this.#identity = identity;
    const { receiver, ...page } = identity;
    this.#host = new PageHandle(container, page);
    this.#properties = new Set(properties);
  }
  async data(path) {
    const data = await this.#container._handle('componentData', this.#identity);
    if (path === undefined) return data;
    if (typeof path !== 'string') throw new TypeError('data path must be a string');
    return path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).reduce((value, key) => value != null && Object.hasOwn(value, key) ? value[key] : undefined, data);
  }
  async setProperties(properties) {
    for (const name of Object.keys(properties)) if (!this.#properties.has(name)) throw new TypeError(`Declare property ${name} in renderComponent before updating it`);
    await this.#host.callMethod('__setProperties', properties);
  }
  async emitted(name) {
    const events = await this.#host.data('__emitted');
    return name === undefined ? events : events.filter(event => event.name === name).map(event => event.detail);
  }
}

export class NodeHandle {
  #container; #identity;
  constructor(container, page, node) { this.#container = container; this.#identity = { ...page, identity: node.identity, revision: node.revision }; this.snapshot = Object.freeze(node); }
  trigger(type, detail = {}) { return this.#container._handle('trigger', this.#identity, { type, detail }, true); }
  tap() { return this.trigger('tap'); }
  input(value) { return this.trigger('input', { value }); }
  get text() { return this.snapshot.text; }
}

export async function createContainer(options = {}) {
  const container = new Container(options);
  try { return await container.ready(); }
  catch (error) {
    try { await container.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Container startup and cleanup failed'); }
    throw error;
  }
}
