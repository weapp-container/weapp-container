import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createOwnedCommandRunner } from './simulator-cli-harness.mjs'

test('command timeout closes its owned process group and reaps the worker', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weapp-cli-timeout-'))
  const marker = resolve(directory, 'pids.json')
  const runner = createOwnedCommandRunner({ cwd: directory, timeoutMs: 1000 })
  try {
    await assert.rejects(runner.command(process.execPath, ['-e', `
      const {spawn}=require('node:child_process');
      const {writeFileSync}=require('node:fs');
      const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      process.on('SIGTERM',()=>{
        if(worker.exitCode!==null||worker.signalCode!==null)process.exit(0);
        else worker.once('exit',()=>process.exit(0));
      });
      writeFileSync(process.argv[1],JSON.stringify([process.pid,worker.pid]));
      setInterval(()=>{},1000);
    `, marker]), error => error.result?.timedOut === true)
    assert.equal(runner.active, null, 'next command cannot overwrite a live command')
    const pids = JSON.parse(await readFile(marker, 'utf8'))
    assert.equal(pids.length, 2)
    for (const pid of pids) {
      let alive = true
      const deadline = Date.now() + 2000
      while (alive && Date.now() < deadline) {
        try { process.kill(pid, 0); await delay(20) }
        catch (error) { if (error.code !== 'ESRCH') throw error; alive = false }
      }
      assert.equal(alive, false, `owned PID ${pid} exited`)
    }
  } finally {
    runner.stop()
    runner.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
