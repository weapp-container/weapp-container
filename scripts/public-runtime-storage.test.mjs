import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const sdk of ['contract', 'android', 'ios', 'desktop', 'flutter', 'react-native']) {
  test(`${sdk}: frozen manifests use isolated storage without changing content pins`, async t => {
    const { downloadRuntimeArtifact } = await import(`../sdk/${sdk}/tools/runtime-artifacts.mjs`);
    const root = await mkdtemp(join(tmpdir(), 'runtime-storage-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bytes = Buffer.from('reviewed historical archive bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const version = '0.1.0-preview.5.3', tag = `runtime-v${version}`, fileName = `runtime-${version}-android-arm64-v8a.tar.gz`;
    const manifest = { schemaVersion: 1, runtimeVersion: version, abiVersion: 1,
      source: { repository: 'weapp-container/runtime-artifacts', releaseTag: tag },
      artifacts: [{ component: 'runtime', platform: 'android', arch: 'arm64-v8a', fileName, size: bytes.length, sha256 }] };
    const manifestPath = join(root, 'lock.json'); await writeFile(manifestPath, JSON.stringify(manifest));
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push(String(url));
      assert.equal(url.hostname, 'api.github.com');
      assert.ok(url.pathname.startsWith('/repos/weapp-container/runtime-artifacts-private-archive/'));
      assert.equal(options.headers.Authorization, 'Bearer authored-test-token');
      if (url.pathname.includes('/releases/tags/')) return Response.json({ tag_name: tag, draft: false,
        assets: [{ id: 123, name: fileName, state: 'uploaded', size: bytes.length, digest: `sha256:${sha256}` }] });
      return new Response(bytes);
    };
    const result = await downloadRuntimeArtifact({ manifestPath, version, platform: 'android', arch: 'arm64-v8a',
      outDirectory: join(root, 'download'), token: 'authored-test-token', fetchImpl });
    assert.equal(calls.length, 2);
    assert.equal(result.receipt.repository, manifest.source.repository);
    assert.equal(result.receipt.resolvedRepository, 'weapp-container/runtime-artifacts-private-archive');
    assert.equal(result.receipt.sha256, sha256);
    assert.deepEqual(await readFile(result.path), bytes);
    assert.deepEqual(JSON.parse(await readFile(manifestPath)), manifest);
  });
}
