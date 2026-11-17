#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkDocumentation, digest, links, headingIds} from './check.mjs';
import {checkContent} from './check-content.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repositories = ['.', 'sdk/android', 'sdk/ios', 'sdk/desktop', 'sdk/flutter', 'sdk/react-native', 'sdk/contract', 'website'];
const args = process.argv.slice(2);
assert.ok(!args.length || args.length === 2 && args[0] === '--organization-root', 'Usage: check-workspace.mjs [--organization-root /organization]');
if (args.length) repositories.push(resolve(args[1]));
const reports = repositories.map(repository => {
  const folder = resolve(root, repository);
  assert.ok(existsSync(resolve(folder, 'documentation.json')), `Initialize the pinned ${repository} checkout`);
  if (repository !== '.') for (const file of ['check.mjs', 'check.test.mjs', 'check-content.mjs', 'check-content.test.mjs', 'review.mjs']) {
    assert.equal(digest(readFileSync(resolve(folder, 'tools/documentation', file))), digest(readFileSync(resolve(root, 'tools/documentation', file))), `Shared documentation tool ${file} differs in ${repository}`);
  }
  const report = checkDocumentation(folder);
  report.findings.push(...checkContent(folder).findings);
  return report;
});
const catalogs = repositories.map(repository => ({folder: resolve(root, repository), catalog: JSON.parse(readFileSync(resolve(root, repository, 'documentation.json'), 'utf8'))}));
const crossRepositoryFindings = [];
for (const {folder, catalog} of catalogs) for (const page of catalog.pages) for (const [locale, file] of [['zh-CN', page.zh], ['en', page.en]]) {
  if (!existsSync(resolve(folder, file))) continue; // The local catalog report records missing counterparts.
  for (const link of links(readFileSync(resolve(folder, file), 'utf8'))) {
    const match = link.match(/^https:\/\/github\.com\/(weapp-container\/[^/]+)\/blob\/(?:main|master)\/([^#?]+)(?:#([^?]+))?$/);
    if (!match) continue;
    const target = catalogs.find(item => item.catalog.repository === match[1]);
    if (!target) continue;
    const path = decodeURIComponent(match[2]), fullPath = resolve(target.folder, path);
    const fail = reason => crossRepositoryFindings.push({repository: catalog.repository, path: file, link, reason});
    if (!existsSync(fullPath)) {fail('Missing cross-repository target'); continue;}
    if (match[3] && path.endsWith('.md') && !headingIds(readFileSync(fullPath, 'utf8')).has(decodeURIComponent(match[3]))) fail('Missing cross-repository section');
    if (locale === 'en' && target.catalog.pages.some(item => item.zh === path)) fail('English link points to a Chinese cross-repository page');
    if (locale === 'zh-CN' && target.catalog.pages.some(item => item.en === path)) fail('Chinese link points to an English cross-repository page');
  }
}
console.log(JSON.stringify({repositories: reports.length, pages: reports.reduce((n, report) => n + report.pages, 0), reports, crossRepositoryFindings}, null, 2));
if (crossRepositoryFindings.length || reports.some(report => report.findings.length)) process.exitCode = 1;
