import test from 'node:test';
import assert from 'node:assert/strict';
import { publishVerifiedRelease } from '../tools/publish.mjs';

const plan = { repository: 'weapp-container/weapp-container', tag: 'runtime-v0.1.0-preview.7.0',
  sourceCommit: 'a'.repeat(40), files: [{ name: 'manifest.json', size: 23, sha256: 'b'.repeat(64) }] };
function github(overrides = {}) {
  const calls = []; let created = false;
  const invoke = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git') return args[0] === 'rev-parse' ? plan.sourceCommit : overrides.dirty ?? '';
    if (args[0] === 'api') {
      if (created) return JSON.stringify({ tag_name: plan.tag, draft: true, target_commitish: plan.sourceCommit,
        assets: [{ ...plan.files[0], state: 'uploaded', digest: `sha256:${plan.files[0].sha256}`, ...overrides.asset }], ...overrides.release });
      if (overrides.exists) return '{}';
      const error = Error('GitHub refused'); error.stderr = `(HTTP ${overrides.status ?? 404})`; throw error;
    }
    if (args[1] === 'create') created = true;
    return '';
  };
  return { calls, invoke };
}
test('publication stages a draft, verifies server digests, then publishes without latest or clobber', () => {
  const g = github();
  assert.equal(publishVerifiedRelease(plan, '/release', '/notes.md', g.invoke).status, 'published');
  const mutations = g.calls.filter(call => call[1] === 'release');
  assert.deepEqual(mutations.map(call => call[2]), ['create', 'upload', 'edit']);
  assert.ok(mutations[0].includes('--draft'));
  assert.ok(mutations[2].includes('--latest=false'));
  assert.ok(g.calls.every(call => !call.includes('--clobber') && !call.includes('weapp-container/runtime-artifacts')));
});
test('existing releases/tags, access failures and dirty source stop before mutations', () => {
  for (const overrides of [{ exists: true }, { status: 403 }, { dirty: ' M file' }]) {
    const g = github(overrides);
    assert.throws(() => publishVerifiedRelease(plan, '/release', '/notes.md', g.invoke));
    assert.ok(g.calls.every(call => call[1] !== 'release'));
  }
});
test('incomplete or mismatched uploads remain drafts and are never published', () => {
  for (const overrides of [{ asset: { digest: 'sha256:wrong' } }, { asset: { size: 22 } },
    { asset: { state: 'new' } }, { release: { assets: [] } }, { release: { target_commitish: 'c'.repeat(40) } }]) {
    const g = github(overrides);
    assert.throws(() => publishVerifiedRelease(plan, '/release', '/notes.md', g.invoke));
    assert.ok(g.calls.every(call => call[2] !== 'edit'));
  }
});
