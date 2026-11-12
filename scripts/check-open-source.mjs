#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function sourceFinding(path, bytes) {
  if (/(?:^|\/)(?:\.gradle|\.hvigor|\.DS_Store|local\.properties|\.env(?:\..*)?)(?:\/|$)/.test(path) && !path.endsWith('.env.example')) return 'local state or credential file';
  if (/\.(?:p12|pfx|jks|keystore|mobileprovision)$/i.test(path)) return 'private signing material';
  if (/^docs\/(?:.*\/)?(?:evidence|[^/]+-evidence|sdk-migration|history)\//.test(path)) return 'private historical archive';
  if (bytes.length > 10 * 1024 * 1024) return 'source file exceeds 10 MiB; store release assets separately';
  if (bytes.includes(Buffer.from('-----BEGIN ' + 'PRIVATE KEY-----')) || /-----BEGIN (?:RSA|EC|OPENSSH) PRIVATE KEY-----/.test(bytes.toString('utf8'))) return 'private key';
  return null;
}

export function auditSourceTree(root) {
  const findings = [];
  const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean))];
  let checked = 0;
  for (const path of files) {
    const file = resolve(root, path);
    let info;
    try { info = lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') continue; // Deleted tracked files.
      throw error;
    }
    if (info.isSymbolicLink()) {
      let target;
      try { target = relative(root, realpathSync(file)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        findings.push({ path, reason: 'broken symlink' });
        continue;
      }
      if (target === '..' || target.startsWith('../') || target.startsWith('..\\')) findings.push({ path, reason: 'symlink escapes source tree' });
      continue;
    }
    if (!info.isFile()) continue; // Gitlinks are audited in their own repositories.
    checked++;
    const reason = sourceFinding(path, readFileSync(file));
    if (reason) findings.push({ path, reason });
  }
  for (const path of ['LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md']) if (!existsSync(resolve(root, path))) findings.push({ path, reason: 'missing project policy' });
  if (existsSync(resolve(root, 'LICENSE-PROPRIETARY'))) findings.push({ path: 'LICENSE-PROPRIETARY', reason: 'obsolete current-source license' });
  const modules = resolve(root, '.gitmodules');
  if (existsSync(modules) && [...readFileSync(modules, 'utf8').matchAll(/^\s*url\s*=\s*(\S+)/gm)].some(match => !match[1].startsWith('https://github.com/'))) findings.push({ path: '.gitmodules', reason: 'submodule URL requires HTTPS' });
  return { checked, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = auditSourceTree(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 1;
}
