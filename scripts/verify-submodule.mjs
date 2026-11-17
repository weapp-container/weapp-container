#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Verify the index so a staged gitlink update can be checked before committing.
export function verifySubmodules(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  const links = git(['ls-files', '--stage', '-z']).split('\0').filter(row => row.startsWith('160000 '));
  const findings = [];
  const verified = [];
  const modules = resolve(root, '.gitmodules');
  const configured = new Map();
  if (existsSync(modules)) {
    const entries = git(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']);
    for (const entry of entries.split('\n').filter(Boolean)) {
      const split = entry.indexOf(' ');
      const key = entry.slice(0, split).replace(/\.path$/, '.url');
      configured.set(entry.slice(split + 1), git(['config', '-f', '.gitmodules', '--get', key]));
    }
  }
  for (const row of links) {
    const [metadata, path] = row.split('\t');
    const [, pinned, stage] = metadata.split(' ');
    if (stage !== '0') { findings.push({ path, reason: 'unresolved gitlink' }); continue; }
    if (!configured.get(path)?.startsWith('https://github.com/')) findings.push({ path, reason: 'missing HTTPS submodule URL' });
    if (!existsSync(resolve(root, path, '.git'))) { findings.push({ path, reason: 'not initialized; run git submodule update --init --recursive' }); continue; }
    const actual = git(['-C', path, 'rev-parse', 'HEAD']);
    if (actual !== pinned) findings.push({ path, reason: `commit mismatch: index=${pinned} checkout=${actual}` });
    else verified.push({ path, commit: actual });
  }
  for (const path of configured.keys()) if (!links.some(row => row.endsWith(`\t${path}`))) findings.push({ path, reason: 'configured submodule has no gitlink' });
  return { verified, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = verifySubmodules(resolve(fileURLToPath(new URL('..', import.meta.url))));
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 1;
}
