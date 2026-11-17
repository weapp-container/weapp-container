import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { metadataFindings, reviewSecretFindings } from './scan-public-source.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');

test('a reviewed test value never permits a replacement or another file', () => {
  const policy = { allowedSecrets: [{ path: 'test.mjs', rule: 'generic-api-key', sha256: sha('authored-fixture'), reason: 'authored test value' }] };
  const finding = { File: 'test.mjs', RuleID: 'generic-api-key', Secret: 'authored-fixture', Match: 'private context', StartLine: 1 };
  assert.equal(reviewSecretFindings([finding], policy)[0].status, 'reviewed-fixture');
  assert.equal(reviewSecretFindings([{ ...finding, Secret: 'new-private-value' }], policy)[0].status, 'unreviewed');
  assert.equal(reviewSecretFindings([{ ...finding, File: 'production.mjs' }], policy)[0].status, 'unreviewed');
  assert.ok(!JSON.stringify(reviewSecretFindings([finding], policy)).includes('authored-fixture'));
  assert.ok(!JSON.stringify(reviewSecretFindings([finding], policy)).includes('private context'));
});

test('home routes are not private user paths and changed paths require review', () => {
  assert.deepEqual(metadataFindings('app.json', Buffer.from('pages/home/index'), {}), []);
  const path = '/Users/fixture/project';
  const policy = { allowedLocalPaths: [{ path: 'fixture.json', sha256: sha(path), reason: 'anonymized fixture' }] };
  assert.equal(metadataFindings('fixture.json', Buffer.from(JSON.stringify(path)), policy)[0].status, 'reviewed-fixture');
  const report = metadataFindings('fixture.json', Buffer.from(JSON.stringify('/Users/another-person/project')), policy);
  assert.equal(report[0].status, 'unreviewed');
  assert.ok(!JSON.stringify(report).includes('another-person'));
});
