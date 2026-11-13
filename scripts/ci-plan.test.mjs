import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { isDocumentationOnly, planChecks } from './ci-plan.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-plan-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  git('init', '-q');
  git('config', 'user.name', 'CI plan test');
  git('config', 'user.email', 'ci-plan@example.invalid');
  write('README.md', 'original documentation');
  write('crates/runtime.rs', 'original code');
  const base = commit();
  return { cwd, base, git, write, commit, plan: (head, event = 'push', before = base) => planChecks({ cwd, event, base: before, head }) };
}

test('only a nonempty, explicit prose allowlist can omit compilation', () => {
  assert.equal(isDocumentationOnly(['README.md', 'CONTRIBUTING.en.md', 'docs/host-services/source-review.md', 'documentation.json']), true);
  for (const path of ['Cargo.lock', '.github/workflows/public-ci.yml', 'scripts/ci-plan.mjs', 'sdk/contract', 'website', 'docs/fixture.json', 'crates/README.md', 'unknown.md', 'docs/code.rs']) {
    assert.equal(isDocumentationOnly(['README.md', path]), false, path);
  }
  assert.equal(isDocumentationOnly([]), false);
});

test('manual/unknown events, missing history and invalid revisions always run fully', t => {
  const f = fixture(t);
  f.write('README.md', 'new documentation');
  const head = f.commit();
  for (const event of ['workflow_dispatch', 'merge_group', '', undefined]) assert.equal(planChecks({ cwd: f.cwd, event, base: f.base, head }).code, true);
  for (const base of [undefined, '', '0'.repeat(40), 'f'.repeat(40), '--output=unsafe']) assert.equal(planChecks({ cwd: f.cwd, event: 'push', base, head }).code, true);
  assert.equal(planChecks({ cwd: f.cwd, event: 'push', base: f.base, head: '' }).code, true);
  assert.equal(f.plan(f.base).code, true, 'an empty diff is conservative');
});

test('push planning uses every commit in the push, including earlier code edits', t => {
  const f = fixture(t);
  f.write('crates/runtime.rs', 'changed code'); f.commit();
  f.write('README.md', 'last commit only touches documentation');
  const head = f.commit();
  assert.equal(f.plan(head).code, true);
});

test('PR planning compares the tested merge with the base revision', t => {
  const f = fixture(t);
  f.git('checkout', '-qb', 'topic');
  f.write('README.md', 'topic documentation'); f.commit();
  f.git('checkout', '-qb', 'base', f.base);
  f.write('crates/runtime.rs', 'unrelated base branch code');
  const base = f.commit();
  f.git('merge', '--no-ff', '-qm', 'test merge', 'topic');
  assert.equal(f.plan(f.git('rev-parse', 'HEAD'), 'pull_request', base).code, false);
});

test('moving code into a documentation path cannot hide its deletion', t => {
  const f = fixture(t);
  mkdirSync(join(f.cwd, 'docs'));
  renameSync(join(f.cwd, 'crates/runtime.rs'), join(f.cwd, 'docs/runtime.md'));
  assert.equal(f.plan(f.commit()).code, true);
});

test('deleted code runs fully; prose additions, edits and deletions use the fast path', t => {
  const f = fixture(t);
  f.write('docs/guide.en.md', 'English guide');
  f.write('docs/guide.md', 'Chinese guide');
  rmSync(join(f.cwd, 'README.md'));
  const docs = f.commit();
  assert.deepEqual(f.plan(docs), { code: false, reason: 'Only documentation changed', files: 3 });
  rmSync(join(f.cwd, 'crates/runtime.rs'));
  assert.equal(f.plan(f.commit(), 'push', docs).code, true);
});

test('Git path separators do not split code paths containing newlines or spaces', t => {
  const f = fixture(t);
  f.write('crates/code with\nREADME.md', 'code');
  assert.equal(f.plan(f.commit()).code, true);
});
