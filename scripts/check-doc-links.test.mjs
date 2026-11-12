import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkDocument, documentLinks } from './check-doc-links.mjs';

test('checks relative and reference links while ignoring fenced examples and remote URLs', t => {
  const root = mkdtempSync(join(tmpdir(), 'doc-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs')); writeFileSync(join(root, 'a b.md'), 'ok');
  writeFileSync(join(root, 'docs/index.md'), '[ok](../a%20b.md#part)\n[remote](https://example.invalid/x)\n[ref][guide]\n[guide]: ./missing.md\n```md\n[example](./not-a-link.md)\n```\n');
  assert.deepEqual(checkDocument(root, 'docs/index.md'), [{ path: 'docs/index.md', link: './missing.md', reason: 'missing local target' }]);
  assert.deepEqual(documentLinks('[angle](<a b.md>)'), ['a b.md']);
});
