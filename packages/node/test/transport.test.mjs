import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContainer } from '../src/index.mjs';

async function host(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'weapp-test-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'host');
  await writeFile(path, '#!/usr/bin/env node\n' + source);
  await chmod(path, 0o755);
  return path;
}
const ready = `console.log(JSON.stringify({protocolVersion:1,engine:'quickjs',testing:true}));`;

test('subprocess crash rejects its operation and cleanup reports the exit', async t => {
  const binaryPath = await host(t, ready + `process.stdin.once('data',()=>process.exit(23));`);
  const container = await createContainer({ binaryPath, pack: '/unused', timeout: 2000 });
  await assert.rejects(container.renderPage('/index'), { code: 'ERR_PROCESS_EXIT' });
  await assert.rejects(container.dispose(), error => error instanceof AggregateError && error.errors.some(e => e.code === 'ERR_CLEANUP'));
});

test('IPC watchdog terminates a nonresponsive child and waits for its exit', async t => {
  const binaryPath = await host(t, ready + `process.stdin.resume();`);
  const container = await createContainer({ binaryPath, pack: '/unused', timeout: 500 });
  await assert.rejects(container.renderPage('/index'), { code: 'ERR_RPC_TIMEOUT' });
  await assert.rejects(container.dispose(), AggregateError);
});

test('startup validates a real QuickJS testing handshake', async t => {
  const binaryPath = await host(t, `console.log(JSON.stringify({protocolVersion:1,engine:'v8',testing:true})); process.stdin.resume();`);
  await assert.rejects(createContainer({ binaryPath, timeout: 500 }), /QuickJS|startup and cleanup/);
});
