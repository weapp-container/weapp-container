import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const policy = JSON.parse(readFileSync(new URL('../policy.json', import.meta.url)));
import { publishVerifiedRelease, publicationOptions } from '../tools/publish.mjs';

const plan = { repository: 'weapp-container/weapp-container', tag: `runtime-v${policy.runtimeVersion}`,
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
    if (overrides.uploadFailure && args[0] === 'release') throw Error('Interrupted upload');
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
test('draft-only uploads and verifies bytes without a public publication request', () => {
  const g = github();
  const result = publishVerifiedRelease(plan, '/release', '/notes.md', g.invoke, { draftOnly: true });
  assert.equal(result.status, 'draft');
  assert.equal(result.releaseId, 123);
  assert.ok(g.calls.some(call => call.includes('POST') && call.includes('draft=true')));
  assert.ok(g.calls.every(call => !call.includes('PATCH') && !call.includes('draft=false') && !call.includes('--clobber')));
});
test('interrupted uploads retain a draft and never publish or overwrite', () => {
  const g = github({ uploadFailure: true });
  assert.throws(() => publishVerifiedRelease(plan, '/release', '/notes.md', g.invoke, { draftOnly: true }), /Interrupted/);
  assert.ok(g.calls.every(call => !call.includes('PATCH') && !call.includes('--clobber')));
});
test('publication CLI remains local by default and draft creation requires explicit execution', () => {
  const paths = ['--release-dir', '/release', '--notes-file', '/notes.md'];
  assert.equal(publicationOptions(paths).execute, false);
  assert.equal(publicationOptions([...paths, '--execute']).draftOnly, false);
  assert.equal(publicationOptions([...paths, '--execute', '--draft-only']).draftOnly, true);
  assert.throws(() => publicationOptions([...paths, '--draft-only']), /requires explicit/);
  assert.throws(() => publicationOptions([...paths, '--execute', '--execute']));
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
