#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function documentLinks(text) {
  const prose = text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '');
  const links = [...prose.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+[^)]*)?\)/g)].map(match => match[1]);
  links.push(...[...prose.matchAll(/^\s*\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm)].map(match => match[1]));
  return links.map(link => link.replace(/^<|>$/g, ''));
}

export function checkDocument(root, path) {
  const findings = [];
  for (const link of documentLinks(readFileSync(resolve(root, path), 'utf8'))) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(link)) continue;
    let target;
    try { target = decodeURIComponent(link.split(/[?#]/, 1)[0]); }
    catch { findings.push({ path, link, reason: 'invalid URL encoding' }); continue; }
    if (target && !existsSync(resolve(root, dirname(path), target))) findings.push({ path, link, reason: 'missing local target' });
  }
  return findings;
}

export function checkDocs(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0');
  const docs = [...new Set(files)].filter(path => path.endsWith('.md') && !path.startsWith('conformance/recipes/template-format-dependencies/') && existsSync(resolve(root, path)));
  return { checked: docs.length, findings: docs.flatMap(path => checkDocument(root, path)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkDocs(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 1;
}
