#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContainer } from '@weapp-container/node';
import { packArtifact, disposeArtifact } from '@weapp-container/node/artifact';
const root = fileURLToPath(new URL('../', import.meta.url));
const count = Number(process.env.WEAPP_CONTAINER_BENCH_SAMPLES ?? 10);
if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error('Invalid sample count');
const artifact = await packArtifact({ projectPath: resolve(root, 'packages/node/test/fixture') });
const samples = [];
try {
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    const container = await createContainer({ pack: artifact.packPath });
    const spawned = performance.now();
    try {
      const page = await container.renderPage('/pages/counter/index');
      const mounted = performance.now();
      for (let j = 0; j < 10; j++) await page.callMethod('increment');
      const operated = performance.now();
      await container.dispose();
      samples.push({ spawnMs: spawned - start, mountMs: mounted - spawned, operationMs: (operated - mounted) / 10, disposeMs: performance.now() - operated });
    } finally { await container.dispose(); }
  }
  // RSS is measured across four simultaneously live subprocesses plus Node.
  const live = [];
  let childRssKiB = [];
  try {
    for (let i = 0; i < 4; i++) { const c = await createContainer({ pack: artifact.packPath }); live.push(c); await c.renderPage('/pages/counter/index'); }
    childRssKiB = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n')
      .map(line => line.trim().split(/\s+/).map(Number)).filter(([, parent]) => parent === process.pid)
      .map(([, , rss]) => rss).filter(Boolean).sort((a, b) => b - a).slice(0, live.length);
  } finally { await Promise.all(live.map(c => c.dispose())); }
  const average = key => samples.reduce((total, sample) => total + sample[key], 0) / samples.length;
  const report = { date: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version, samples: count,
    mean: Object.fromEntries(Object.keys(samples[0]).map(key => [key, average(key)])), childRssKiB, nodeRssBytes: process.memoryUsage().rss, raw: samples };
  const output = resolve(root, process.env.WEAPP_CONTAINER_BENCH_OUTPUT ?? 'artifacts/testing-runtime-benchmark.json');
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await disposeArtifact(artifact); }
