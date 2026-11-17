#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only prose and its catalog may omit native compilation/API source inventory.
// New paths, fixtures, submodule pointers and CI/build configuration run fully.
export function isDocumentationOnly(paths) {
  return paths.length > 0 && paths.every(path =>
    /^(?:README|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)(?:\.en)?\.md$/.test(path)
    || /^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(path)
    || path === 'documentation.json');
}

export function planChecks({ event, base, head, cwd = process.cwd() }) {
  const full = reason => ({ code: true, reason });
  if (!['pull_request', 'push'].includes(event)) return full('Manual or unknown event: full coverage');
  const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);
  if (!sha(base) || !sha(head)) return full('Missing comparison revision: full coverage');
  let paths;
  try {
    // No rename detection: moving code into docs also reports the old code path.
    // NUL separators preserve spaces, quotes and newlines in Git path names.
    paths = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head, '--'],
      { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\0').filter(Boolean);
  } catch {
    return full('Comparison unavailable: full coverage');
  }
  const code = !isDocumentationOnly(paths);
  return { code, reason: code ? 'Code, unknown paths or empty diff: full coverage' : 'Only documentation changed', files: paths.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const plan = planChecks({ event: process.env.CI_EVENT_NAME, base: process.env.CI_BASE_SHA, head: process.env.CI_HEAD_SHA });
  console.log(JSON.stringify(plan));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `code=${plan.code}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `${plan.reason}. Native/API inventory checks: **${plan.code ? 'full' : 'omitted'}**. Source policy, SDK contracts, documentation and security still run.\n`);
}
