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
      if (args.includes('--slurp')) {
        if (overrides.status) throw Error('Release listing unavailable');
        return JSON.stringify([[], overrides.exists ? [{ tag_name: plan.tag, draft: true }] : []]);
      }
      if (args.includes('POST')) { created = true; return JSON.stringify({ id: overrides.id ?? 123 }); }
      if (args.includes('PATCH')) return '{}';
      if (args[1].includes('/releases/tags/')) throw Error('Tag endpoint cannot see an unpublished draft');
      if (created) return JSON.stringify({ id: 123, tag_name: plan.tag, draft: true, prerelease: true, target_commitish: plan.sourceCommit,
        assets: [{ ...plan.files[0], state: 'uploaded', digest: `sha256:${plan.files[0].sha256}`, ...overrides.asset }], ...overrides.release });
      if (overrides.exists) return '{}';
      const error = Error('GitHub refused'); error.stderr = `(HTTP ${overrides.status ?? 404})`; throw error;
    }
    return '';
  };
  return { calls, invoke };
}
test('publication stages a draft, verifies server digests, then publishes without latest or clobber', () => {
  const g = github();
  assert.equal(publishVerifiedRelease(plan, '/release', '/notes.md', g.invoke).status, 'published');
  const mutations = g.calls.filter(call => call.includes('POST') || call.includes('PATCH') || call[2] === 'upload');
  assert.equal(mutations.length, 3);
  assert.ok(mutations[0].includes('draft=true'));
  assert.equal(mutations[1][2], 'upload');
  assert.ok(mutations[2].includes('make_latest=false'));
  assert.equal(mutations[2][2], 'repos/weapp-container/weapp-container/releases/123');
  assert.ok(g.calls.every(call => !call.some(value => value.includes('/releases/tags/'))));
  assert.ok(g.calls.every(call => !call.includes('--clobber') && !call.includes('weapp-container/runtime-artifacts')));
});
test('existing releases/tags, access failures and dirty source stop before mutations', () => {
  for (const overrides of [{ exists: true }, { status: 403 }, { dirty: ' M file' }]) {
    const g = github(overrides);
    assert.throws(() => publishVerifiedRelease(plan, '/release', '/notes.md', g.invoke));
    assert.ok(g.calls.every(call => call[1] !== 'release' && !call.includes('POST') && !call.includes('PATCH')));
  }
});
test('incomplete or mismatched uploads remain drafts and are never published', () => {
  for (const overrides of [{ asset: { digest: 'sha256:wrong' } }, { asset: { size: 22 } },
    { asset: { state: 'new' } }, { release: { assets: [] } }, { release: { target_commitish: 'c'.repeat(40) } },
    { release: { id: 124 } }, { release: { prerelease: false } }, { id: 0 }]) {
    const g = github(overrides);
    assert.throws(() => publishVerifiedRelease(plan, '/release', '/notes.md', g.invoke));
    assert.ok(g.calls.every(call => !call.includes('PATCH')));
  }
});
